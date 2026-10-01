// Theme: light is the default look; a user can switch to dark from
// Settings → Dark Mode. Persisted per-browser (localStorage) and applied
// immediately on load, before anything else renders, so there's no flash
// of the wrong theme.
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}
function getStoredTheme() {
  try { return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
}
function setStoredTheme(theme) {
  try { localStorage.setItem('theme', theme); } catch (e) {}
  applyTheme(theme);
}
applyTheme(getStoredTheme());

// PWA install: register the service worker so the app shell loads instantly
// and the browser offers "Add to Home Screen" / "Install app". Registered
// after load so it never competes with the initial page render, and it's
// safe to no-op in browsers/contexts without service worker support.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let currentUser = null;
let socket = null;
let currentRoomId = null;
let currentRoomName = null;
let currentRoomSilencedUntil = null; // epoch ms while the current room is silenced (/silence), else null
let allRoomsCache = [];
let lastRoomMembers = [];
let emailsCurrentThreadUser = null;
let openRoomTabs = []; // [{id, name}] quick-switch pills for rooms visited this session

// In-memory, this-session-only cache of what the #messages pane looked like
// for a room the moment you switched AWAY from it. Chat text is only ever
// visible from the moment you enter a room (see enterRoom below) — but with
// several room tabs open at once, switching between rooms you're already in
// must show what's actually still happening in each one, not wipe it back to
// blank every time you flip tabs. Only a genuine Leave Room (or a kick/bump/
// idle-timeout removal) deletes a room's entry here, so the NEXT real entry
// into that room starts blank again, exactly as intended.
const roomMessageCache = new Map(); // roomId -> #messages innerHTML snapshot

// Desktop-only "show every open room at once" panels (see renderSecondaryPanels
// below): every tab in openRoomTabs OTHER than currentRoomId gets a small
// always-visible floating panel alongside the primary #chatScreen window,
// instead of only being reachable by clicking its tab. roomId -> its <div>.
const secondaryPanelEls = new Map();
// roomId -> Set of message ids already rendered into that room's secondary
// panel — mirrors seenMsgIds, but kept separately per room since a secondary
// panel's content is independent of whichever room is currently primary.
const secondaryMsgSeen = new Map();

// The "managed by / welcome / currently in this room" banner is useful the
// moment you walk into a room, but once people are actively chatting it just
// pushes the conversation down and stays there forever if left alone. So it
// disappears automatically once a few messages have gone by — no tap, no way
// to pin it back open — and comes back fresh the next time the room is
// (re-)entered, via the reset in enterRoom.
const ROOM_BANNER_COLLAPSE_AFTER = 6;
const roomBannerCollapsed = new Map(); // roomId -> bool (true once auto-hidden)
const roomBannerMsgCount = new Map(); // roomId -> number of messages seen since entering

// The current site-wide announcement (Staff/Global Admin "/announcement"
// command), or null when none is active — kept in sync by the 'announcement'
// socket event (both the live broadcast and the replay on room join) and
// rendered as the pinned #announcementBanner inside the chat screen. See
// renderAnnouncementBanner() and showBroadcastBanner() below.
let currentAnnouncement = null;

// Persisted chat messages (chat/gift/voucher — anything with a real DB id)
// can arrive twice around a room entry: once live over the socket, once in
// the join_room ack's history backlog, if the timing lands just right. Every
// rendered message with an id is tagged data-msg-id so a duplicate is
// skipped instead of shown twice. Reset whenever #messages is rebuilt for a
// (re-)entered room — see enterRoom.
let seenMsgIds = new Set();
function collectMsgIds(container) {
  container.querySelectorAll('[data-msg-id]').forEach((el) => seenMsgIds.add(el.dataset.msgId));
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Chat text can contain simple **bold** markdown (a couple of roleplay/
// special commands lean on it for emphasis) — escape first (so this never
// opens an HTML injection route), then turn any **pair** into real <strong>
// so it renders bold instead of showing the literal asterisks.
function escapeChatText(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Fixed country catalog for My Profile / Admin Panel — name + flag emoji.
// A normal user picks from this list exactly once (POST /auth/country);
// Staff can change anyone's pick at any time (POST /admin/users/:id/set-country).
const COUNTRIES = [
  ['🇸🇩', 'Sudan'],
  ['🇺🇸', 'United States'], ['🇨🇦', 'Canada'], ['🇲🇽', 'Mexico'], ['🇧🇷', 'Brazil'], ['🇦🇷', 'Argentina'],
  ['🇬🇧', 'United Kingdom'], ['🇮🇪', 'Ireland'], ['🇫🇷', 'France'], ['🇩🇪', 'Germany'], ['🇪🇸', 'Spain'],
  ['🇵🇹', 'Portugal'], ['🇮🇹', 'Italy'], ['🇳🇱', 'Netherlands'], ['🇧🇪', 'Belgium'], ['🇨🇭', 'Switzerland'],
  ['🇦🇹', 'Austria'], ['🇸🇪', 'Sweden'], ['🇳🇴', 'Norway'], ['🇩🇰', 'Denmark'], ['🇫🇮', 'Finland'],
  ['🇵🇱', 'Poland'], ['🇬🇷', 'Greece'], ['🇷🇺', 'Russia'], ['🇺🇦', 'Ukraine'], ['🇹🇷', 'Turkey'],
  ['🇪🇬', 'Egypt'], ['🇿🇦', 'South Africa'], ['🇳🇬', 'Nigeria'], ['🇰🇪', 'Kenya'], ['🇲🇦', 'Morocco'],
  ['🇸🇦', 'Saudi Arabia'], ['🇦🇪', 'United Arab Emirates'], ['🇶🇦', 'Qatar'], ['🇰🇼', 'Kuwait'], ['🇯🇴', 'Jordan'],
  ['🇱🇧', 'Lebanon'], ['🇮🇱', 'Israel'], ['🇮🇶', 'Iraq'], ['🇮🇷', 'Iran'], ['🇵🇰', 'Pakistan'],
  ['🇮🇳', 'India'], ['🇧🇩', 'Bangladesh'], ['🇱🇰', 'Sri Lanka'], ['🇳🇵', 'Nepal'], ['🇨🇳', 'China'],
  ['🇯🇵', 'Japan'], ['🇰🇷', 'South Korea'], ['🇹🇼', 'Taiwan'], ['🇭🇰', 'Hong Kong'], ['🇵🇭', 'Philippines'],
  ['🇻🇳', 'Vietnam'], ['🇹🇭', 'Thailand'], ['🇲🇾', 'Malaysia'], ['🇸🇬', 'Singapore'], ['🇮🇩', 'Indonesia'],
  ['🇦🇺', 'Australia'], ['🇳🇿', 'New Zealand'], ['🇨🇱', 'Chile'], ['🇨🇴', 'Colombia'], ['🇵🇪', 'Peru'],
  ['🇻🇪', 'Venezuela'], ['🇪🇨', 'Ecuador'], ['🇺🇾', 'Uruguay'], ['🇵🇾', 'Paraguay'], ['🇧🇴', 'Bolivia'],
  ['🇨🇺', 'Cuba'], ['🇩🇴', 'Dominican Republic'], ['🇯🇲', 'Jamaica'], ['🇹🇹', 'Trinidad and Tobago'], ['🇨🇿', 'Czech Republic'],
  ['🇸🇰', 'Slovakia'], ['🇭🇺', 'Hungary'], ['🇷🇴', 'Romania'], ['🇧🇬', 'Bulgaria'], ['🇭🇷', 'Croatia'],
  ['🇷🇸', 'Serbia'], ['🇮🇸', 'Iceland'], ['🇱🇺', 'Luxembourg'], ['🇲🇹', 'Malta'], ['🇨🇾', 'Cyprus'],
  ['🇬🇭', 'Ghana'], ['🇪🇹', 'Ethiopia'], ['🇹🇿', 'Tanzania'], ['🇺🇬', 'Uganda'], ['🇩🇿', 'Algeria'],
  ['🇹🇳', 'Tunisia'], ['🇱🇾', 'Libya'], ['🇰🇿', 'Kazakhstan'], ['🇦🇿', 'Azerbaijan'], ['🇬🇪', 'Georgia'],
  ['🇦🇲', 'Armenia'], ['🇴🇲', 'Oman'], ['🇧🇭', 'Bahrain'], ['🇾🇪', 'Yemen'], ['🇸🇾', 'Syria'],
  ['🏳️', 'Other / Prefer not to specify'],
];
function countryFlag(name) {
  const hit = COUNTRIES.find((c) => c[1] === name);
  return hit ? hit[0] : '🌐';
}

// Deterministic color from a string, for colored-initial avatars.
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e'];
function colorFor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function paintAvatar(el, name) {
  el.textContent = (name || '?').trim().charAt(0).toUpperCase();
  el.style.background = colorFor(name || '?');
}

// Big "frame + scene + pet" avatar preview — shared by Avatar Maker, My
// Profile, and any other user's public profile (same markup everywhere).
// The chosen Scene renders as a full backdrop filling the circle instead of
// a small floating badge; the chosen Pet takes over the circle's center
// instead of a small floating badge, replacing the username-initial letter
// (the letter is only shown when no pet is set).
function avatarPreviewHtml(u) {
  const initial = escapeHtml((u.username || '?').charAt(0).toUpperCase());
  const centerContent = u.avatar_pet ? u.avatar_pet : initial;
  return `
    <div class="avatar-maker-preview" style="border-color:${u.avatar_frame_color || '#3b82f6'}">
      <div class="avatar-circle" style="background:${colorFor(u.username)}">
        ${u.avatar_scene ? `<div class="avatar-circle-scene-bg">${u.avatar_scene}</div>` : ''}
        <span class="avatar-circle-center">${centerContent}</span>
      </div>
    </div>
  `;
}

// ---------- AUTH ----------
// Four views sharing #authScreen: Login, Create Account, Forgot Code, and
// Activate Account (an informational screen — this build has no email
// server, so accounts are active the moment Create Account succeeds; there's
// nothing to actually activate).
const AUTH_VIEWS = ['authLoginView', 'authRegisterView', 'authForgotView', 'authActivateView'];
function showAuthView(id) {
  AUTH_VIEWS.forEach((v) => $('#' + v).classList.toggle('hidden', v !== id));
  $('#loginError').textContent = '';
  $('#registerError').textContent = '';
  $('#forgotError').textContent = '';
  $('#forgotSuccess').textContent = '';
}
$('#authGoRegister').addEventListener('click', (e) => { e.preventDefault(); showAuthView('authRegisterView'); });
$('#authGoLoginFromRegister').addEventListener('click', (e) => { e.preventDefault(); showAuthView('authLoginView'); });
$('#registerBackBtn').addEventListener('click', () => showAuthView('authLoginView'));
$('#authGoForgot').addEventListener('click', (e) => { e.preventDefault(); showAuthView('authForgotView'); });
$('#authGoLoginFromForgot').addEventListener('click', (e) => { e.preventDefault(); showAuthView('authLoginView'); });
$('#forgotBackBtn').addEventListener('click', () => showAuthView('authLoginView'));
$('#authGoActivate').addEventListener('click', (e) => { e.preventDefault(); showAuthView('authActivateView'); });
$('#activateBackBtn').addEventListener('click', () => showAuthView('authLoginView'));
$('#activateGoLoginBtn').addEventListener('click', () => showAuthView('authLoginView'));
$$('.auth-terms-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    toast('MiniPlatform Terms of Use (EULA): zero tolerance for objectionable content or abusive users.');
  });
});

// Password show/hide toggle, shared by every Secret/Confirm Code field.
$$('.auth-eye-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.querySelector('.eye-on').classList.toggle('hidden', !showing);
    btn.querySelector('.eye-off').classList.toggle('hidden', showing);
  });
});

// Gender toggle (Create Account) — Male is selected by default, matching the form.
let selectedGender = 'male';
$$('.gender-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedGender = btn.dataset.gender;
    $$('.gender-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// Country dropdown (Create Account) reuses the same fixed catalog as the
// My Profile / Admin Panel country pickers, so the list stays in sync everywhere.
(function populateRegisterCountry() {
  const select = $('#regCountry');
  COUNTRIES.forEach(([flag, name]) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${flag} ${name}`;
    select.appendChild(opt);
  });
})();

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  const remember = $('#loginRemember').checked;
  $('#loginError').textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember }) });
    // A real login submission — never auto-open the last room or replay its
    // chat, even for the same person signing back in (and even if they're
    // Staff/Global Admin). Only a same-session page refresh (see the
    // bootstrap init() call below) restores that silently.
    onLoggedIn(data.user, { restoreRoom: false });
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#regUsername').value.trim();
  const email = $('#regEmail').value.trim();
  const password = $('#regPassword').value;
  const confirmPassword = $('#regConfirmPassword').value;
  const country = $('#regCountry').value;
  const referrerUsername = $('#regReferrer').value.trim();
  const agreedTerms = $('#regAgreeTerms').checked;
  $('#registerError').textContent = '';

  if (password !== confirmPassword) { $('#registerError').textContent = "Secret Code and Confirm Code don't match"; return; }
  if (!country) { $('#registerError').textContent = 'Please choose a country'; return; }
  if (!agreedTerms) { $('#registerError').textContent = 'You must agree to the Terms of Use (EULA) to continue'; return; }

  try {
    const data = await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, confirmPassword, gender: selectedGender, country, referrerUsername, agreedTerms }),
    });
    onLoggedIn(data.user, { restoreRoom: false });
  } catch (err) {
    $('#registerError').textContent = err.message;
  }
});

$('#forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#forgotUsername').value.trim();
  const email = $('#forgotEmail').value.trim();
  const newPassword = $('#forgotNewPassword').value;
  const confirmPassword = $('#forgotConfirmPassword').value;
  $('#forgotError').textContent = '';
  $('#forgotSuccess').textContent = '';

  if (newPassword !== confirmPassword) { $('#forgotError').textContent = "New Secret Code and Confirm Code don't match"; return; }

  try {
    await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ username, email, newPassword }) });
    $('#forgotSuccess').textContent = 'Secret Code reset — you can log in with it now.';
    $('#forgotForm').reset();
    setTimeout(() => showAuthView('authLoginView'), 1200);
  } catch (err) {
    $('#forgotError').textContent = err.message;
  }
});

async function doLogout() {
  await api('/auth/logout', { method: 'POST' });
  clearSavedRoom();
  location.reload();
}
$('#logoutBtnTop').addEventListener('click', doLogout);
$('#drawerLogout').addEventListener('click', doLogout);

// restoreRoom distinguishes a real page refresh (still the same signed-in
// session — safe to silently land back in whatever room was open) from an
// actual login/register submission (a fresh sign-in, even by the same
// person, should never auto-open a room or replay old chat — see the
// Recent Rooms / previous-chat-on-login fix below). Defaults to true so the
// bootstrap session-restore call below doesn't need to say so explicitly.
function onLoggedIn(user, { restoreRoom = true } = {}) {
  currentUser = user;
  $('#authScreen').classList.add('hidden');
  $('#appScreen').classList.remove('hidden');
  updateUserBar();
  connectSocket();
  loadGifts();
  refreshBadgeCounts();
  // Populates the desktop right sidebar's room lists (see #rightSidebar)
  // right away — it's persistent across screens, unlike the Rooms screen
  // it mirrors, so it shouldn't wait for the user to open Rooms first.
  refreshRooms();

  const saved = restoreRoom ? readSavedRoom() : null;
  if (!restoreRoom) clearSavedRoom();

  if (saved && saved.id) {
    // Room membership is persistent server-side (a refresh never removes
    // you from a room) — mirror that in the UI by landing back in the last
    // room you had open instead of dumping you out to the Home screen.
    enterRoom(saved.id, saved.name);
  } else {
    showScreen('home');
    refreshHome();
  }
}

// A global admin is shown solid yellow; staff (without global admin) gets the
// mixed green/blue/red gradient; a plain user gets no special class.
// Color priority: Staff always wins (its gradient can't be bought over). For
// every other role, a purchased Color Shop color now outranks the role
// color — buying one shows YOUR color instead of the role's, while the role
// badge/icon (see roleIcon() below) still shows so permission level stays
// visible. With no purchased color, the role priority is Executive Board,
// Global Admin, Country Representative, Elite User, Mentor, Merchant.
function roleClass(u) {
  if (u.is_staff) return 'role-staff';
  if (u.username_color) return '';
  if (u.is_exec_board) return 'role-exec-board';
  if (u.is_global_admin) return 'role-global-admin';
  if (u.is_moderator) return 'role-moderator';
  if (u.is_country_rep) return 'role-country-rep';
  if (u.is_elite) return 'role-elite';
  if (u.is_mentor) return 'role-mentor';
  if (u.is_merchant) return 'role-merchant';
  return '';
}

function roleIcon(u) {
  if (u.is_staff) return ' 👑';
  if (u.is_exec_board) return ' 🎖️';
  if (u.is_global_admin) return ' 🛡️';
  if (u.is_moderator) return ' 🔰';
  if (u.is_country_rep) return ' 🌐';
  if (u.is_elite) return ' 🏅';
  if (u.is_mentor) return ' 🧭';
  if (u.is_merchant) return ' 💼';
  return '';
}

// Inline style="" for a rendered username, in priority order:
// 1) A Staff member's own custom multi-color gradient (username_gradient —
//    5 to 8 hex colors picked in Settings -> Color Shop -> Staff Gradient),
//    which overrides the default 3-color green/blue/red .role-staff CSS
//    gradient with their personal mix.
// 2) A plain user's purchased Color Shop color — only applies when no role
//    color/gradient is in play (a role always communicates permission level
//    first, same priority rule as roleClass() above).
function usernameStyleAttr(u) {
  if (u.is_staff && u.username_gradient) {
    let colors = null;
    try { colors = JSON.parse(u.username_gradient); } catch (e) { /* ignore malformed value */ }
    if (Array.isArray(colors) && colors.length >= 2) {
      const stops = colors.map((c) => escapeHtml(c)).join(', ');
      return ` style="background-image:linear-gradient(90deg, ${stops});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;"`;
    }
  }
  if (!roleClass(u) && u.username_color) {
    return ` style="color:${escapeHtml(u.username_color)}"`;
  }
  return '';
}

// Same priority logic as usernameStyleAttr(), but for the handful of spots
// (Home profile card, nav drawer) that set an element's name via
// .textContent instead of building an innerHTML string — those never picked
// up the inline gradient/color style, so the username showed correctly
// colored everywhere it was rendered via usernameHtml() (chat, lists,
// leaderboards) but plain on Home/drawer. Call this right after setting
// .textContent/.className on the element.
function applyUsernameStyle(el, u) {
  if (!el) return;
  const raw = usernameStyleAttr(u); // '' or ' style="...;"'
  const match = raw.match(/style="([^"]*)"/);
  if (match) el.setAttribute('style', match[1]);
  else el.removeAttribute('style');
}

// For screens (Members, Leaderboards) that render a username from scratch:
// roleClass() already resolves the Staff-only-exception priority above, so
// this just applies whichever wins — the role badge/icon always shows
// regardless, since it's a separate permission indicator from the color.
// Maps a 4-state presence value ('online' | 'away' | 'busy' | 'offline') to
// the .status-dot modifier class — '' (plain green) for 'online'.
function statusDotClass(status) {
  return status === 'offline' || status === 'away' || status === 'busy' || status === 'invisible' ? status : '';
}
const STATUS_LABELS = { online: 'Online', away: 'Away', busy: 'Busy', invisible: 'Going Invisible' };

// ---------- LEVEL SCREEN (tap the ⚡ level badge on Home) ----------
const LEVEL_TIERS = [
  { min: 1, max: 9, name: 'Newcomer' },
  { min: 10, max: 19, name: 'Rookie' },
  { min: 20, max: 34, name: 'Skilled' },
  { min: 35, max: 49, name: 'Expert' },
  { min: 50, max: 74, name: 'Master' },
  { min: 75, max: 99, name: 'Elite' },
  { min: 100, max: 149, name: 'Legend' },
  { min: 150, max: 199, name: 'Mythic' },
  { min: 200, max: Infinity, name: 'Immortal' },
];
function tierForLevel(level) {
  return LEVEL_TIERS.find((t) => level >= t.min && level <= t.max) || LEVEL_TIERS[LEVEL_TIERS.length - 1];
}

const LEVEL_MILESTONES = [
  { level: 10, icon: '🥉', name: 'Bronze badge' },
  { level: 20, icon: '🥈', name: 'Silver badge' },
  { level: 30, icon: '🥇', name: 'Gold badge' },
  { level: 40, icon: '🖼️', name: 'Avatar frame' },
  { level: 50, icon: '👑', name: 'VIP perks' },
  { level: 60, icon: '⭐', name: 'Legend status' },
  { level: 75, icon: '💎', name: 'Elite status' },
  { level: 100, icon: '🏆', name: 'Centurion' },
  { level: 150, icon: '🌟', name: 'Icon status' },
  { level: 200, icon: '👑', name: 'Royalty' },
  { level: 300, icon: '🛡️', name: 'Titan' },
  { level: 500, icon: '🌌', name: 'Mythic status' },
  { level: 750, icon: '⚡', name: 'Immortal' },
  { level: 1000, icon: '🏛️', name: 'Hall of Fame' },
];

// Current-level tile, an always-present "next level" tile (a themed
// milestone if the very next level happens to be one, otherwise a generic
// name-badge refresh), then up to 5 further milestones ahead.
function levelRoadmapTiles(level) {
  const tiles = [{ level, current: true }];
  const next = level + 1;
  const nextMilestone = LEVEL_MILESTONES.find((m) => m.level === next);
  if (nextMilestone) {
    tiles.push({ level: next, icon: nextMilestone.icon, name: nextMilestone.name });
  } else {
    tiles.push({ level: next, icon: '🎖️', name: 'New name badge', desc: 'A fresh badge shows next to your name' });
  }
  LEVEL_MILESTONES.filter((m) => m.level > next).slice(0, 5).forEach((m) => {
    tiles.push({ level: m.level, icon: m.icon, name: m.name });
  });
  return tiles;
}

function renderLevelScreen(box) {
  const level = currentUser.level;
  const into = currentUser.xpIntoLevel || 0;
  const need = currentUser.xpForNextLevel || 1;
  const pct = Math.max(0, Math.min(100, Math.round((into / need) * 100)));
  const tier = tierForLevel(level);
  const tiles = levelRoadmapTiles(level);
  const nextTile = tiles[1];

  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

  box.innerHTML = `
    <div class="level-ring-wrap">
      <div class="level-ring">
        <svg width="180" height="180" viewBox="0 0 180 180">
          <circle cx="90" cy="90" r="${radius}" fill="none" stroke="var(--panel-alt)" stroke-width="10" />
          <circle cx="90" cy="90" r="${radius}" fill="none" stroke="#f59e0b" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 90 90)" />
        </svg>
        <div class="level-ring-center">
          <div class="level-ring-number">${level}</div>
          <div class="level-ring-label">Level</div>
          <div class="level-tier-badge">⭐ ${escapeHtml(tier.name.toUpperCase())} TIER</div>
        </div>
      </div>
    </div>
    <div class="level-progress-row">
      <span class="level-progress-pct">${pct}%</span>
      <span style="color:var(--text-dim); font-size:13px;"> · ${100 - pct}% to go</span>
      <div class="level-progress-caption">Progress to level ${level + 1}</div>
    </div>
    <div class="level-roadmap-title">Level roadmap</div>
    <div class="level-roadmap-scroll" id="levelRoadmapScroll"></div>
    <div class="level-next-reward-card">
      <div class="level-next-reward-icon">${nextTile.icon}</div>
      <div>
        <div class="level-next-reward-title">${escapeHtml(nextTile.name)}</div>
        <div class="level-next-reward-sub">${escapeHtml(nextTile.desc || `Unlocks at level ${nextTile.level}`)}</div>
      </div>
      <div class="level-next-reward-badge">Lv ${nextTile.level}</div>
    </div>
  `;

  const scroll = box.querySelector('#levelRoadmapScroll');
  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = 'level-milestone-tile' + (t.current ? ' current' : '');
    tile.innerHTML = `
      <div class="level-milestone-number">${t.level}</div>
      <div class="level-milestone-label">${t.current ? 'Current' : 'Lv'}</div>
      <div class="level-milestone-icon">${t.current ? '📍' : t.icon}</div>
      <div class="level-milestone-name">${t.current ? 'You are here' : escapeHtml(t.name)}</div>
    `;
    scroll.appendChild(tile);
  });
}
$('#profileLevelBadge').addEventListener('click', () => pushSubScreen('Level', renderLevelScreen));

function usernameHtml(u) {
  const cls = roleClass(u);
  const style = usernameStyleAttr(u);
  if (style) return `<span class="${cls}"${style}>${escapeHtml(u.username)}</span>${roleIcon(u)}`;
  if (cls) return `<span class="${cls}">${escapeHtml(u.username)}</span>${roleIcon(u)}`;
  return escapeHtml(u.username);
}

function updateUserBar() {
  $('#coinsDisplay').textContent = `🪙 ${currentUser.coins}`;
  $('#drawerAdmin').classList.toggle('hidden', !currentUser.is_staff);
  $('#drawerGiveCoins').classList.toggle('hidden', !(currentUser.is_staff || currentUser.is_mentor || currentUser.is_merchant));
  $('#menuAdmin').classList.toggle('hidden', !currentUser.is_staff);
  $('#menuGiveCoins').classList.toggle('hidden', !(currentUser.is_staff || currentUser.is_mentor || currentUser.is_merchant));

  // Desktop account dropdown trigger (top right) — mirrors the drawer's own
  // profile card, just compact enough to sit in the topbar.
  paintAvatar($('#topbarUserAvatar'), currentUser.username);
  $('#topbarUserName').textContent = currentUser.username;

  paintAvatar($('#profileAvatar'), currentUser.username);
  $('#profileUsername').textContent = currentUser.username;
  $('#profileUsername').className = roleClass(currentUser);
  applyUsernameStyle($('#profileUsername'), currentUser);
  $('#profileLevelBadge').textContent = `⚡ ${currentUser.level}`;
  $('#profileBio').textContent = currentUser.bio || 'No bio yet.';

  // Own status dot (Home profile card): always shown as your *chosen* status
  // (never 'offline' — you can't be offline while looking at this), and
  // tappable to change it.
  const ownDot = $('#profileStatusDot');
  const ownDisplayStatus = isInvisible ? 'invisible' : currentUser.status;
  ownDot.className = 'status-dot own ' + statusDotClass(ownDisplayStatus);
  ownDot.title = `${STATUS_LABELS[ownDisplayStatus] || 'Online'} — tap to change`;

  const into = currentUser.xpIntoLevel || 0;
  const need = currentUser.xpForNextLevel || 1;
  const pct = Math.max(2, Math.min(100, Math.round((into / need) * 100)));
  $('#xpBarFill').style.width = pct + '%';

  // Nav drawer profile card
  paintAvatar($('#drawerAvatar'), currentUser.username);
  $('#drawerUsername').textContent = currentUser.username;
  $('#drawerUsername').className = 'drawer-profile-name ' + roleClass(currentUser);
  applyUsernameStyle($('#drawerUsername'), currentUser);
  $('#drawerLevel').textContent = currentUser.level;
  $('#drawerXp').textContent = currentUser.xp;
  $('#drawerCoins').textContent = currentUser.coins;
}

// Small floating menu anchored under the Home profile card's status dot —
// Online / Away / Busy / Offline (Offline is never a pickable option here:
// that's automatic, see presence.effectiveStatus) / Going Invisible
// (Staff/Global Admin only — same underlying 'toggle_invisible' mechanism
// previously buried in the room ⋮ menu, now surfaced here as one of the
// status choices, matching how every other status is picked). Picking
// Online/Away/Busy calls 'set_status' and also drops invisibility if it was
// on; picking Going Invisible calls 'toggle_invisible' and leaves the
// underlying online/away/busy value untouched — it's an overlay, not a
// replacement.
function openStatusPicker(anchorEl) {
  document.querySelectorAll('.status-picker-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'status-picker-menu';
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  const statuses = ['online', 'away', 'busy'];
  if (currentUser.is_staff || currentUser.is_global_admin) statuses.push('invisible');
  statuses.forEach((status) => {
    const opt = document.createElement('div');
    const selected = status === 'invisible' ? isInvisible : (currentUser.status === status && !isInvisible);
    opt.className = 'status-picker-option' + (selected ? ' selected' : '');
    opt.innerHTML = `<span class="status-dot ${statusDotClass(status)}"></span> ${STATUS_LABELS[status]}`;
    opt.addEventListener('click', () => {
      if (status === 'invisible') {
        socket.emit('toggle_invisible', true);
      } else {
        if (isInvisible) socket.emit('toggle_invisible', false);
        socket.emit('set_status', status);
      }
      menu.remove();
    });
    menu.appendChild(opt);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function closeOnce(e) {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeOnce);
      }
    });
  }, 0);
}
$('#profileStatusDot').addEventListener('click', (e) => {
  e.stopPropagation();
  openStatusPicker(e.currentTarget);
});

// ---------- NAVIGATION ----------
function isDesktopLayout() {
  return window.matchMedia('(min-width: 960px)').matches;
}

function showScreen(name) {
  // On desktop, opening the chat window (name === 'chat') must NOT disturb
  // whichever of Home/Rooms is currently showing underneath — it floats on
  // top of it instead of replacing it. Every other case (mobile always, or
  // switching to Home/Rooms on desktop) keeps the original exclusive toggle.
  const floatingOverlay = isDesktopLayout() && name === 'chat';
  if (!floatingOverlay) {
    $('#homeView').classList.toggle('hidden', name !== 'home');
    $('#roomsView').classList.toggle('hidden', name !== 'rooms');
    $('#navHomeBtn').classList.toggle('active', name === 'home');
    $('#navRoomsBtn').classList.toggle('active', name === 'rooms');
  }
  if (isDesktopLayout()) {
    if (name === 'chat') openFloatingChat();
  } else {
    $('#chatScreen').classList.toggle('hidden', name !== 'chat');
  }
  closeDrawer();
  if (name === 'home') refreshHome();
  if (name === 'rooms') refreshRooms();
}

$('#navHomeBtn').addEventListener('click', () => showScreen('home'));
$('#navRoomsBtn').addEventListener('click', () => showScreen('rooms'));

// Keep the chat screen's visibility model consistent if the browser window
// is resized across the desktop breakpoint while a room is open — otherwise
// a floating chat window (desktop) could end up stacked on top of Home
// instead of replacing it (mobile's single-screen model), or vice versa.
window.addEventListener('resize', () => {
  renderSecondaryPanels(); // desktop<->mobile crossing shows/hides the "all open rooms" panels
  if (currentRoomId == null) return;
  if (!$('#chatScreen').classList.contains('hidden')) showScreen('chat');
});

// The ✕ on a room's floating window (primary or secondary) is a real, final
// exit: leave the room over the socket, forget it locally, AND delete it
// from Recent Rooms server-side (unlike the ⋮ menu's "Leave Room", which
// deliberately keeps visit history so a room you left is still easy to find
// and rejoin — see GET /rooms/recent) so it stops showing up there too.
function leaveRoomAndForget(roomId) {
  if (roomId == null) return;
  socket.emit('leave_room', { roomId });
  roomMessageCache.delete(roomId);
  secondaryMsgSeen.delete(roomId);
  openRoomTabs = openRoomTabs.filter((r) => r.id !== roomId);
  api(`/rooms/${roomId}/visit`, { method: 'DELETE' }).then(() => refreshRooms()).catch(() => {});
  if (roomId === currentRoomId) {
    currentRoomId = null;
    clearSavedRoom();
  }
  renderRoomTabs();
}

// ---------- FLOATING CHAT WINDOW (desktop only) ----------
// Same #chatScreen element/logic as the mobile full-screen chat — this is a
// layout/interaction layer on top, not a second chat implementation.
let chatDragOffset = null;
function openFloatingChat() {
  const el = $('#chatScreen');
  el.classList.remove('hidden');
  if (isDesktopLayout()) {
    el.classList.add('floating');
    el.classList.remove('minimized');
  }
}
// The ✕ closes AND leaves+forgets the room (see leaveRoomAndForget) —
// unlike minimizing, which just tucks the panel away without touching
// membership at all.
function closeFloatingChat() {
  leaveRoomAndForget(currentRoomId);
  $('#chatScreen').classList.add('hidden');
}
function toggleMinimizeFloatingChat() {
  $('#chatScreen').classList.toggle('minimized');
}
$('#chatFloatCloseBtn').addEventListener('click', closeFloatingChat);
$('#chatFloatMinimizeBtn').addEventListener('click', toggleMinimizeFloatingChat);

// Dragging: mousedown on the header (but not its buttons) starts tracking;
// once the panel has been moved at least once, it switches from
// right/bottom-anchored to an explicit left/top position (.dragged) so it
// stays wherever it was dropped instead of snapping back to the corner.
(function setupChatDrag() {
  const handle = $('#roomHeader');
  const panel = $('#chatScreen');
  handle.addEventListener('mousedown', (e) => {
    if (!isDesktopLayout() || !panel.classList.contains('floating')) return;
    if (e.target.closest('.floating-chat-controls')) return;
    const rect = panel.getBoundingClientRect();
    chatDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!chatDragOffset) return;
    const rect = panel.getBoundingClientRect();
    let left = e.clientX - chatDragOffset.x;
    let top = e.clientY - chatDragOffset.y;
    left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, top));
    panel.classList.add('dragged');
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });
  document.addEventListener('mouseup', () => { chatDragOffset = null; });
})();

function openDrawer() {
  $('#navDrawerOverlay').classList.remove('hidden');
  $('#navDrawer').classList.remove('hidden');
}
function closeDrawer() {
  $('#navDrawerOverlay').classList.add('hidden');
  $('#navDrawer').classList.add('hidden');
}
$('#hamburgerBtn').addEventListener('click', openDrawer);
$('#navDrawerOverlay').addEventListener('click', closeDrawer);
$('#drawerHome').addEventListener('click', () => showScreen('home'));
$('#drawerRooms').addEventListener('click', () => showScreen('rooms'));
$('#drawerAlerts').addEventListener('click', () => { closeDrawer(); openAlerts(); });
$('#drawerEmails').addEventListener('click', () => { closeDrawer(); openEmails(); });
$('#drawerFriends').addEventListener('click', () => { closeDrawer(); openFriends(); });
$('#drawerAdmin').addEventListener('click', () => { closeDrawer(); openAdminPanel(); });
$('#drawerGiveCoins').addEventListener('click', () => { closeDrawer(); openGiveCoins(); });

// Desktop account dropdown (top right, replaces the hamburger drawer there —
// see #hamburgerBtn { display:none } in styles.css). Reuses the exact same
// screen-opening functions the drawer's own items call.
function closeTopbarUserMenu() { $('#topbarUserMenu').classList.add('hidden'); }
$('#topbarUserMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#topbarUserMenu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('#topbarUserMenuWrap').contains(e.target)) closeTopbarUserMenu();
});
$('#menuMyProfile').addEventListener('click', () => { closeTopbarUserMenu(); openDrawerMyProfile(); });
$('#menuMyBalance').addEventListener('click', () => { closeTopbarUserMenu(); openDrawerMyBalance(); });
$('#menuBlog').addEventListener('click', () => { closeTopbarUserMenu(); openDrawerBlog(); });
$('#menuEmails').addEventListener('click', () => { closeTopbarUserMenu(); openEmails(); });
$('#menuSettings').addEventListener('click', () => { closeTopbarUserMenu(); openDrawerSettings(); });
$('#menuGiveCoins').addEventListener('click', () => { closeTopbarUserMenu(); openGiveCoins(); });
$('#menuAdmin').addEventListener('click', () => { closeTopbarUserMenu(); openAdminPanel(); });
$('#menuLogout').addEventListener('click', () => { closeTopbarUserMenu(); doLogout(); });

$('#alertsBtn').addEventListener('click', openAlerts);
$('#emailsBtn').addEventListener('click', openEmails);
$('#friendsBtn').addEventListener('click', openFriends);

// Desktop-only top bar icons (hidden on mobile — see .desktop-nav-btn in
// styles.css) — same destinations the drawer/quick-actions already open,
// just reachable directly from the persistent top bar like iNwe's icon row.
$('#navExploreBtn').addEventListener('click', openDrawerExplore);
$('#navFriendsBtn').addEventListener('click', openFriends);
$('#navAlertsTopBtn').addEventListener('click', openAlerts);
$('#navFamilyBtn').addEventListener('click', () => openSubScreenFromDrawer('Family', renderMembersGroups));

// ---------- SOCKET ----------
function connectSocket() {
  socket = io();

  // Both events now carry roomId (see socket.js) so an event for a room
  // that isn't currently on screen anywhere gets routed correctly instead of
  // bleeding into whatever room happens to be displayed: the socket stays
  // subscribed to every room ever entered this session (no more auto-leave
  // on switch — see join_room), so without this a message from a
  // previously-visited room could otherwise land in the wrong panel, on
  // mobile too (which never has secondary panels, so it's simply dropped
  // there unless it's the one room currently shown).
  socket.on('chat_message', (msg) => {
    if (msg.roomId == null || msg.roomId === currentRoomId) { appendMessage(msg); return; }
    if (secondaryPanelEls.has(msg.roomId)) appendToSecondaryPanel(msg.roomId, msg);
  });
  socket.on('system_message', ({ roomId, text } = {}) => {
    const payload = { type: 'system', content: text, username: '' };
    if (roomId == null || roomId === currentRoomId) { appendMessage(payload); return; }
    if (secondaryPanelEls.has(roomId)) appendToSecondaryPanel(roomId, payload);
  });
  // Personal notices (coins/gifts given directly to you) are never room events —
  // show as a toast only, never as a message inside whatever room happens to be open.
  socket.on('personal_notice', (text) => toast(text));
  socket.on('error_message', (msg) => toast('⚠️ ' + msg));
  // Site-wide announcement (Staff/Global Admin "/announcement" command).
  // Fires two different ways: `live: true` is a fresh post/clear, flashed to
  // everyone online right now via the full-width Broadcast banner; a plain
  // (non-live) copy is also sent to a socket on join_room as a replay of
  // whatever's currently active, which only needs to update the pinned
  // Announcement banner quietly (no flash — they didn't just miss anything).
  socket.on('announcement', ({ roomId, text, by, live }) => {
    // Scoped to one room (see trySetAnnouncement in socket.js) — the pinned
    // banner only makes sense for whichever room is currently the primary
    // (full-featured) panel; an event for a room only open as a lightweight
    // secondary panel is skipped rather than overwriting that banner.
    if (roomId != null && roomId !== currentRoomId) return;
    currentAnnouncement = text ? { text, by } : null;
    renderAnnouncementBanner();
    if (live) {
      if (text) showBroadcastBanner(by, text);
      else toast('📢 Announcement cleared');
    }
  });
  // "/broadcast <text>" (Staff/Global Admin) — a one-time flash push, always
  // shown via the same blue banner as a fresh /announcement, but never
  // persisted or replayed — see tryBroadcast in socket.js.
  socket.on('broadcast', ({ text, by }) => { if (text) showBroadcastBanner(by, text); });
  socket.on('coins_update', ({ coins }) => { currentUser.coins = coins; updateUserBar(); });
  socket.on('legendary_state', (state) => {
    legendaryState = state;
    if (isInLegendaryRoom()) renderLegendaryPanel();
  });
  if (!legendaryCountdownTimer) {
    legendaryCountdownTimer = setInterval(() => {
      if (isInLegendaryRoom() && legendaryState.phase === 'betting') renderLegendaryPanel();
    }, 1000);
  }
  // Shared LowCard/Cricket engine broadcasts for both games on the same
  // event — only react when it's the game the player is actually looking at.
  socket.on('elimination_state', (state) => {
    if (isInCricketRoom() && state.roomId === currentRoomId) { cricketState = state; renderCricketPanel(); }
  });
  if (!cricketCountdownTimer) {
    cricketCountdownTimer = setInterval(() => {
      if (isInCricketRoom() && cricketState.phase === 'joining') renderCricketPanel();
    }, 1000);
  }
  // Picking a voucher is private — a toast to the picker only, never posted
  // to the room chat for everyone else to see.
  socket.on('voucher_won', ({ amount }) => toast(`🎉 You picked the voucher and won ${amount} coins!`));
  socket.on('xp_update', ({ xp, level, xpIntoLevel, xpForNextLevel }) => {
    const leveledUp = currentUser.level && level > currentUser.level;
    currentUser.xp = xp;
    currentUser.level = level;
    if (xpIntoLevel != null) currentUser.xpIntoLevel = xpIntoLevel;
    if (xpForNextLevel != null) currentUser.xpForNextLevel = xpForNextLevel;
    updateUserBar();
    if (leveledUp) toast(`⭐ Level up! You're now Lv.${level}`);
  });
  socket.on('gift_shower', (data) => playGiftShower(data));
  socket.on('whois_result', (data) => showWhoisPopup(data));
  // Now carries roomId (see broadcastRoomMembers in socket.js, needed once a
  // socket can be subscribed to several rooms' channels at once) — the
  // Participants panel and room-info banner only exist on the primary panel,
  // so an update for a room that's only open as a lightweight secondary
  // panel is simply not applicable here and is skipped.
  socket.on('room_members', ({ roomId, members } = {}) => {
    if (roomId != null && roomId !== currentRoomId) return;
    lastRoomMembers = members || [];
    renderRoomMembers(lastRoomMembers);
    renderRoomInfoBanner();
  });
  socket.on('kicked', ({ roomId, by, reason }) => {
    if (reason === 'timeout') toast('⏳ You were removed from the room after 5 hours of inactivity');
    else if (reason === 'bump') toast(`↪️ You were bumped from the room by ${by} — you can rejoin in 5 minutes`);
    else toast(`⛔ You were kicked from the room by ${by} — you can rejoin in 10 minutes`);
    openRoomTabs = openRoomTabs.filter((r) => r.id !== roomId);
    roomMessageCache.delete(roomId); // removed from the room — the next entry starts blank again
    secondaryMsgSeen.delete(roomId);
    renderRoomTabs();
    if (roomId === currentRoomId) {
      currentRoomId = null;
      clearSavedRoom();
      showScreen('rooms');
    }
  });

  // A room was permanently deleted by Staff/Global Admin (see delete_room in
  // socket.js) — bounce anyone who had it open out of it, exactly like a
  // kick, and drop it from every local list so it can't be re-entered.
  socket.on('room_deleted', ({ roomId }) => {
    openRoomTabs = openRoomTabs.filter((r) => r.id !== roomId);
    roomMessageCache.delete(roomId);
    secondaryMsgSeen.delete(roomId);
    allRoomsCache = allRoomsCache.filter((r) => r.id !== roomId);
    renderRoomTabs();
    if (roomId === currentRoomId) {
      currentRoomId = null;
      clearSavedRoom();
      showScreen('rooms');
      toast('🗑️ This room was permanently deleted');
    }
  });
  // Confirms the delete to whoever triggered it (they may not have been in
  // the room's channel themselves, e.g. deleting from the Rooms browser).
  socket.on('room_delete_confirmed', ({ roomId }) => {
    subScreenStack = [];
    $('#subScreenOverlay').classList.add('hidden');
    toast('🗑️ Room deleted');
    refreshRooms();
  });
  // Any Staff/Global-Admin room deletion touches the global room list —
  // simplest to just re-pull it for everyone rather than diffing.
  socket.on('room_list_changed', () => refreshRooms());

  socket.on('invisible_state', ({ invisible }) => {
    isInvisible = invisible;
    toast(invisible ? '👻 You are now Going Invisible — entering rooms silently, hidden from participant lists' : '👁️ You are visible again');
    updateUserBar();
  });

  socket.on('status_state', ({ status }) => {
    currentUser.status = status;
    updateUserBar();
  });

  // Room silence (/silence, /unsilence — see socket.js). The system_message
  // announcing it already prints in chat; this just drives the chat input's
  // disabled state for whoever can't talk through it.
  socket.on('room_silenced', ({ roomId, until }) => {
    if (roomId === currentRoomId) applySilenceState(until);
  });
  socket.on('room_unsilenced', ({ roomId }) => {
    if (roomId === currentRoomId) applySilenceState(null);
  });

  // Keeps the Room Browser cache (and, if open, the Room Settings screen) in
  // sync with a room's moderator list changing without a full page refresh —
  // also re-evaluates the current silence UI, since a newly-added/removed
  // moderator changes who can bypass an active silence, and refreshes the
  // Participants panel so kick/bump buttons for that user show up or vanish.
  socket.on('room_moderators_updated', ({ roomId, moderators }) => {
    const room = allRoomsCache.find((r) => r.id === roomId);
    if (room) room.moderator_usernames = moderators;
    if (roomId === currentRoomId) {
      applySilenceState(currentRoomSilencedUntil);
      renderRoomInfoBanner();
      refreshRoomSettingsIfOpen();
      updateMediaButtonsState();
    }
  });

  // Room Settings' Description/Lock Level was saved (by anyone with
  // permission) — refresh the cache, the pinned banner, and the screen
  // itself if it's currently open.
  socket.on('room_settings_updated', ({ roomId, description, lockLevel }) => {
    const room = allRoomsCache.find((r) => r.id === roomId);
    if (room) { room.description = description; room.lock_level = lockLevel; }
    if (roomId === currentRoomId) {
      renderRoomInfoBanner();
      refreshRoomSettingsIfOpen();
    }
  });

  socket.on('room_settings_saved', () => toast('✅ Room Settings saved'));

  // Room capacity changed (Staff only — see update_room_capacity in
  // socket.js) — refresh the cached room everywhere its member count
  // (X/capacity) is shown, and the Settings screen if it's open.
  socket.on('room_capacity_updated', ({ roomId, capacity }) => {
    const room = allRoomsCache.find((r) => r.id === roomId);
    if (room) room.capacity = capacity;
    if (roomId === currentRoomId) refreshRoomSettingsIfOpen();
    refreshRooms();
  });

  socket.on('room_ghost_mode_state', ({ roomId, ghost }) => {
    const room = allRoomsCache.find((r) => r.id === roomId);
    if (room) room.my_ghost_mode = ghost;
    toast(ghost ? '👻 Ghost Mode is on — you’ll join invisibly next time' : '👁️ Ghost Mode is off');
  });

  socket.on('room_unbanned', ({ roomId }) => {
    if (roomId === currentRoomId) refreshRoomSettingsIfOpen();
  });

  // Live private chat: append to the open Emails thread if it's the one this
  // message belongs to, otherwise just bump the unread badge.
  socket.on('private_message', (msg) => {
    const otherUsername = msg.fromUsername === currentUser.username ? msg.toUsername : msg.fromUsername;
    if (!$('#emailsOverlay').classList.contains('hidden') && emailsCurrentThreadUser && emailsCurrentThreadUser.toLowerCase() === otherUsername.toLowerCase()) {
      const box = $('#emailsMessages');
      const bubble = document.createElement('div');
      bubble.className = 'email-bubble ' + (msg.from_user_id === currentUser.id ? 'mine' : 'theirs');
      bubble.textContent = msg.content;
      box.appendChild(bubble);
      box.scrollTop = box.scrollHeight;
      if (msg.from_user_id !== currentUser.id) api(`/messages/${encodeURIComponent(otherUsername)}`).catch(() => {});
    } else if (msg.from_user_id !== currentUser.id) {
      toast(`✉️ New message from ${msg.fromUsername}`);
    }
    refreshBadgeCounts();
  });

  // Live badge on the Friends icon (desktop top nav, mobile drawer, quick
  // action) the moment someone sends a friend request — no need to wait
  // for a poll or for the Friends panel to be opened.
  socket.on('friend_request_received', (data) => {
    toast(`👥 ${data.fromUsername} sent you a friend request`);
    refreshBadgeCounts();
    if (!$('#friendsOverlay').classList.contains('hidden')) renderFriendsPanel();
  });
}

// ---------- HOME SCREEN ----------
async function refreshHome() {
  // Home's Feed card: a simplified composer + every post (Announcements AND
  // Blog together) in one merged, newest-first feed — see renderHomeFeed.
  renderHomeFeed($('#homeFeedBox'));

  try {
    // "Current Chat Rooms" no longer has its own visible list on Home —
    // rooms you're in show up as floating chat windows instead (see the
    // floating chat system below). This call stays only to keep
    // allRoomsCache warm — it's the shared lookup the chat screen's
    // owner/moderator banner and Room Info/Settings use.
    const { rooms } = await api('/rooms/recent?activeOnly=1');
    rooms.forEach((room) => {
      const idx = allRoomsCache.findIndex((r) => r.id === room.id);
      if (idx === -1) allRoomsCache.push(room); else allRoomsCache[idx] = room;
    });
  } catch (e) {}

  try {
    const { friends } = await api('/friends');
    const box = $('#homeFriendList');
    box.innerHTML = '';
    if (!friends.length) {
      box.innerHTML = '<div class="empty-note">No friends yet.</div>';
    } else {
      friends.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'friend-row';
        row.style.cursor = 'pointer';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(f.username)}">${escapeHtml((f.username || '?').charAt(0).toUpperCase())}</div>
          <span>${escapeHtml(f.username)}</span>
          <span class="status-dot ${statusDotClass(f.status)}" title="${STATUS_LABELS[f.status] || 'Offline'}"></span>`;
        row.title = `Message ${f.username}`;
        row.addEventListener('click', () => { openEmails(); openEmailThread(f.username); });
        box.appendChild(row);
      });
    }
  } catch (e) {}
}

function buildRoomRow(room) {
  const row = document.createElement('div');
  row.className = 'room-row';
  row.innerHTML = `
    <div class="avatar-square" style="background:${colorFor(room.name)}">${escapeHtml(room.name.charAt(0).toUpperCase())}</div>
    <div style="flex:1;">
      <div>${escapeHtml(room.name)}${room.is_official ? ' ✅' : ''}${room.room_type === 'game' ? ' 🎮' : ''}</div>
      <div style="font-size:12px;color:var(--text-dim);">${room.memberCount}/${room.capacity} in room</div>
    </div>`;
  row.addEventListener('click', () => enterRoom(room.id, room.name));
  return row;
}

async function refreshBadgeCounts() {
  try {
    const { unread: alertsUnread } = await api('/alerts');
    setBadge($('#alertsBadge'), alertsUnread);
    setBadge($('#drawerAlertsBadge'), alertsUnread);
    setBadge($('#navAlertsTopBadge'), alertsUnread);
  } catch (e) {}
  try {
    const { unread: emailsUnread } = await api('/messages');
    setBadge($('#emailsBadge'), emailsUnread);
    setBadge($('#drawerEmailsBadge'), emailsUnread);
    setBadge($('#menuEmailsBadge'), emailsUnread);
  } catch (e) {}
  try {
    // Incoming (not-yet-accepted/declined) friend requests — badges the
    // Friends icon everywhere it appears (desktop top nav, mobile drawer,
    // quick-action button) so a new request is noticeable without having
    // to open the panel. Cleared by openFriends() below once seen.
    const { incoming } = await api('/friends');
    const pendingCount = (incoming || []).length;
    setBadge($('#navFriendsBadge'), pendingCount);
    setBadge($('#drawerFriendsBadge'), pendingCount);
    setBadge($('#friendsBtnBadge'), pendingCount);
  } catch (e) {}
}
function setBadge(el, count) {
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : String(count);
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// Bio editing
$('#editBioBtn').addEventListener('click', async () => {
  const next = prompt('Update your bio (max 140 chars):', currentUser.bio || '');
  if (next === null) return;
  try {
    const { user } = await api('/auth/bio', { method: 'POST', body: JSON.stringify({ bio: next.slice(0, 140) }) });
    currentUser = user;
    updateUserBar();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- ROOM BROWSER ----------
async function refreshRooms() {
  try {
    const [{ rooms: all }, { rooms: recent }] = await Promise.all([api('/rooms'), api('/rooms/recent')]);
    allRoomsCache = all;
    renderRoomGrids(all, recent);
  } catch (e) {}
}

function renderRoomGrids(all, recent) {
  const q = ($('#roomSearchInput').value || '').trim().toLowerCase();
  const filtered = (rooms) => rooms.filter((r) => !q || r.name.toLowerCase().includes(q));

  const recentF = filtered(recent);
  const officialF = filtered(all.filter((r) => r.is_official));
  const otherF = filtered(all.filter((r) => !r.is_official));

  $('#recentCountChip').textContent = recentF.length;
  $('#officialCountChip').textContent = officialF.length;
  $('#otherCountChip').textContent = otherF.length;

  fillRoomGrid('#recentRoomGrid', recentF, 'No recent rooms.');
  fillRoomGrid('#officialRoomGrid', officialF, 'No official rooms.');
  fillRoomGrid('#otherRoomGrid', otherF, 'No other rooms yet.');

  // Desktop-only right sidebar (see #rightSidebar in index.html) — same
  // underlying room data as the grids above, just a compact always-visible
  // list instead of a dedicated Rooms screen you have to navigate to.
  renderSidebarRoomLists(all, recent);
}

// Cached so the sidebar's own room search (🔍 next to + Create Room) can
// re-filter and redraw instantly on every keystroke without a network
// round trip — it re-slices this same data instead of re-calling refreshRooms().
let lastAllRoomsForSidebar = [];
let lastRecentRoomsForSidebar = [];
let sidebarRoomSearchQuery = '';

// A room's HOT threshold — once it has more than this many people in it, it
// surfaces in the "🔥 Hot rooms" section instead of "Other rooms".
const HOT_ROOM_MEMBER_THRESHOLD = 20;

function renderSidebarRoomLists(all, recent) {
  lastAllRoomsForSidebar = all;
  lastRecentRoomsForSidebar = recent;
  const q = sidebarRoomSearchQuery;
  const matches = (r) => !q || r.name.toLowerCase().includes(q);

  // Categorization is exclusive so a room never appears twice in the
  // sidebar: Favorite (any room the user starred) takes priority over
  // everything else, then Official, then Hot (busy, >20 people), and
  // everything left over lands in Other rooms — exactly where a freshly
  // created room shows up until someone favorites it.
  const favorites = all.filter((r) => r.isFavorite);
  const official = all.filter((r) => !r.isFavorite && r.is_official);
  const hot = all.filter((r) => !r.isFavorite && !r.is_official && r.memberCount > HOT_ROOM_MEMBER_THRESHOLD);
  const other = all.filter((r) => !r.isFavorite && !r.is_official && r.memberCount <= HOT_ROOM_MEMBER_THRESHOLD);

  const favoritesF = favorites.filter(matches);
  const officialF = official.filter(matches);
  const hotF = hot.filter(matches);
  const otherF = other.filter(matches);
  const recentF = recent.filter(matches);

  fillSidebarRoomList('#sidebarFavoriteRooms', favoritesF, q ? 'No favorite rooms match your search.' : 'No favorite rooms yet — star any room to add it here.');
  fillSidebarRoomList('#sidebarOfficialRooms', officialF, q ? 'No official rooms match your search.' : 'No official rooms.');
  fillSidebarRoomList('#sidebarHotRooms', hotF, q ? 'No hot rooms match your search.' : 'No hot rooms right now — rooms with 20+ people show up here.');
  fillSidebarRoomList('#sidebarOtherRooms', otherF, q ? 'No other rooms match your search.' : 'No other rooms yet.');
  fillSidebarRoomList('#sidebarRecentRooms', recentF, q ? 'No recent rooms match your search.' : 'No recent rooms.');
  $('#sidebarFavoriteCount').textContent = favoritesF.length;
  $('#sidebarOfficialCount').textContent = officialF.length;
  $('#sidebarHotCount').textContent = hotF.length;
  $('#sidebarOtherCount').textContent = otherF.length;
  $('#sidebarRecentCount').textContent = recentF.length;
}

function fillSidebarRoomList(sel, rooms, emptyText) {
  const box = $(sel);
  box.innerHTML = '';
  if (!rooms.length) {
    box.innerHTML = `<div class="empty-note">${emptyText}</div>`;
    return;
  }
  rooms.forEach((room) => {
    const row = document.createElement('div');
    row.className = 'sidebar-room-row';
    row.innerHTML = `
      <span class="sidebar-room-dot"></span>
      <span class="sidebar-room-name">${escapeHtml(room.name)}${room.is_official ? ' ✅' : ''}${room.memberCount > HOT_ROOM_MEMBER_THRESHOLD ? ' 🔥' : ''}</span>
      <span class="sidebar-room-count">${room.memberCount}/${room.capacity}</span>
      <button class="sidebar-star-btn ${room.isFavorite ? 'favorited' : ''}" data-id="${room.id}" title="${room.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">${room.isFavorite ? '★' : '☆'}</button>
    `;
    row.title = room.name;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('sidebar-star-btn')) return;
      enterRoom(room.id, room.name);
    });
    row.querySelector('.sidebar-star-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = !room.isFavorite;
      try {
        await api(`/rooms/${room.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: next }) });
        refreshRooms();
      } catch (err) { toast(err.message); }
    });
    box.appendChild(row);
  });
}

// Sidebar room search (🔍 next to + Create Room) — filters the same
// Favorite/Official/Recent lists shown below it, live, as you type.
$('#sidebarRoomSearchBtn').addEventListener('click', () => {
  const wrap = $('#sidebarRoomSearchWrap');
  wrap.classList.toggle('hidden');
  if (!wrap.classList.contains('hidden')) {
    $('#sidebarRoomSearchInput').focus();
  } else {
    $('#sidebarRoomSearchInput').value = '';
    sidebarRoomSearchQuery = '';
    renderSidebarRoomLists(lastAllRoomsForSidebar, lastRecentRoomsForSidebar);
  }
});
$('#sidebarRoomSearchInput').addEventListener('input', (e) => {
  sidebarRoomSearchQuery = e.target.value.trim().toLowerCase();
  renderSidebarRoomLists(lastAllRoomsForSidebar, lastRecentRoomsForSidebar);
});

// Collapsible sidebar sections (chevron toggle) + a per-section refresh
// icon that just re-pulls the same room data every section is built from.
document.querySelectorAll('.sidebar-section-header').forEach((header) => {
  header.addEventListener('click', (e) => {
    if (e.target.classList.contains('sidebar-refresh-btn')) return;
    header.closest('.sidebar-room-section').classList.toggle('collapsed');
  });
  const refreshBtn = header.querySelector('.sidebar-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refreshRooms(); });
});

// "+ Create Room" in the sidebar opens the exact same modal as the Rooms
// screen's ➕ button, instead of duplicating the create-room logic.
$('#sidebarCreateRoomBtn').addEventListener('click', openCreateRoomModal);

function fillRoomGrid(sel, rooms, emptyText) {
  const grid = $(sel);
  grid.innerHTML = '';
  if (!rooms.length) {
    grid.innerHTML = `<div class="empty-note">${emptyText}</div>`;
    return;
  }
  rooms.forEach((room) => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="avatar-square" style="background:${colorFor(room.name)}">${escapeHtml(room.name.charAt(0).toUpperCase())}</div>
      <div class="room-card-name">${escapeHtml(room.name)}${room.is_official ? ' ✅' : ''}${room.room_type === 'game' ? ' 🎮' : ''}</div>
      <div class="room-card-meta">${room.memberCount}/${room.capacity} in room</div>
      <button class="star-btn ${room.isFavorite ? 'favorited' : ''}" data-id="${room.id}">${room.isFavorite ? '★' : '☆'}</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('star-btn')) return;
      enterRoom(room.id, room.name);
    });
    card.querySelector('.star-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = !room.isFavorite;
      try {
        await api(`/rooms/${room.id}/favorite`, { method: 'POST', body: JSON.stringify({ favorite: next }) });
        refreshRooms();
      } catch (err) { toast(err.message); }
    });
    grid.appendChild(card);
  });
}

$('#roomSearchInput').addEventListener('input', () => refreshRooms());
$('#roomsRefreshBtn').addEventListener('click', refreshRooms);
$('#roomsCreateBtn').addEventListener('click', openCreateRoomModal);

// ---------- CREATE ROOM MODAL ----------
// Popup dialog (Room name + Description) replacing the old inline toggle
// form. Room creation itself may be gated by a Staff-configurable minimum
// level (see GET /rooms/settings/min-create-level) — Staff bypass the gate
// server-side, so the note is only shown to non-staff users.
async function openCreateRoomModal() {
  $('#newRoomName').value = '';
  $('#newRoomDescription').value = '';
  $('#createRoomLevelNote').classList.add('hidden');
  $('#createRoomModal').classList.remove('hidden');
  $('#newRoomName').focus();

  if (!currentUser.is_staff) {
    try {
      const { minLevel } = await api('/rooms/settings/min-create-level');
      if (minLevel > 0) {
        const note = $('#createRoomLevelNote');
        note.textContent = currentUser.level >= minLevel
          ? `Creating a room requires level ${minLevel} or higher — you qualify (level ${currentUser.level}).`
          : `Creating a room requires level ${minLevel} or higher — you're currently level ${currentUser.level}.`;
        note.classList.remove('hidden');
      }
    } catch (err) { /* non-fatal — the create attempt itself still enforces the gate */ }
  }
}
function closeCreateRoomModal() { $('#createRoomModal').classList.add('hidden'); }
$('#closeCreateRoomBtn').addEventListener('click', closeCreateRoomModal);
$('#cancelCreateRoomBtn').addEventListener('click', closeCreateRoomModal);
$('#createRoomModal').addEventListener('click', (e) => { if (e.target.id === 'createRoomModal') closeCreateRoomModal(); });

$('#roomForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#newRoomName').value.trim();
  const description = $('#newRoomDescription').value.trim();
  if (!name) return;
  try {
    await api('/rooms', { method: 'POST', body: JSON.stringify({ name, description }) });
    closeCreateRoomModal();
    refreshRooms();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- CHAT SCREEN ----------
// Which room the user is currently in survives a page refresh: it's saved
// here and re-joined automatically on load (see restoreSavedRoom below).
// Server-side, room membership itself is already persistent (see socket.js)
// — this is just so the UI lands back in the chat instead of dumping the
// user out to the Home screen every time the page reloads.
const SAVED_ROOM_KEY = 'miniplatform:lastRoom';
function saveCurrentRoom(id, name) {
  try { localStorage.setItem(SAVED_ROOM_KEY, JSON.stringify({ id, name })); } catch (e) {}
}
function clearSavedRoom() {
  try { localStorage.removeItem(SAVED_ROOM_KEY); } catch (e) {}
}
function readSavedRoom() {
  try {
    const raw = localStorage.getItem(SAVED_ROOM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function enterRoom(id, name) {
  // Clicking back into the room you're ALREADY in — the room tab pill, its
  // quick-icon, or the same card in Room Browser — must never be treated as
  // leaving and re-entering: that would wipe the chat you're actively
  // watching for no reason. Only clear/rejoin when this is a genuine switch
  // to a different room; otherwise just make sure the Chat screen is showing
  // and stop here.
  if (id === currentRoomId) {
    showScreen('chat');
    return;
  }

  // Snapshot whatever room we're switching AWAY from (if any) so that
  // switching back to it later — while it's still one of your open tabs —
  // picks up right where you left it instead of looking wiped.
  if (currentRoomId != null) {
    roomMessageCache.set(currentRoomId, $('#messages').innerHTML);
  }

  currentRoomId = id;
  currentRoomName = name;
  $('#currentRoomName').textContent = name;
  saveCurrentRoom(id, name);
  lastRoomMembers = [];
  roomBannerMsgCount.set(id, 0);
  renderRoomInfoBanner();

  if (!openRoomTabs.find((r) => r.id === id)) openRoomTabs.push({ id, name });
  renderRoomTabs();
  updateMediaButtonsState();

  legendarySelectedAnimal = null;
  legendaryMinimized = false;
  legendaryHidden = false;
  if (isInLegendaryRoom()) {
    socket.emit('legendary_get_state', {}, (state) => { if (state) { legendaryState = state; renderLegendaryPanel(); } });
  } else {
    renderLegendaryPanel(); // hides the panel when leaving the Legendary room
  }

  if (isInCricketRoom()) {
    socket.emit('elimination_get_state', { roomId: id }, (state) => { if (state) { cricketState = state; renderCricketPanel(); } });
  } else {
    renderCricketPanel(); // hides the bar when leaving the Cricket room
  }

  // Chat text is visible ONLY from the moment you actually enter a room —
  // for every single account, no exceptions for Staff, Global Admin, or any
  // other role. If you've had this room open as a tab already and are just
  // switching back to it (never actually left it), its cached snapshot from
  // above is restored instantly — flipping between open tabs must never look
  // like leaving and re-entering.
  const hadLocalCache = roomMessageCache.has(id);
  $('#messages').innerHTML = hadLocalCache ? roomMessageCache.get(id) : '';
  seenMsgIds.clear();
  collectMsgIds($('#messages'));

  // No local cache means this room hasn't been shown in this browser tab yet
  // — either a genuinely fresh entry, or the page was just reloaded (a
  // refresh wipes all in-memory JS state, including this cache). Either way,
  // ask the server what's happened since we last genuinely entered this
  // room: for a truly fresh entry it correctly comes back empty (still
  // blank, exactly as before); for a refresh mid-session it replays exactly
  // what would still be on screen if the page hadn't reloaded, so refreshing
  // no longer looks like leaving the room.
  // Optimistically assume the newly-entered room isn't silenced — corrected
  // by the join_room ack just below the instant it resolves — so switching
  // into an ordinary room doesn't sit disabled for the length of a round trip.
  applySilenceState(null);

  socket.emit('join_room', id, (ack) => {
    if (id !== currentRoomId) return; // switched elsewhere again before this came back
    if (!hadLocalCache && ack && ack.ok) {
      (ack.history || []).forEach((m) => appendMessage(m));
    }
    applySilenceState(ack && ack.ok ? ack.silencedUntil : null);
    renderRoomInfoBanner();
  });

  showScreen('chat');
}

// Whether the current user could still type in the current room even while
// it's silenced — Staff, Global Admin, the room's owner, or one of its
// moderators. Mirrors canBypassSilence() in socket.js; the server enforces
// this for real, this just drives whether the chat input LOOKS enabled.
function computeCanBypassSilence() {
  if (!currentUser) return false;
  if (currentUser.is_staff || currentUser.is_global_admin) return true;
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  if (!room) return false;
  if (room.owner_username === currentUser.username) return true;
  return (room.moderator_usernames || []).includes(currentUser.username);
}

// Voice notes and picture sharing are reserved for trusted roles — mirrors
// canSendMedia() in socket.js (the real, server-side gate); this only
// decides whether the mic/image icons show up at all.
function computeCanSendMedia() {
  if (!currentUser) return false;
  if (currentUser.is_staff || currentUser.is_global_admin || currentUser.is_mentor || currentUser.is_merchant) return true;
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  if (!room) return false;
  if (room.owner_username === currentUser.username) return true;
  return (room.moderator_usernames || []).includes(currentUser.username);
}

function updateMediaButtonsState() {
  const allowed = computeCanSendMedia();
  $('#shareImageBtn').classList.toggle('hidden', !allowed);
  $('#voiceNoteBtn').classList.toggle('hidden', !allowed);
}

// Applies (or lifts) the "room is silenced" chat-input lockout for whoever
// can't bypass it. `until` is an epoch-ms timestamp or null/undefined.
function applySilenceState(until) {
  currentRoomSilencedUntil = until || null;
  const input = $('#chatInput');
  const sendBtn = $('#sendBtn');
  if (!input.dataset.origPlaceholder) input.dataset.origPlaceholder = input.placeholder;

  const blocked = !!currentRoomSilencedUntil && !computeCanBypassSilence();
  input.disabled = blocked;
  sendBtn.disabled = blocked;
  input.placeholder = blocked ? "🔇 This room is silenced — you can't type at this moment" : input.dataset.origPlaceholder;
}

// Every room you've entered this session gets one pill here — the only
// room switcher in the app now (the old separate colored-circle quick-icon
// row in the topbar was removed as a duplicate of this).
function renderRoomTabs() {
  const bar = $('#roomTabBar');
  bar.innerHTML = '';
  openRoomTabs.forEach((r) => {
    const pill = document.createElement('button');
    pill.className = 'room-tab-pill' + (r.id === currentRoomId ? ' active' : '');
    pill.innerHTML = `<span class="room-tab-pill-icon">💬</span>${escapeHtml(r.name)}`;
    pill.addEventListener('click', () => enterRoom(r.id, r.name));
    bar.appendChild(pill);
  });
  // Keep the "show every open room at once" floating panels (desktop only)
  // in sync with the tab list any time it changes — see renderSecondaryPanels.
  renderSecondaryPanels();
}

// Builds the DOM node for one chat message/system-notice — shared by the
// primary #messages pane (appendMessage) and every secondary floating panel
// (appendToSecondaryPanel) so both render identically without duplicating
// all the per-type branches below.
function buildMessageEl(msg) {
  const div = document.createElement('div');
  if (msg.id != null) div.dataset.msgId = String(msg.id);
  div.className = 'msg ' + (msg.type || 'text');
  if (msg.type === 'system' || msg.type === 'voucher') {
    div.textContent = msg.content;
  } else if (msg.type === 'gift') {
    div.textContent = msg.content;
  } else if (msg.type === 'legendary') {
    // Multi-line bot messages (bet confirmations, dice rolls, payouts) —
    // preserve line breaks, bold purple "Legendary Bot:" prefix, bubble bg.
    div.innerHTML = `<span class="user legendary-bot-name">Legendary Bot:</span> ${escapeHtml(msg.content).replace(/\n/g, '<br>')}`;
  } else if (msg.type === 'game_bot') {
    // LowCard / Cricket bot messages — same bubble treatment as Legendary
    // Bot, but the name comes from msg.username (e.g. "LowCard Bot").
    div.innerHTML = `<span class="user legendary-bot-name">${escapeHtml(msg.username || 'Game Bot')}:</span> ${escapeHtml(msg.content).replace(/\n/g, '<br>')}`;
  } else if (msg.type === 'image' || msg.type === 'voice') {
    const cls = roleClass(msg);
    const nameStyle = usernameStyleAttr(msg);
    const mediaHtml = msg.type === 'image'
      ? `<img class="chat-shared-image" src="${escapeHtml(msg.content)}" alt="shared picture" loading="lazy" />`
      : `<audio class="chat-voice-note" src="${escapeHtml(msg.content)}" controls></audio>`;
    div.innerHTML = `<div><span class="user clickable-username ${cls}"${nameStyle} data-username="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}${roleIcon(msg)}:</span></div>${mediaHtml}`;
  } else {
    const cls = roleClass(msg);
    // No role badge? Fall back to a purchased Color Shop color, same as the
    // Participants panel and Members/Leaderboard screens — a role color
    // always wins, but a plain user's chosen color still shows in chat.
    const nameStyle = usernameStyleAttr(msg);
    div.innerHTML = `<span class="user clickable-username ${cls}"${nameStyle} data-username="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}${roleIcon(msg)}:</span> ${escapeChatText(msg.content)}`;
  }
  return div;
}

function appendMessage(msg) {
  // Same persisted message can arrive twice around a room entry (once live,
  // once via the join_room history backlog) — skip the repeat rather than
  // showing it twice. Only messages with a real DB id are tracked; system
  // notices ("has entered/left") have none and always render.
  if (msg.id != null) {
    const key = String(msg.id);
    if (seenMsgIds.has(key)) return;
    seenMsgIds.add(key);
  }
  const div = buildMessageEl(msg);
  const box = $('#messages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  // Count chat activity toward the auto-collapse threshold for the room-info
  // banner (managed-by / welcome / who's-here) — see roomBannerCollapsed.
  const rid = currentRoomId;
  if (rid != null) {
    const n = (roomBannerMsgCount.get(rid) || 0) + 1;
    roomBannerMsgCount.set(rid, n);
    if (n === ROOM_BANNER_COLLAPSE_AFTER && !roomBannerCollapsed.get(rid)) {
      roomBannerCollapsed.set(rid, true);
      renderRoomInfoBanner();
    }
  }
}

// ---------- SECONDARY FLOATING PANELS (desktop, "show all open rooms") ----------
// Every room in openRoomTabs besides currentRoomId (which already gets the
// full-featured primary #chatScreen window) gets one of these: a small
// always-visible floating panel with its own message list and a basic send
// box, so entering several rooms shows all of them live at once instead of
// only the last one switched into. Clicking a panel's header promotes that
// room to primary (full feature set — emoji, gifts, settings, etc.); the ✕
// leaves the room outright. Mobile never creates these (isDesktopLayout()
// guard in renderSecondaryPanels) — it keeps the original single full-screen
// room exactly as before.
function appendToSecondaryPanel(roomId, msg) {
  const el = secondaryPanelEls.get(roomId);
  if (!el) return;
  if (msg.id != null) {
    let seen = secondaryMsgSeen.get(roomId);
    if (!seen) { seen = new Set(); secondaryMsgSeen.set(roomId, seen); }
    const key = String(msg.id);
    if (seen.has(key)) return;
    seen.add(key);
  }
  const box = el.querySelector('.secondary-panel-messages');
  box.appendChild(buildMessageEl(msg));
  box.scrollTop = box.scrollHeight;
  // Keep it light — this is a glance-at panel, not the full chat history.
  while (box.children.length > 50) box.removeChild(box.firstChild);
}

function buildSecondaryPanel(id, name) {
  const el = document.createElement('div');
  el.className = 'secondary-panel';
  el.dataset.roomId = String(id);

  const header = document.createElement('div');
  header.className = 'secondary-panel-header';
  const title = document.createElement('span');
  title.textContent = `💬 ${name}`;
  const closeBtn = document.createElement('span');
  closeBtn.className = 'secondary-panel-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Leave room';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    leaveRoomAndForget(id);
  });
  header.appendChild(title);
  header.appendChild(closeBtn);
  header.addEventListener('click', () => enterRoom(id, name));

  const msgs = document.createElement('div');
  msgs.className = 'secondary-panel-messages';

  const inputRow = document.createElement('div');
  inputRow.className = 'secondary-panel-inputrow';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 1000;
  input.placeholder = 'Message...';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn';
  sendBtn.textContent = 'Send';
  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', { roomId: id, text });
    input.value = '';
  }
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  input.addEventListener('click', (e) => e.stopPropagation());
  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  el.appendChild(header);
  el.appendChild(msgs);
  el.appendChild(inputRow);
  return el;
}

// Fills a freshly-created secondary panel with whatever's already known for
// that room: an existing #messages snapshot if it was the primary room at
// some point this session, otherwise a fresh join_room round trip for its
// history (harmless to call again — the server only treats it as a genuine
// re-entry, with its "has entered" notice, the first time per session).
function fillSecondaryPanelHistory(id) {
  const el = secondaryPanelEls.get(id);
  if (!el) return;
  const box = el.querySelector('.secondary-panel-messages');
  if (roomMessageCache.has(id)) {
    box.innerHTML = roomMessageCache.get(id);
    box.scrollTop = box.scrollHeight;
    return;
  }
  socket.emit('join_room', id, (ack) => {
    if (!secondaryPanelEls.has(id)) return; // panel closed/promoted before this came back
    if (ack && ack.ok) (ack.history || []).forEach((m) => appendToSecondaryPanel(id, m));
  });
}

function renderSecondaryPanels() {
  const container = $('#secondaryPanels');
  if (!container) return;
  if (!isDesktopLayout()) {
    container.innerHTML = '';
    secondaryPanelEls.clear();
    return;
  }
  const wanted = openRoomTabs.filter((r) => r.id !== currentRoomId);
  for (const [rid, el] of Array.from(secondaryPanelEls.entries())) {
    if (!wanted.find((r) => r.id === rid)) {
      el.remove();
      secondaryPanelEls.delete(rid);
      secondaryMsgSeen.delete(rid);
    }
  }
  wanted.forEach((r) => {
    if (secondaryPanelEls.has(r.id)) return; // already showing — keep its live content, don't rebuild
    const el = buildSecondaryPanel(r.id, r.name);
    secondaryPanelEls.set(r.id, el);
    container.appendChild(el);
    fillSecondaryPanelHistory(r.id);
  });
}

// Tap a username in chat (text/image/voice messages only — bot names aren't
// real accounts) to view that user's profile. Delegated once on the
// messages container instead of a listener per message.
$('#messages').addEventListener('click', (e) => {
  const el = e.target.closest('.clickable-username');
  if (el && el.dataset.username) openUserProfile(el.dataset.username);
});

// Falling-emoji celebration for "/gift all" (optionally themed to one gift,
// e.g. "/gift all sudan") — works even solo in a room.
function playGiftShower({ username, level, emojis, giftName }) {
  const layer = $('#giftShowerLayer');
  (emojis || []).forEach((emoji, i) => {
    const span = document.createElement('span');
    span.className = 'shower-emoji';
    span.textContent = emoji;
    span.style.left = Math.random() * 96 + '%';
    span.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    span.style.animationDelay = (i * 0.06) + 's';
    layer.appendChild(span);
    setTimeout(() => span.remove(), 4500);
  });

  const who = level != null ? `${username} [${level}]` : username;
  const what = giftName ? `${giftName} ` : '';
  const banner = document.createElement('div');
  banner.id = 'giftShowerBanner';
  banner.textContent = `🎉 ${who} sent a ${what}GIFT SHOWER! 🎁`;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 2300);
}

// "/whois <username>" result — a small popup with level, country, and live
// status. Open to every user (see WHOIS_COMMAND in socket.js).
function showWhoisPopup(u) {
  const nameStyle = usernameStyleAttr(u);
  $('#whoisContent').innerHTML = `
    <div class="avatar-circle whois-avatar" style="background:${colorFor(u.username)}; margin-left:auto; margin-right:auto;">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
    <div class="whois-name"><span class="${roleClass(u)}"${nameStyle}>${escapeHtml(u.username)}</span>${roleIcon(u)}</div>
    <div class="whois-row">⚡ Level ${u.level}</div>
    <div class="whois-row">${u.country ? `${countryFlag(u.country)} ${escapeHtml(u.country)}` : 'No country set'}</div>
    <div class="whois-row"><span class="status-dot ${statusDotClass(u.status)}"></span> ${STATUS_LABELS[u.status] || 'Offline'}</div>
  `;
  $('#whoisModal').classList.remove('hidden');
}
function closeWhois() { $('#whoisModal').classList.add('hidden'); }
$('#closeWhoisBtn').addEventListener('click', closeWhois);
$('#whoisModal').addEventListener('click', (e) => { if (e.target.id === 'whoisModal') closeWhois(); });

// ---------- LEGENDARY BOT (dice-betting game) ----------
const LEGENDARY_ROOM_NAME = 'Legendary Bot Official';
const LEGENDARY_ANIMALS = [
  { key: 'lion', label: 'Lion', emoji: '🦁' },
  { key: 'tiger', label: 'Tiger', emoji: '🐯' },
  { key: 'fox', label: 'Fox', emoji: '🦊' },
  { key: 'wolf', label: 'Wolf', emoji: '🐺' },
  { key: 'bear', label: 'Bear', emoji: '🐻' },
  { key: 'panda', label: 'Panda', emoji: '🐼' },
];
const LEGENDARY_BET_AMOUNTS = [500, 1000, 2000, 5000, 10000, 15000, 20000];
function formatBetAmount(n) { return n >= 1000 ? `${n / 1000}k` : String(n); }

let legendarySelectedAmount = 500;
let legendarySelectedAnimal = null;
let legendaryState = { phase: 'idle', endsAt: 0, animalTotals: {} };
let legendaryCountdownTimer = null;
// Two independent declutter controls, matching the reference bar's 👁/− pair:
// minimized keeps the header strip (countdown + current bet) but hides the
// animal/amount rows; hidden drops the whole bar, leaving only a small tab
// to bring it back. Both reset on room re-entry (not persisted) since they're
// just "I don't want to look at this right now" toggles, not a preference.
let legendaryMinimized = false;
let legendaryHidden = false;

function isInLegendaryRoom() { return currentRoomName === LEGENDARY_ROOM_NAME; }

// ---------- CRICKET STATUS BAR (Official Cricket Room) ----------
// Purely informational pitch-themed strip — Cricket is still played with the
// !start/!j/!d chat commands (shared LowCard/Cricket engine in socket.js);
// this just gives it a live visual readout of the round, matching the
// reference screenshot (🏏 Cricket · players in/left on the left, ball in the
// middle, phase badge on the right), the same way the Legendary panel gave
// the dice game a visual bar on top of its existing chat-command play.
const CRICKET_ROOM_NAME = 'Official Cricket Room';
let cricketState = { roomId: null, botName: 'Cricket Bot', phase: 'idle', round: 0, playersIn: 0, playersLeft: 0, pot: 0, endsAt: 0 };
let cricketCountdownTimer = null;
function isInCricketRoom() { return currentRoomName === CRICKET_ROOM_NAME; }

function renderCricketPanel() {
  const panel = $('#cricketGamePanel');
  if (!panel) return;
  if (!isInCricketRoom()) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');

  const phase = cricketState.phase;
  let phaseBadge;
  if (phase === 'joining') {
    const secondsLeft = Math.max(0, Math.ceil((cricketState.endsAt - Date.now()) / 1000));
    phaseBadge = `<span class="cricket-badge cricket-badge-joining">🟢 Joining · ${secondsLeft}s</span>`;
  } else if (phase === 'drawing') {
    phaseBadge = `<span class="cricket-badge cricket-badge-live">⏳ Game in progress</span>`;
  } else {
    phaseBadge = `<span class="cricket-badge cricket-badge-idle">Type !start to play</span>`;
  }

  panel.innerHTML = `
    <div class="cricket-side cricket-side-left">
      <span class="cricket-title">🏏 Cricket</span>
      ${phase !== 'idle' ? `<span class="cricket-count">${cricketState.playersIn} in · ${cricketState.playersLeft} left</span>` : ''}
    </div>
    <div class="cricket-ball" title="${cricketState.pot ? `Pot: ${cricketState.pot} coins` : 'Cricket'}">🏏</div>
    <div class="cricket-side cricket-side-right">${phaseBadge}</div>
  `;
}

function renderLegendaryPanel() {
  const panel = $('#legendaryGamePanel');
  if (!isInLegendaryRoom()) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

  if (legendaryHidden) {
    panel.classList.remove('hidden');
    panel.innerHTML = `<button type="button" class="legendary-reopen-tab">🎲 Legendary</button>`;
    panel.querySelector('.legendary-reopen-tab').addEventListener('click', () => { legendaryHidden = false; renderLegendaryPanel(); });
    return;
  }
  panel.classList.remove('hidden');

  const secondsLeft = legendaryState.phase === 'betting' ? Math.max(0, Math.ceil((legendaryState.endsAt - Date.now()) / 1000)) : 0;
  const selectedAnimalObj = LEGENDARY_ANIMALS.find((a) => a.key === legendarySelectedAnimal);

  panel.innerHTML = `
    <div class="legendary-header">
      <span class="legendary-title-icon">🎲</span>
      <span class="legendary-title">Legendary</span>
      ${legendaryState.phase === 'betting'
        ? `<span class="legendary-badge legendary-countdown">${secondsLeft}s</span>`
        : `<span class="legendary-badge legendary-countdown idle">waiting for !start</span>`}
      ${selectedAnimalObj ? `<span class="legendary-badge legendary-bet-summary">${selectedAnimalObj.label} · ${formatBetAmount(legendarySelectedAmount)}</span>` : ''}
      <span class="legendary-header-spacer"></span>
      <button type="button" class="legendary-icon-btn" id="legendaryHideBtn" title="Hide">👁</button>
      <button type="button" class="legendary-icon-btn" id="legendaryMinBtn" title="${legendaryMinimized ? 'Expand' : 'Minimize'}">${legendaryMinimized ? '+' : '−'}</button>
    </div>
    ${legendaryMinimized ? '' : `
      <div class="legendary-animal-row"></div>
      <div class="legendary-amount-row"></div>
    `}
  `;

  panel.querySelector('#legendaryHideBtn').addEventListener('click', () => { legendaryHidden = true; renderLegendaryPanel(); });
  panel.querySelector('#legendaryMinBtn').addEventListener('click', () => { legendaryMinimized = !legendaryMinimized; renderLegendaryPanel(); });

  if (legendaryMinimized) return;

  const row = panel.querySelector('.legendary-animal-row');
  LEGENDARY_ANIMALS.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'legendary-animal-item' + (a.key === legendarySelectedAnimal ? ' selected' : '');
    item.innerHTML = `<div class="legendary-animal-avatar">${a.emoji}</div><div class="legendary-animal-item-label">${a.label}</div>`;
    item.addEventListener('click', () => {
      legendarySelectedAnimal = a.key;
      if (legendaryState.phase !== 'betting') { renderLegendaryPanel(); return toast('Betting is closed — wait for the next round'); }
      socket.emit('legendary_place_bet', { animal: a.key, amount: legendarySelectedAmount }, (ack) => {
        if (!ack || !ack.ok) toast((ack && ack.error) || 'Could not place that bet');
      });
      renderLegendaryPanel();
    });
    row.appendChild(item);
  });

  const amountRow = panel.querySelector('.legendary-amount-row');
  LEGENDARY_BET_AMOUNTS.forEach((amt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'legendary-amount-pill' + (amt === legendarySelectedAmount ? ' selected' : '');
    chip.textContent = formatBetAmount(amt);
    chip.addEventListener('click', () => { legendarySelectedAmount = amt; renderLegendaryPanel(); });
    amountRow.appendChild(chip);
  });
}

$('#sendBtn').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---------- SHARED PICTURES ----------
$('#shareImageBtn').addEventListener('click', () => {
  if (!computeCanSendMedia()) return toast("You don't have permission to share pictures in this room");
  $('#shareImageFileInput').click();
});
$('#shareImageFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow picking the same file again
  if (!file || !currentRoomId) return;
  if (!file.type.startsWith('image/')) return toast('Please choose an image file');
  if (file.size > 6 * 1024 * 1024) return toast('That image is too large (max 6MB)');
  try {
    const data = await file.arrayBuffer();
    socket.emit('send_media_message', { roomId: currentRoomId, kind: 'image', mime: file.type, data }, (ack) => {
      if (!ack || !ack.ok) toast((ack && ack.error) || 'Could not send that picture');
    });
  } catch (err) {
    toast('Could not read that image');
  }
});

// ---------- VOICE NOTES ----------
let voiceRecorder = null;
let voiceChunks = [];
$('#voiceNoteBtn').addEventListener('click', async () => {
  if (!computeCanSendMedia()) return toast("You don't have permission to send voice notes in this room");
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop(); // second click while recording = stop & send
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice notes are not supported in this browser');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
    voiceRecorder = new MediaRecorder(stream, { mimeType: mime });
    voiceChunks = [];
    voiceRecorder.addEventListener('dataavailable', (ev) => { if (ev.data.size) voiceChunks.push(ev.data); });
    voiceRecorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('#voiceNoteBtn').classList.remove('recording');
      const blob = new Blob(voiceChunks, { type: mime });
      if (!blob.size) return;
      if (blob.size > 6 * 1024 * 1024) return toast('That recording is too long (max 6MB)');
      const data = await blob.arrayBuffer();
      socket.emit('send_media_message', { roomId: currentRoomId, kind: 'voice', mime, data }, (ack) => {
        if (!ack || !ack.ok) toast((ack && ack.error) || 'Could not send that voice note');
      });
    });
    voiceRecorder.start();
    $('#voiceNoteBtn').classList.add('recording');
    toast('🎤 Recording... tap again to send');
  } catch (err) {
    toast('Microphone access was denied or unavailable');
  }
});

// ---------- EMOJI PICKER (Recent + default Emoji + Emoji Store packs + Stickers) ----------
const EMOJI_PICKER_SET = ['😀','😂','😍','😎','🥳','😢','😡','👍','👎','🙏','🔥','💯','❤️','🎉','😅','🤔','👏','🙌','😴','🤩','😱','🥰','😭','🫡','✨','💪','🎁','🌹','☕','🚀'];
const RECENT_EMOJI_KEY = 'recentEmoji';
const RECENT_EMOJI_MAX = 24;
let emojiPickerTab = 'emoji'; // 'recent' | 'emoji' | 'stickers' | `pack:${id}`
let ownedStickerPacksCache = null; // lazy-loaded, refreshed each time the Sticker Store buys something
let emojiPacksCache = null; // lazy-loaded Emoji Store packs (Staff-curated, free) — see routes/emojiPacks.js

function loadRecentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY)) || []; } catch (e) { return []; }
}
function pushRecentEmoji(text) {
  // Only single emoji are worth remembering as "recent" — a whole gift/
  // sticker glyph still works fine here since it's just a short string.
  try {
    const list = loadRecentEmoji().filter((e) => e !== text);
    list.unshift(text);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(list.slice(0, RECENT_EMOJI_MAX)));
  } catch (e) {}
}

function insertIntoChatInput(text) {
  const input = $('#chatInput');
  input.value += text;
  input.focus();
  pushRecentEmoji(text);
}

function renderEmojiPickerPopover() {
  const pop = $('#emojiPickerPopover');
  pop.innerHTML = '';

  // The tab list itself needs to know about every Emoji Store pack up
  // front (unlike Stickers, which is always a single static tab) — so
  // fetch it once before building tabs, not only when its own tab is clicked.
  if (emojiPacksCache === null) {
    emojiPacksCache = []; // placeholder so this only fires once while the request is in flight
    api('/emoji-packs').then((data) => { emojiPacksCache = data.packs; renderEmojiPickerPopover(); }).catch(() => { emojiPacksCache = []; });
  }

  const tabs = document.createElement('div');
  tabs.className = 'emoji-picker-tabs';
  const recent = loadRecentEmoji();
  const tabList = [];
  if (recent.length) tabList.push({ key: 'recent', icon: '🕐', title: 'Recent' });
  tabList.push({ key: 'emoji', icon: '😊', title: 'Emoji' });
  (emojiPacksCache || []).forEach((p) => tabList.push({ key: `pack:${p.id}`, icon: p.icon, title: p.name }));
  tabList.push({ key: 'stickers', icon: '🌟', title: 'Stickers' });

  // If the previously-active tab no longer exists (e.g. Staff just deleted
  // that pack), fall back to the default Emoji tab instead of showing blank.
  if (!tabList.some((t) => t.key === emojiPickerTab)) emojiPickerTab = 'emoji';

  tabList.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-picker-tab' + (emojiPickerTab === t.key ? ' active' : '');
    btn.textContent = t.icon;
    btn.title = t.title;
    // Stop this click from bubbling to the document-level "click outside
    // closes the popover" listener below — renderEmojiPickerPopover()
    // replaces the tab buttons' own DOM, so by the time the click bubbles
    // up, e.target is a now-detached element that reads as "outside" the
    // (rebuilt) popover and would otherwise close it on every tab switch.
    btn.addEventListener('click', (e) => { e.stopPropagation(); emojiPickerTab = t.key; renderEmojiPickerPopover(); });
    tabs.appendChild(btn);
  });
  pop.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'emoji-picker-grid';
  pop.appendChild(grid);

  function fillGrid(items, emptyMsg, titleFor) {
    if (!items || !items.length) {
      grid.innerHTML = `<div class="empty-note">${emptyMsg}</div>`;
      return;
    }
    items.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-picker-item';
      if (titleFor) btn.title = titleFor;
      btn.textContent = emoji;
      btn.addEventListener('click', () => insertIntoChatInput(emoji));
      grid.appendChild(btn);
    });
  }

  if (emojiPickerTab === 'recent') return fillGrid(recent, 'No recent emoji yet.');
  if (emojiPickerTab === 'emoji') return fillGrid(EMOJI_PICKER_SET);

  if (emojiPickerTab.startsWith('pack:')) {
    // Emoji Store pack (Staff-curated, free for everyone — see Admin Panel
    // -> Emoji Store). emojiPacksCache is already loaded by this point — the
    // fetch at the top of this function runs before the tab list (and thus
    // this tab) can even exist.
    const packId = Number(emojiPickerTab.slice(5));
    const pack = emojiPacksCache.find((p) => p.id === packId);
    return fillGrid(pack ? pack.emoji : [], 'This pack is empty.', pack ? pack.name : '');
  }

  // Stickers tab — owned packs only (bought from Explore -> Sticker Store).
  if (!ownedStickerPacksCache) {
    grid.innerHTML = '<div class="empty-note">Loading…</div>';
    api('/stickers').then((data) => {
      ownedStickerPacksCache = data.packs.filter((p) => p.owned);
      if (emojiPickerTab === 'stickers') renderEmojiPickerPopover();
    }).catch(() => { grid.innerHTML = '<div class="empty-note">Couldn\'t load stickers.</div>'; });
    return;
  }
  if (!ownedStickerPacksCache.length) {
    grid.innerHTML = '<div class="empty-note">No sticker packs yet — check out the Sticker Store in Explore.</div>';
    return;
  }
  const allOwnedStickers = [];
  ownedStickerPacksCache.forEach((pack) => pack.stickers.forEach((s) => allOwnedStickers.push(s)));
  fillGrid(allOwnedStickers);
}

$('#emojiPickerBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#emojiPickerPopover');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  renderEmojiPickerPopover();
  pop.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
  const pop = $('#emojiPickerPopover');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target.id !== 'emojiPickerBtn') {
    pop.classList.add('hidden');
  }
});

function sendChat() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !currentRoomId) return;
  socket.emit('chat_message', { roomId: currentRoomId, text });
  input.value = '';
}

// ---------- GIFTS ----------
// The in-room quick-send favorites bar has been removed — sending a gift
// from a room now always goes through the full catalog (⋮ → Send Gift), the
// same list the Gift Store (Explore hub) uses.
let allGiftsCache = [];

async function loadGifts() {
  const { gifts } = await api('/gifts');
  allGiftsCache = gifts;
}

function sendGiftFlow(gift) {
  if (!currentRoomId) return toast('Join a room first');
  const target = prompt('Send to which username?');
  if (!target) return;
  socket.emit('send_gift_by_username', { roomId: currentRoomId, toUsername: target, giftId: gift.id });
}

// Full-catalog picker, opened from the chat ⋮ menu's "Send Gift" action.
function renderSendGiftPicker(box) {
  box.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'empty-note';
  note.style.marginBottom = '8px';
  note.textContent = 'Pick a gift to send in this room.';
  box.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'gift-store-grid';
  allGiftsCache.forEach((g) => {
    const chip = document.createElement('button');
    chip.className = 'gift-chip';
    chip.innerHTML = `${g.emoji} ${g.name} (${g.cost}🪙)`;
    chip.addEventListener('click', () => sendGiftFlow(g));
    grid.appendChild(chip);
  });
  box.appendChild(grid);
}

// ---------- ACTION SHEET (⋮ button in chat) ----------
let isInvisible = false;

// Only Staff/Global Admin can actually change a room's settings or delete
// it — being the room's owner is NOT enough on its own anymore. Everyone
// else only gets a read-only view of the same screen. The ⋮ menu item and
// the sub-screen title reflect that: "Room Settings" (editable) vs
// "Room Info" (view-only).
function canManageRoom(room) {
  if (!room) return false;
  return currentUser.is_staff || currentUser.is_global_admin;
}
function roomSettingsOrInfoTitle() {
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  return canManageRoom(room) ? 'Room Settings' : 'Room Info';
}

// Read-only "Room Info" popup for anyone who isn't the room's owner or
// Staff/Global Admin (see canManageRoom above) — a compact modal instead of
// the full editable Settings/Moderators/Banned page, since none of it is
// theirs to change. Silence status reads from currentRoomSilencedUntil,
// which is only ever tracked for whichever room is currently open — safe
// here since Room Info is always opened for that same room.
function openRoomInfoModal(room) {
  if (!room) return;
  $('#roomInfoModalTitle').textContent = room.name;
  const body = $('#roomInfoModalBody');
  body.innerHTML = '';
  body.appendChild(infoRow('👑', '#f59e0b', 'Owner', room.owner_username || 'miniplatform'));
  body.appendChild(infoRow('👥', '#0891B2', 'Capacity', String(room.capacity || 0)));
  if (room.description) body.appendChild(infoRow('📄', '#8b5cf6', 'Description', room.description));
  const lockLabel = room.lock_level ? `Level ${room.lock_level} or higher required` : 'Open to all — no level restriction';
  body.appendChild(infoRow('🔒', '#f97316', 'Lock Level', lockLabel));
  const silenceLabel = currentRoomSilencedUntil && currentRoomSilencedUntil > Date.now()
    ? `Silenced until ${new Date(currentRoomSilencedUntil).toLocaleTimeString()}`
    : 'Not currently silenced';
  body.appendChild(infoRow('🔇', '#64748b', 'Room Silence', silenceLabel));

  const modLabel = document.createElement('div');
  modLabel.className = 'room-info-modal-section-label';
  modLabel.textContent = 'Moderator';
  body.appendChild(modLabel);
  const moderators = room.moderator_usernames || [];
  body.appendChild(infoRow('🔰', '#eab308', moderators.length === 1 ? 'Moderator' : 'Moderators', moderators.length ? moderators.join(', ') : 'No moderators'));

  $('#roomInfoModal').classList.remove('hidden');
}
function closeRoomInfoModal() { $('#roomInfoModal').classList.add('hidden'); }
$('#roomInfoModalCloseBtn').addEventListener('click', closeRoomInfoModal);
$('#roomInfoModal').addEventListener('click', (e) => { if (e.target === $('#roomInfoModal')) closeRoomInfoModal(); });

$('#actionSheetBtn').addEventListener('click', () => {
  $('#sheetInvisible').classList.add('hidden'); // Go Invisible now lives in the user status picker — see openStatusPicker
  const title = roomSettingsOrInfoTitle();
  $('#sheetRoomInfo').textContent = title === 'Room Settings' ? '⚙️ Room Settings' : 'ℹ️ Room Info';
  $('#actionSheetOverlay').classList.remove('hidden');
});
$('#actionSheetOverlay').addEventListener('click', (e) => {
  if (e.target === $('#actionSheetOverlay')) $('#actionSheetOverlay').classList.add('hidden');
});
$('#sheetParticipants').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  openParticipants();
});
$('#sheetRoomInfo').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  if (!currentRoomId) return toast('Join a room first');
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  if (canManageRoom(room)) {
    // Owner or Staff/Global Admin — the full editable Settings/Moderators/Banned page.
    subScreenStack = [];
    roomSettingsActiveTab = 'settings';
    pushSubScreen('Room Settings', renderRoomSettings);
  } else {
    // Everyone else — a compact read-only popup (matches iNwe's Room Info
    // card) instead of the editable tabbed page, since there's nothing here
    // for them to change.
    openRoomInfoModal(room);
  }
});
$('#sheetBalance').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  toast(`💰 Balance: ${currentUser.coins} coins`);
});
$('#sheetSendGift').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  if (!currentRoomId) return toast('Join a room first');
  subScreenStack = [];
  pushSubScreen('Send Gift', renderSendGiftPicker);
});
$('#sheetClearChat').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  $('#messages').innerHTML = '';
});
$('#sheetLeaveRoom').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  if (currentRoomId) socket.emit('leave_room', { roomId: currentRoomId });
  roomMessageCache.delete(currentRoomId); // a real leave — the next entry starts blank again
  secondaryMsgSeen.delete(currentRoomId);
  openRoomTabs = openRoomTabs.filter((r) => r.id !== currentRoomId);
  currentRoomId = null;
  clearSavedRoom();
  renderRoomTabs();
  showScreen('rooms');
});

// ---------- PARTICIPANTS PANEL ----------
// Docks the small participants card right next to the room's own floating
// chat window (#chatScreen.floating — desktop only, wherever it's currently
// sitting, default bottom-right or dragged elsewhere) instead of a fixed
// screen corner. Prefers the chat window's RIGHT side (so it never covers
// the chat itself); if there isn't room on the right it docks above instead;
// if neither fits (or there's no floating chat window at all — mobile, or
// a non-desktop layout) it falls back to the static CSS default position.
function positionParticipantsPanel() {
  const panel = $('#participantsPanel');
  // Clear any previous anchor so a stale position never lingers between opens.
  panel.style.left = '';
  panel.style.right = '';
  panel.style.top = '';
  panel.style.bottom = '';

  const chatWindow = $('#chatScreen');
  if (!isDesktopLayout() || !chatWindow || !chatWindow.classList.contains('floating')) return;

  const rect = chatWindow.getBoundingClientRect();
  const GAP = 10;
  const panelWidth = 260; // matches the CSS max-width
  const estPanelHeight = Math.min(520, window.innerHeight - 100);

  if (window.innerWidth - rect.right - GAP - panelWidth >= 8) {
    // Room to the chat window's right — dock there, top-aligned with it.
    panel.style.left = `${rect.right + GAP}px`;
    panel.style.top = `${Math.min(rect.top, window.innerHeight - estPanelHeight - 8)}px`;
  } else if (rect.top - GAP - estPanelHeight >= 8) {
    // No room on the right (chat window pushed to the screen edge) — dock
    // above it instead, left-aligned with it but never pushed off-screen.
    panel.style.left = `${Math.min(rect.left, window.innerWidth - panelWidth - 8)}px`;
    panel.style.top = `${rect.top - GAP - estPanelHeight}px`;
  }
  // Otherwise leave everything cleared — the static CSS top/right fallback applies.
}
function openParticipants() {
  renderRoomMembers(lastRoomMembers);
  positionParticipantsPanel();
  $('#participantsOverlay').classList.remove('hidden');
}
$('#closeParticipantsBtn').addEventListener('click', () => $('#participantsOverlay').classList.add('hidden'));
$('#participantsOverlay').addEventListener('click', (e) => {
  if (e.target === $('#participantsOverlay')) $('#participantsOverlay').classList.add('hidden');
});

// Render the live list of who's currently in the selected room. Read-only:
// avatar, online dot, role-colored name, level, and role badge icon — no
// action buttons. Moderation (kick/bump/ban) is done via chat commands
// (/kick, /bump, /ban, /unban) instead — see socket.js.
function renderRoomMembers(members) {
  const box = $('#participantsList');
  box.innerHTML = '';
  if (!members || !members.length) {
    box.innerHTML = '<div class="empty-note">No one here yet.</div>';
    return;
  }
  members.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'participant-row view-profile-row';
    const nameStyle = usernameStyleAttr(m);
    row.innerHTML = `
      <div class="avatar-circle small" style="background:${colorFor(m.username)}">${escapeHtml(m.username.charAt(0).toUpperCase())}</div>
      <span class="status-dot ${statusDotClass(m.status)}" title="${m.status === 'offline' ? 'Offline — still in the room' : (STATUS_LABELS[m.status] || 'Online')}"></span>
      <span class="${roleClass(m)}"${nameStyle}>${escapeHtml(m.username)}</span>
      <span class="level-badge">Lv.${m.level}</span>
      <span class="role-badge-icon">${roleIcon(m)}</span>
      ${m.invisible ? '<span class="role-badge-icon" title="Only visible to you">👻</span>' : ''}
    `;
    row.title = `View ${m.username}'s profile`;
    row.addEventListener('click', () => openUserProfile(m.username));
    box.appendChild(row);
  });
}

// ---------- ALERTS / NOTIFICATIONS ----------
// One icon + color per alert type, matching the reference notifications design.
const ALERT_TYPES = {
  level: { icon: '🔔', bg: '#eab308' },
  gift: { icon: '🎁', bg: '#ec4899' },
  coins: { icon: '🪙', bg: '#f97316' },
  system: { icon: '📣', bg: '#3b82f6' },
};

// created_at comes from SQLite's datetime('now'), which is UTC formatted as
// "YYYY-MM-DD HH:MM:SS" — browsers parse that space-separated form
// inconsistently (sometimes as local time), so normalize it to a proper
// ISO/UTC string before handing it to Date.
function parseServerDate(s) {
  return new Date(s.replace(' ', 'T') + 'Z');
}

// "21h ago" / "yesterday" / "Aug 30" on top, exact "Sep 7, 12:57 PM" below —
// matches the reference Notifications layout.
function formatAlertTime(createdAt) {
  const date = parseServerDate(createdAt);
  const now = new Date();
  const diffMin = (now - date) / 60000;

  let relative;
  if (diffMin < 1) relative = 'just now';
  else if (diffMin < 60) relative = `${Math.floor(diffMin)}m ago`;
  else if (diffMin < 60 * 24) relative = `${Math.floor(diffMin / 60)}h ago`;
  else {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    if (date >= startOfYesterday && date < startOfToday) relative = 'yesterday';
    else relative = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const exact = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return { relative, exact };
}

async function openAlerts() {
  $('#alertsOverlay').classList.remove('hidden');
  try {
    const { alerts } = await api('/alerts');
    const box = $('#alertsList');
    box.innerHTML = '';
    if (!alerts.length) {
      box.innerHTML = '<div class="empty-note">No notifications yet.</div>';
    } else {
      alerts.forEach((a) => {
        const meta = ALERT_TYPES[a.type] || ALERT_TYPES.system;
        const { relative, exact } = formatAlertTime(a.created_at);
        const row = document.createElement('div');
        row.className = 'notif-row' + (a.is_read ? '' : ' unread');
        row.innerHTML = `
          <div class="notif-icon" style="background:${meta.bg}">${meta.icon}</div>
          <div class="notif-body">
            <div class="notif-title-line">${escapeHtml(a.title || 'Notification')}</div>
            <div class="notif-desc">${escapeHtml(a.content)}</div>
          </div>
          <div class="notif-time">
            <div class="notif-relative">${escapeHtml(relative)}</div>
            <div class="notif-exact">${escapeHtml(exact)}</div>
          </div>
        `;
        row.addEventListener('click', async () => {
          if (!a.is_read) {
            await api(`/alerts/${a.id}/read`, { method: 'POST' });
            row.classList.remove('unread');
            refreshBadgeCounts();
          }
        });
        box.appendChild(row);
      });
    }
    refreshBadgeCounts();
  } catch (e) {}
}
$('#closeAlertsBtn').addEventListener('click', () => $('#alertsOverlay').classList.add('hidden'));
$('#alertsOverlay').addEventListener('click', (e) => { if (e.target === $('#alertsOverlay')) $('#alertsOverlay').classList.add('hidden'); });
$('#markAllReadBtn').addEventListener('click', async () => {
  try {
    await api('/alerts/read-all', { method: 'POST' });
    $$('#alertsList .notif-row').forEach((row) => row.classList.remove('unread'));
    refreshBadgeCounts();
    toast('All caught up!');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- EMAILS PANEL ----------
async function openEmails() {
  $('#emailsOverlay').classList.remove('hidden');
  $('#emailsThreadView').classList.add('hidden');
  $('#emailsThreadList').classList.remove('hidden');
  $('#emailsHeaderTitle').textContent = 'Emails';
  await renderEmailThreadList();
  refreshBadgeCounts();
}
async function renderEmailThreadList() {
  try {
    const { threads } = await api('/messages');
    const box = $('#emailsThreadList');
    box.innerHTML = `
      <div class="add-friend-bar">
        <input id="emailNewToInput" placeholder="Message a username..." />
        <button id="emailNewToBtn">Open</button>
      </div>`;
    if (!threads.length) {
      box.innerHTML += '<div class="empty-note">No conversations yet.</div>';
    } else {
      threads.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'thread-row';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(t.user.username)}">${escapeHtml(t.user.username.charAt(0).toUpperCase())}</div>
          <div class="thread-meta">
            <div class="thread-name">${escapeHtml(t.user.username)}</div>
            <div class="thread-last">${escapeHtml(t.lastMessage ? t.lastMessage.content : '')}</div>
          </div>
          ${t.unread ? `<span class="thread-badge">${t.unread}</span>` : ''}
        `;
        row.addEventListener('click', () => openEmailThread(t.user.username));
        box.appendChild(row);
      });
    }
    $('#emailNewToBtn').addEventListener('click', () => {
      const name = $('#emailNewToInput').value.trim();
      if (name) openEmailThread(name);
    });
  } catch (e) {}
}
async function openEmailThread(username) {
  emailsCurrentThreadUser = username;
  $('#emailsThreadList').classList.add('hidden');
  $('#emailsThreadView').classList.remove('hidden');
  $('#emailsHeaderTitle').textContent = username;
  try {
    const { messages } = await api(`/messages/${encodeURIComponent(username)}`);
    const box = $('#emailsMessages');
    box.innerHTML = '';
    messages.forEach((m) => {
      const bubble = document.createElement('div');
      bubble.className = 'email-bubble ' + (m.from_user_id === currentUser.id ? 'mine' : 'theirs');
      bubble.textContent = m.content;
      box.appendChild(bubble);
    });
    box.scrollTop = box.scrollHeight;
    refreshBadgeCounts();
  } catch (err) {
    toast(err.message);
  }
}
$('#emailsBackBtn').addEventListener('click', () => {
  $('#emailsThreadView').classList.add('hidden');
  $('#emailsThreadList').classList.remove('hidden');
  $('#emailsHeaderTitle').textContent = 'Emails';
  renderEmailThreadList();
});
$('#emailSendBtn').addEventListener('click', sendEmail);
$('#emailComposeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendEmail(); });
async function sendEmail() {
  const input = $('#emailComposeInput');
  const content = input.value.trim();
  if (!content || !emailsCurrentThreadUser) return;
  try {
    await api(`/messages/${encodeURIComponent(emailsCurrentThreadUser)}`, { method: 'POST', body: JSON.stringify({ content }) });
    input.value = '';
    openEmailThread(emailsCurrentThreadUser);
  } catch (err) {
    toast(err.message);
  }
}
$('#closeEmailsBtn').addEventListener('click', () => $('#emailsOverlay').classList.add('hidden'));
$('#emailsOverlay').addEventListener('click', (e) => { if (e.target === $('#emailsOverlay')) $('#emailsOverlay').classList.add('hidden'); });

// ---------- FRIENDS PANEL ----------
async function openFriends() {
  $('#friendsOverlay').classList.remove('hidden');
  $('#addFriendInput').value = '';
  $('#addFriendSearchResults').innerHTML = '';
  await renderFriendsPanel();
}
async function renderFriendsPanel() {
  try {
    const { friends, incoming, outgoing } = await api('/friends');

    const inBox = $('#friendsIncoming');
    inBox.innerHTML = '';
    incoming.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'friend-request-row';
      row.innerHTML = `<span>${escapeHtml(f.username)}</span>`;
      const acceptBtn = document.createElement('button');
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', async () => {
        await api(`/friends/${f.friendship_id}/accept`, { method: 'POST' });
        renderFriendsPanel(); refreshHome();
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'secondary';
      declineBtn.textContent = 'Decline';
      declineBtn.addEventListener('click', async () => {
        await api(`/friends/${f.friendship_id}/decline`, { method: 'POST' });
        renderFriendsPanel();
      });
      row.appendChild(acceptBtn);
      row.appendChild(declineBtn);
      inBox.appendChild(row);
    });

    const outBox = $('#friendsOutgoing');
    outBox.innerHTML = '';
    outgoing.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'friend-request-row';
      row.innerHTML = `<span>${escapeHtml(f.username)} (pending)</span>`;
      outBox.appendChild(row);
    });

    const accBox = $('#friendsAccepted');
    accBox.innerHTML = '';
    if (!friends.length) {
      accBox.innerHTML = '<div class="empty-note">No friends yet.</div>';
    } else {
      friends.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'friend-row';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(f.username)}">${escapeHtml(f.username.charAt(0).toUpperCase())}</div>
          <span>${escapeHtml(f.username)}</span>
          <span class="status-dot ${statusDotClass(f.status)}" title="${STATUS_LABELS[f.status] || 'Offline'}"></span>`;
        const msgBtn = document.createElement('button');
        msgBtn.className = 'secondary';
        msgBtn.textContent = '✉️';
        msgBtn.title = `Message ${f.username}`;
        msgBtn.style.marginLeft = 'auto';
        msgBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          $('#friendsOverlay').classList.add('hidden');
          openEmails();
          openEmailThread(f.username);
        });
        row.appendChild(msgBtn);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
          await api(`/friends/${f.friendship_id}`, { method: 'DELETE' });
          renderFriendsPanel(); refreshHome();
        });
        row.appendChild(removeBtn);
        accBox.appendChild(row);
      });
    }
  } catch (e) {}
}
async function sendFriendRequestTo(username) {
  try {
    await api('/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
    toast('Friend request sent');
    renderFriendsPanel();
  } catch (err) {
    toast(err.message);
  }
}
$('#addFriendBtn').addEventListener('click', async () => {
  const name = $('#addFriendInput').value.trim();
  if (!name) return;
  await sendFriendRequestTo(name);
  $('#addFriendInput').value = '';
  $('#addFriendSearchResults').innerHTML = '';
});

// Live search-as-you-type — shows each matching user's avatar, username,
// level and country (only those — no coins/bio/other profile fields belong
// here), with its own Add button, instead of requiring the exact username
// typed blind before the top Add button does anything.
let addFriendSearchTimer = null;
$('#addFriendInput').addEventListener('input', () => {
  clearTimeout(addFriendSearchTimer);
  const q = $('#addFriendInput').value.trim();
  const resultsBox = $('#addFriendSearchResults');
  if (!q) { resultsBox.innerHTML = ''; return; }
  addFriendSearchTimer = setTimeout(async () => {
    try {
      const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`);
      resultsBox.innerHTML = '';
      const others = users.filter((u) => u.username !== currentUser.username);
      if (!others.length) {
        resultsBox.innerHTML = '<div class="empty-note">No matching users.</div>';
        return;
      }
      others.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'friend-row';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(u.username)}">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
          <div class="list-row-body">
            <div class="list-row-title">${usernameHtml(u)}</div>
            <div class="list-row-subtitle">Level ${u.level}${u.country ? ` · ${countryFlag(u.country)} ${escapeHtml(u.country)}` : ''}</div>
          </div>
        `;
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add';
        addBtn.style.marginLeft = 'auto';
        addBtn.addEventListener('click', async () => {
          await sendFriendRequestTo(u.username);
          $('#addFriendInput').value = '';
          resultsBox.innerHTML = '';
        });
        row.appendChild(addBtn);
        resultsBox.appendChild(row);
      });
    } catch (err) {}
  }, 250);
});

$('#closeFriendsBtn').addEventListener('click', () => $('#friendsOverlay').classList.add('hidden'));
$('#friendsOverlay').addEventListener('click', (e) => { if (e.target === $('#friendsOverlay')) $('#friendsOverlay').classList.add('hidden'); });

// ---------- ADMIN PANEL ----------
// Staff search for a user by (partial) username instead of loading every
// account — with 1000+ registered users a full dump is both unusable and
// slow, so the table stays empty until a search is run.
function closeAdminPanel() {
  $('#adminModal').classList.add('hidden');
  lastAdminSearch = '';
  $('#adminUserSearchInput').value = '';
  $('#userTableBody').innerHTML = '';
  $('#adminSearchEmpty').textContent = 'Type a username above and press search.';
  $('#adminSearchEmpty').classList.remove('hidden');
}
$('#closeAdminBtn').addEventListener('click', closeAdminPanel);
$('#adminModal').addEventListener('click', (e) => { if (e.target.id === 'adminModal') closeAdminPanel(); });

let lastAdminSearch = '';

async function applyLevel(userId, level) {
  try {
    await api(`/admin/users/${userId}/set-level`, { method: 'POST', body: JSON.stringify({ level }) });
    toast(`Level set to ${level}`);
    runAdminSearch();
  } catch (err) {
    toast(err.message);
  }
}

// Staff-only: change ANY user's country, even if they already picked one
// themselves (normal users get exactly one pick — see POST /auth/country).
async function applyCountry(userId, country) {
  if (!country) { toast('Pick a country first'); return; }
  try {
    await api(`/admin/users/${userId}/set-country`, { method: 'POST', body: JSON.stringify({ country }) });
    toast(`Country set to ${country}`);
    runAdminSearch();
  } catch (err) {
    toast(err.message);
  }
}

function openAdminPanel() {
  if (!currentUser.is_staff) return;
  $('#userTableBody').innerHTML = '';
  $('#adminSearchEmpty').textContent = 'Type a username above and press search.';
  $('#adminSearchEmpty').classList.remove('hidden');
  $('#adminUserSearchInput').value = lastAdminSearch;
  $('#adminModal').classList.remove('hidden');
  $('#adminUserSearchInput').focus();
  if (lastAdminSearch) runAdminSearch();
  loadMinCreateLevel();
  renderAdminEmojiPacks();
}

// ---------- ADMIN PANEL: EMOJI STORE ----------
// Staff-only pack management for the free (non-purchased) emoji packs shown
// as extra tabs in the chat emoji picker — see routes/emojiPacks.js and
// renderEmojiPickerPopover() above. Every mutation here also drops the
// picker's own cache (emojiPacksCache) so the next time anyone opens the
// chat emoji picker — including this Staff member, without a page reload —
// it re-fetches and reflects the change immediately.
async function renderAdminEmojiPacks() {
  const listBox = $('#emojiPackList');
  const select = $('#addEmojiTargetPack');
  listBox.innerHTML = '<div class="empty-note">Loading…</div>';
  let packs;
  try {
    ({ packs } = await api('/emoji-packs'));
  } catch (err) {
    listBox.innerHTML = '<div class="empty-note">Couldn\'t load emoji packs.</div>';
    return;
  }

  select.innerHTML = '<option value="">— Custom (no pack) —</option>' +
    packs.map((p) => `<option value="${p.id}">${escapeHtml(p.icon)} ${escapeHtml(p.name)}</option>`).join('');

  if (!packs.length) {
    listBox.innerHTML = '<div class="empty-note">No emoji packs yet — create one below.</div>';
    return;
  }
  listBox.innerHTML = '';
  packs.forEach((pack) => {
    const card = document.createElement('div');
    card.className = 'emoji-pack-admin-card';
    const header = document.createElement('div');
    header.className = 'emoji-pack-admin-header';
    header.innerHTML = `<span>${escapeHtml(pack.icon)} <strong>${escapeHtml(pack.name)}</strong> <span style="color:var(--text-dim); font-size:12px;">(${pack.emoji.length})</span></span>`;
    const delPackBtn = document.createElement('button');
    delPackBtn.className = 'danger';
    delPackBtn.textContent = 'Delete Pack';
    delPackBtn.addEventListener('click', async () => {
      if (!confirm(`Delete the "${pack.name}" pack and all its emoji?`)) return;
      try {
        await api(`/emoji-packs/${pack.id}`, { method: 'DELETE' });
        emojiPacksCache = null;
        toast(`Deleted ${pack.name}`);
        renderAdminEmojiPacks();
      } catch (err) { toast(err.message); }
    });
    header.appendChild(delPackBtn);
    card.appendChild(header);

    const chips = document.createElement('div');
    chips.className = 'emoji-pack-admin-chips';
    pack.emoji.forEach((e) => {
      const chip = document.createElement('span');
      chip.className = 'emoji-pack-admin-chip';
      chip.innerHTML = `${escapeHtml(e)} <button type="button" title="Remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', async () => {
        try {
          await api(`/emoji-packs/${pack.id}/emoji`, { method: 'DELETE', body: JSON.stringify({ emoji: e }) });
          emojiPacksCache = null;
          renderAdminEmojiPacks();
        } catch (err) { toast(err.message); }
      });
      chips.appendChild(chip);
    });
    if (!pack.emoji.length) chips.innerHTML = '<span class="empty-note">No emoji in this pack yet.</span>';
    card.appendChild(chips);
    listBox.appendChild(card);
  });
}
$('#createEmojiPackBtn').addEventListener('click', async () => {
  const name = $('#newEmojiPackName').value.trim();
  const icon = $('#newEmojiPackIcon').value.trim();
  if (!name) return toast('Give the pack a name');
  if (!icon) return toast('Pick a tab icon (a single emoji) for the pack');
  try {
    await api('/emoji-packs', { method: 'POST', body: JSON.stringify({ name, icon }) });
    emojiPacksCache = null;
    $('#newEmojiPackName').value = '';
    $('#newEmojiPackIcon').value = '';
    toast(`Created ${name}`);
    renderAdminEmojiPacks();
  } catch (err) { toast(err.message); }
});
$('#addEmojiBtn').addEventListener('click', async () => {
  const emoji = $('#addEmojiInput').value.trim();
  const packId = $('#addEmojiTargetPack').value;
  if (!emoji) return toast('Paste an emoji first');
  try {
    await api('/emoji-packs/emoji', { method: 'POST', body: JSON.stringify({ emoji, packId: packId || undefined }) });
    emojiPacksCache = null;
    $('#addEmojiInput').value = '';
    toast('Emoji added');
    renderAdminEmojiPacks();
  } catch (err) { toast(err.message); }
});

// Staff-configurable minimum level required to create a chat room (see
// GET/POST /rooms/settings/min-create-level and the note shown in the
// Create Room modal to non-staff users below that level).
async function loadMinCreateLevel() {
  try {
    const { minLevel } = await api('/rooms/settings/min-create-level');
    $('#minCreateLevelValue').textContent = minLevel;
  } catch (err) { /* leave the last-known value showing */ }
}
$('#minCreateLevelMinus').addEventListener('click', () => {
  const el = $('#minCreateLevelValue');
  el.textContent = Math.max(0, (parseInt(el.textContent, 10) || 0) - 1);
});
$('#minCreateLevelPlus').addEventListener('click', () => {
  const el = $('#minCreateLevelValue');
  el.textContent = Math.min(9999, (parseInt(el.textContent, 10) || 0) + 1);
});
$('#saveMinCreateLevelBtn').addEventListener('click', async () => {
  const level = parseInt($('#minCreateLevelValue').textContent, 10) || 0;
  try {
    await api('/rooms/settings/min-create-level', { method: 'POST', body: JSON.stringify({ level }) });
    toast(`Room creation now requires level ${level}+`);
  } catch (err) {
    toast(err.message);
  }
});

async function runAdminSearch() {
  const q = $('#adminUserSearchInput').value.trim();
  lastAdminSearch = q;
  const tbody = $('#userTableBody');
  const empty = $('#adminSearchEmpty');
  if (!q) {
    tbody.innerHTML = '';
    empty.textContent = 'Type a username above and press search.';
    empty.classList.remove('hidden');
    return;
  }
  try {
    const { users } = await api(`/admin/users?q=${encodeURIComponent(q)}`);
    tbody.innerHTML = '';
    if (!users.length) {
      empty.textContent = `No users matching "${q}".`;
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    users.forEach((u) => {
      const tr = document.createElement('tr');
      const canPromote = !u.is_global_admin;
      let rolesHtml = '';
      if (u.is_global_admin) rolesHtml += `<span class="badge global_admin">global admin</span> `;
      if (u.is_staff) rolesHtml += `<span class="badge staff">staff</span> `;
      if (u.is_exec_board) rolesHtml += `<span class="badge exec_board">exec board</span> `;
      if (u.is_country_rep) rolesHtml += `<span class="badge country_rep">country rep</span> `;
      if (u.is_elite) rolesHtml += `<span class="badge elite">elite</span> `;
      if (u.is_mentor) rolesHtml += `<span class="badge mentor">mentor</span> `;
      if (u.is_merchant) rolesHtml += `<span class="badge merchant">merchant</span> `;
      if (!u.is_global_admin && !u.is_staff && !u.is_mentor && !u.is_merchant && !u.is_exec_board && !u.is_country_rep && !u.is_elite) rolesHtml = `<span class="badge user">user</span>`;

      const staffLocked = u.username === 'admin' || u.username === 'miniplatform';
      let actionHtml = canPromote ? `<button data-id="${u.id}" class="promote-btn">Promote to Global Admin</button>` : '';
      actionHtml += `
        <label style="display:block; font-size:12px; margin-top:4px;" title="${staffLocked ? 'This account is always Staff and this can\'t be changed' : ''}">
          <input type="checkbox" class="staff-toggle" data-id="${u.id}" ${u.is_staff ? 'checked' : ''} ${staffLocked ? 'checked disabled' : ''}/> Staff${staffLocked ? ' 🔒' : ''}
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="admin-toggle" data-id="${u.id}" ${u.is_global_admin ? 'checked' : ''}/> Global Admin
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="execboard-toggle" data-id="${u.id}" ${u.is_exec_board ? 'checked' : ''}/> Executive Board
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="countryrep-toggle" data-id="${u.id}" ${u.is_country_rep ? 'checked' : ''}/> Country Rep
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="elite-toggle" data-id="${u.id}" ${u.is_elite ? 'checked' : ''}/> Elite User
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="mentor-toggle" data-id="${u.id}" ${u.is_mentor ? 'checked' : ''}/> Mentor
        </label>
        <label style="display:block; font-size:12px;">
          <input type="checkbox" class="merchant-toggle" data-id="${u.id}" ${u.is_merchant ? 'checked' : ''}/> Merchant
        </label>`;

      const levelControl = `
        <div class="level-control">
          <button type="button" class="level-step" data-id="${u.id}" data-delta="-1" title="Level down">−</button>
          <input type="number" class="level-input" data-id="${u.id}" value="${u.level}" min="1" max="9999" />
          <button type="button" class="level-step" data-id="${u.id}" data-delta="1" title="Level up">+</button>
          <button type="button" class="level-set-btn" data-id="${u.id}">Set</button>
        </div>`;

      const countryControl = `
        <div class="level-control" style="display:flex; gap:4px;">
          <select class="country-select" data-id="${u.id}" style="max-width:140px;">
            <option value="">${u.country ? escapeHtml(u.country) : 'Not set'}</option>
            ${COUNTRIES.map(([flag, name]) => `<option value="${escapeHtml(name)}" ${name === u.country ? 'selected' : ''}>${flag} ${escapeHtml(name)}</option>`).join('')}
          </select>
          <button type="button" class="country-set-btn" data-id="${u.id}">Set</button>
        </div>`;

      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${usernameHtml(u)}</td>
        <td>${levelControl}</td>
        <td>${countryControl}</td>
        <td>${rolesHtml}</td>
        <td>${u.coins}</td>
        <td>${actionHtml || '—'}</td>
      `;
      tbody.appendChild(tr);
    });
    $$('.promote-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/admin/users/${btn.dataset.id}/promote-to-admin`, { method: 'POST' });
          toast('User promoted to Global Administrator');
          runAdminSearch();
        } catch (err) {
          toast(err.message);
        }
      });
    });
    $$('.staff-toggle, .admin-toggle, .mentor-toggle, .merchant-toggle, .execboard-toggle, .countryrep-toggle, .elite-toggle').forEach((box) => {
      box.addEventListener('change', async () => {
        const fieldByClass = {
          'staff-toggle': 'is_staff',
          'admin-toggle': 'is_global_admin',
          'mentor-toggle': 'is_mentor',
          'merchant-toggle': 'is_merchant',
          'execboard-toggle': 'is_exec_board',
          'countryrep-toggle': 'is_country_rep',
          'elite-toggle': 'is_elite',
        };
        const field = Object.keys(fieldByClass).find((c) => box.classList.contains(c));
        const body = { [fieldByClass[field]]: box.checked };
        try {
          await api(`/admin/users/${box.dataset.id}/set-flags`, { method: 'POST', body: JSON.stringify(body) });
          toast('Role updated');
          runAdminSearch();
        } catch (err) {
          toast(err.message);
        }
      });
    });
    $$('.level-step').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = document.querySelector(`.level-input[data-id="${btn.dataset.id}"]`);
        const next = Math.max(1, (Number(input.value) || 1) + Number(btn.dataset.delta));
        input.value = next;
        await applyLevel(btn.dataset.id, next);
      });
    });
    $$('.level-set-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = document.querySelector(`.level-input[data-id="${btn.dataset.id}"]`);
        const level = Math.max(1, Math.round(Number(input.value) || 1));
        await applyLevel(btn.dataset.id, level);
      });
    });
    $$('.level-input').forEach((input) => {
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') await applyLevel(input.dataset.id, Math.max(1, Math.round(Number(input.value) || 1)));
      });
    });
    $$('.country-set-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const select = document.querySelector(`.country-select[data-id="${btn.dataset.id}"]`);
        await applyCountry(btn.dataset.id, select.value);
      });
    });
  } catch (err) {
    toast(err.message);
  }
}

$('#adminUserSearchBtn').addEventListener('click', runAdminSearch);
$('#adminUserSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAdminSearch(); });

// ---------- GIVE COINS (Staff / Mentor / Merchant) ----------
let lastCoinsSearch = '';

function openGiveCoins() {
  if (!(currentUser.is_staff || currentUser.is_mentor || currentUser.is_merchant)) return;
  $('#coinsTableBody').innerHTML = '';
  $('#coinsSearchEmpty').textContent = 'Type a username above and press search.';
  $('#coinsSearchEmpty').classList.remove('hidden');
  $('#coinsUserSearchInput').value = lastCoinsSearch;
  $('#giveCoinsModal').classList.remove('hidden');
  $('#coinsUserSearchInput').focus();
  if (lastCoinsSearch) runCoinsSearch();
}
function closeGiveCoins() {
  $('#giveCoinsModal').classList.add('hidden');
  lastCoinsSearch = '';
  $('#coinsUserSearchInput').value = '';
  $('#coinsTableBody').innerHTML = '';
  $('#coinsSearchEmpty').textContent = 'Type a username above and press search.';
  $('#coinsSearchEmpty').classList.remove('hidden');
}
$('#closeGiveCoinsBtn').addEventListener('click', closeGiveCoins);
$('#giveCoinsModal').addEventListener('click', (e) => { if (e.target.id === 'giveCoinsModal') closeGiveCoins(); });

async function runCoinsSearch() {
  const q = $('#coinsUserSearchInput').value.trim();
  lastCoinsSearch = q;
  const tbody = $('#coinsTableBody');
  const empty = $('#coinsSearchEmpty');
  if (!q) {
    tbody.innerHTML = '';
    empty.textContent = 'Type a username above and press search.';
    empty.classList.remove('hidden');
    return;
  }
  try {
    const { users } = await api(`/coins/search?q=${encodeURIComponent(q)}`);
    tbody.innerHTML = '';
    if (!users.length) {
      empty.textContent = `No users matching "${q}".`;
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    // Staff can hand out much larger amounts than Mentor/Merchant — mirrors
    // the server-side cap in POST /coins/:id/give (100,000,000 for Staff or
    // Global Admin, 100,000 for everyone else who can reach this screen).
    const maxGive = (currentUser.is_staff || currentUser.is_global_admin) ? 100000000 : 100000;
    const bigPreset = maxGive >= 1000000 ? 1000000 : 10000;
    users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${usernameHtml(u)}</td>
        <td>${u.level}</td>
        <td>${u.coins}</td>
        <td>
          <div class="level-control">
            <input type="number" class="coins-amount-input" data-id="${u.id}" placeholder="Amount" min="1" max="${maxGive}" style="width:110px;" />
            <button type="button" class="give-coins-btn" data-id="${u.id}">Give</button>
            <button type="button" class="give-coins-preset-btn" data-id="${u.id}" data-amount="${bigPreset}" title="Give ${bigPreset.toLocaleString('en-US')} coins in one tap">+${bigPreset.toLocaleString('en-US')}</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
    $$('.give-coins-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const input = document.querySelector(`.coins-amount-input[data-id="${btn.dataset.id}"]`);
        const amount = Math.round(Number(input.value));
        if (!amount || amount < 1) return toast('Enter a valid amount');
        if (amount > maxGive) return toast(`Amount must be at most ${maxGive.toLocaleString('en-US')}`);
        await giveCoinsToUser(btn.dataset.id, amount);
        input.value = '';
      });
    });
    $$('.give-coins-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => giveCoinsToUser(btn.dataset.id, Number(btn.dataset.amount)));
    });
  } catch (err) {
    toast(err.message);
  }
}

async function giveCoinsToUser(userId, amount) {
  try {
    await api(`/coins/${userId}/give`, { method: 'POST', body: JSON.stringify({ amount }) });
    toast(`Gave ${amount} coins`);
    runCoinsSearch();
  } catch (err) {
    toast(err.message);
  }
}

$('#coinsUserSearchBtn').addEventListener('click', runCoinsSearch);
$('#coinsUserSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCoinsSearch(); });

// ---------- SUB-SCREEN NAVIGATION (Explore hub and everything under it) ----------
// One shared full-screen shell (#subScreenOverlay) with a back-stack, so drilling
// down (Explore -> Members -> Staff) and coming back up works generically instead
// of needing a bespoke overlay per screen.
let subScreenStack = []; // [{title, render}]

function pushSubScreen(title, render) {
  subScreenStack.push({ title, render });
  $('#subScreenOverlay').classList.remove('hidden');
  renderSubScreen();
}

function renderSubScreen() {
  const top = subScreenStack[subScreenStack.length - 1];
  if (!top) { $('#subScreenOverlay').classList.add('hidden'); return; }
  $('#subScreenTitle').textContent = top.title;
  const box = $('#subScreenContent');
  box.innerHTML = '';
  top.render(box);
}

function subScreenBack() {
  subScreenStack.pop();
  if (subScreenStack.length) renderSubScreen();
  else $('#subScreenOverlay').classList.add('hidden');
}
$('#subScreenBackBtn').addEventListener('click', subScreenBack);

// Closes the nav drawer, resets the sub-screen stack, and opens a fresh screen —
// used by every drawer item that leads into the Explore-style shell.
function openSubScreenFromDrawer(title, render) {
  closeDrawer();
  subScreenStack = [];
  pushSubScreen(title, render);
}

// iNwe-style category tile — icon, title, subtitle, "EXPLORE CATEGORY →"
// link — used in a 2-column .explore-grid instead of a flat list-row.
function exploreCard({ icon, iconBg, title, subtitle, onClick, linkLabel }) {
  const card = document.createElement('div');
  card.className = 'explore-card';
  card.innerHTML = `
    <div class="explore-card-icon" style="background:${iconBg || '#3b82f6'}22; color:${iconBg || '#3b82f6'}">${icon || '•'}</div>
    <div class="explore-card-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="explore-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    <div class="explore-card-link">${escapeHtml(linkLabel || 'EXPLORE CATEGORY')} →</div>
  `;
  if (onClick) card.addEventListener('click', onClick);
  return card;
}

function listRow({ icon, iconBg, title, subtitle, onClick, trailing }) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.innerHTML = `
    <div class="list-icon" style="background:${iconBg || '#3b82f6'}">${icon || '•'}</div>
    <div class="list-row-body">
      <div class="list-row-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="list-row-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
    ${trailing ? `<div class="list-row-trailing">${escapeHtml(String(trailing))}</div>` : '<div class="list-chevron">›</div>'}
  `;
  if (onClick) row.addEventListener('click', onClick);
  return row;
}

function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'list-section-label';
  el.textContent = text;
  return el;
}

// ---------- EXPLORE HUB ----------
function renderExplore(box) {
  const cards = [
    { icon: '📣', bg: '#3b82f6', title: 'Announcements', subtitle: 'Official news from Staff', open: () => pushSubScreen('Announcements', renderPostsScreen('announcement')) },
    { icon: '🎁', bg: '#ec4899', title: 'Gift Store', subtitle: 'Send a gift to any user', open: () => pushSubScreen('Gift Store', renderGiftStore) },
    { icon: '👥', bg: '#6366f1', title: 'Members', subtitle: 'Browse roles across the community', open: () => pushSubScreen('Members', renderMembersGroups) },
    { icon: '🏆', bg: '#eab308', title: 'Leader Board', subtitle: 'Top players by XP', open: () => pushSubScreen('Leader Board', renderLeaderboardScreen('wins')) },
    { icon: '👑', bg: '#f97316', title: 'Legendary Contest', subtitle: 'Live ranking by total spend', open: () => pushSubScreen('Legendary Contest', renderLeaderboardScreen('spend')) },
    { icon: '🎉', bg: '#22c55e', title: 'Gift Contest', subtitle: 'Live ranking by gifts sent', open: () => pushSubScreen('Gift Contest', renderLeaderboardScreen('gifts')) },
    { icon: '🎰', bg: '#8b5cf6', title: 'Daily Spin', subtitle: 'Free coins & XP every 24h', open: () => pushSubScreen('Daily Spin', renderSpin) },
    { icon: '🎨', bg: '#06b6d4', title: 'Color Shop', subtitle: 'Buy a custom username color', open: () => pushSubScreen('Color Shop', renderColorShop) },
    { icon: '🧑‍🎨', bg: '#ef4444', title: 'Avatar Maker', subtitle: 'Frame, pet & scene', open: () => pushSubScreen('Avatar Maker', renderAvatarMaker) },
    { icon: '📜', bg: '#10b981', title: 'Command List', subtitle: 'Chat commands you can use', open: () => pushSubScreen('Command List', renderCommandList) },
  ];
  if (!currentUser.is_merchant) {
    cards.push({ icon: '🧑‍💼', bg: '#0ea5e9', title: 'Become a Merchant', subtitle: 'Apply for the Merchant role', open: () => pushSubScreen('Become a Merchant', renderMerchantApply) });
  }
  if (!currentUser.is_global_admin) {
    cards.push({ icon: '🛡️', bg: '#dc2626', title: 'Become a Global Administrator', subtitle: 'Apply for Global Administrator permissions', open: () => pushSubScreen('Become a Global Administrator', renderGlobalAdminApply) });
  }
  cards.push({ icon: '🎖️', bg: '#a855f7', title: 'Badge Store', subtitle: 'Purchase and unlock unique badges', open: () => pushSubScreen('Badge Store', renderBadgeStore) });
  cards.push({ icon: '🛡️', bg: '#64748b', title: 'Badge Panel', subtitle: 'Manage and equip your earned badges', open: () => pushSubScreen('Badge Panel', renderBadgePanel) });
  cards.push({ icon: '🌟', bg: '#f43f5e', title: 'Sticker Store', subtitle: 'Browse sticker packs to use in chat', open: () => pushSubScreen('Sticker Store', renderStickerStore) });
  if (currentUser.is_staff) {
    cards.push({ icon: '🛠️', bg: '#64748b', title: 'Gift Store Admin', subtitle: 'Add, edit, or remove gifts (Staff)', open: () => pushSubScreen('Gift Store Admin', renderGiftStoreAdmin) });
    cards.push({ icon: '📋', bg: '#64748b', title: 'Merchant Applications', subtitle: 'Review pending Merchant requests (Staff)', open: () => pushSubScreen('Merchant Applications', renderMerchantApplications) });
    cards.push({ icon: '📋', bg: '#dc2626', title: 'Global Administrator Applications', subtitle: 'Review pending Global Administrator requests (Staff)', open: () => pushSubScreen('Global Administrator Applications', renderGlobalAdminApplications) });
  }
  const grid = document.createElement('div');
  grid.className = 'explore-grid';
  cards.forEach((c) => grid.appendChild(exploreCard({ icon: c.icon, iconBg: c.bg, title: c.title, subtitle: c.subtitle, onClick: c.open })));
  box.appendChild(grid);
}
function openDrawerExplore() { openSubScreenFromDrawer('Explore', renderExplore); }

// ---------- MEMBERS ----------
const MEMBER_GROUP_META = {
  exec_board: { icon: '🎖️', bg: '#6366f1' },
  global_admin: { icon: '🛡️', bg: '#facc15' },
  country_rep: { icon: '🌐', bg: '#b45309' },
  staff: { icon: '👑', bg: '#22c55e' },
  elite: { icon: '🏅', bg: '#14b8a6' },
  mentor: { icon: '🧭', bg: '#3b82f6' },
  merchant: { icon: '💼', bg: '#ec4899' },
  top_level: { icon: '⭐', bg: '#f97316' },
};

// The "Family" role directory (Executive Board, Country Representative,
// Staff, Mentor, Merchant, Elite, Top Level...) — same underlying /members
// grouping as before, rendered as iNwe-style cards instead of list rows.
async function renderMembersGroups(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { groups } = await api('/members');
    box.innerHTML = '';
    let lastSection = null;
    let grid = null;
    groups.forEach((g) => {
      if (g.section !== lastSection) {
        box.appendChild(sectionLabel(g.section.toUpperCase()));
        grid = document.createElement('div');
        grid.className = 'explore-grid';
        box.appendChild(grid);
        lastSection = g.section;
      }
      const meta = MEMBER_GROUP_META[g.key] || { icon: '👤', bg: '#64748b' };
      grid.appendChild(exploreCard({
        icon: meta.icon, iconBg: meta.bg, title: g.label, subtitle: `${g.count} member${g.count === 1 ? '' : 's'}`,
        linkLabel: 'VIEW MEMBERS',
        onClick: () => pushSubScreen(g.label, renderMembersList(g.key, g.label)),
      }));
    });
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
}

function renderMembersList(key, label) {
  return async function (box) {
    box.innerHTML = '<div class="empty-note">Loading…</div>';
    try {
      const { users } = await api(`/members/${key}`);
      box.innerHTML = '';
      if (!users.length) { box.innerHTML = `<div class="empty-note">No ${escapeHtml(label)} yet.</div>`; return; }
      users.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(u.username)}">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
          <div class="list-row-body">
            <div class="list-row-title">${usernameHtml(u)}</div>
            <div class="list-row-subtitle">Level ${u.level} · ${u.coins} 🪙</div>
          </div>
        `;
        box.appendChild(row);
      });
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    }
  };
}

// ---------- LEADERBOARDS / CONTESTS ----------
// "Contests" here are live, always-on rankings by lifetime totals — simplified
// from the reference app's time-boxed events with periodic resets/prizes.
function renderLeaderboardScreen(board) {
  return async function (box) {
    box.innerHTML = '<div class="empty-note">Loading…</div>';
    try {
      const { label, subtitle, entries } = await api(`/leaderboard/${board}`);
      box.innerHTML = '';
      box.appendChild(sectionLabel(subtitle || label));
      if (!entries.length) { box.innerHTML += '<div class="empty-note">No rankings yet — be the first!</div>'; return; }
      const medals = ['🥇', '🥈', '🥉'];
      entries.forEach((u, i) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = `
          <div class="avatar-circle small" style="background:${colorFor(u.username)}">${medals[i] || (i + 1)}</div>
          <div class="list-row-body">
            <div class="list-row-title">${usernameHtml(u)}</div>
            <div class="list-row-subtitle">Level ${u.level}</div>
          </div>
          <div class="list-row-trailing">${u.score}</div>
        `;
        box.appendChild(row);
      });
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    }
  };
}

// ---------- DAILY SPIN ----------
function formatCountdown(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

async function renderSpin(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { canSpin, secondsLeft, prizes } = await api('/spin/status');
    box.innerHTML = `
      <div class="spin-card">
        <div class="spin-emoji">🎰</div>
        <button id="spinPlayBtn" class="primary-btn" ${canSpin ? '' : 'disabled'}>${canSpin ? 'Spin Now' : 'On Cooldown'}</button>
        <div id="spinCountdown" class="spin-countdown">${canSpin ? 'Free spin ready!' : `Next spin in ${formatCountdown(secondsLeft)}`}</div>
      </div>
      <div class="list-section-label">POSSIBLE PRIZES</div>
      <div class="spin-prizes"></div>
    `;
    const prizeBox = box.querySelector('.spin-prizes');
    prizes.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'spin-prize-chip';
      chip.textContent = p.type === 'coins' ? `🪙 ${p.amount} coins` : `⚡ ${p.amount} XP`;
      prizeBox.appendChild(chip);
    });
    const btn = box.querySelector('#spinPlayBtn');
    if (canSpin) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const result = await api('/spin/play', { method: 'POST' });
          toast(result.prize.type === 'coins' ? `🪙 You won ${result.prize.amount} coins!` : `⚡ You won ${result.prize.amount} XP!`);
          renderSpin(box);
        } catch (err) {
          toast(err.message);
          renderSpin(box);
        }
      });
    } else {
      let left = secondsLeft;
      const timer = setInterval(() => {
        left -= 1;
        if (!box.isConnected) return clearInterval(timer);
        if (left <= 0) { clearInterval(timer); renderSpin(box); return; }
        const el = box.querySelector('#spinCountdown');
        if (el) el.textContent = `Next spin in ${formatCountdown(left)}`;
      }, 1000);
    }
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- COLOR SHOP ----------
async function renderColorShop(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { catalog } = await api('/colors');
    box.innerHTML = '';
    box.appendChild(sectionLabel(`YOUR COINS: ${currentUser.coins} 🪙`));

    // A purchased color is locked in for 30 days from purchase — Buy (on
    // any other color) and Reset are both disabled until it passes, so
    // buying colors can't be used to game the coin economy by flipping
    // straight back for a refund-equivalent reset.
    const lockedUntil = currentUser.username_color_locked_until ? new Date(currentUser.username_color_locked_until) : null;
    if (lockedUntil) {
      const daysLeft = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
      const lockNote = document.createElement('div');
      lockNote.className = 'color-lock-note';
      lockNote.textContent = `🔒 Your color is locked in for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} — you can switch or reset it after that.`;
      box.appendChild(lockNote);
    }

    // Staff-only: a personal 5-8 color gradient for your username, replacing
    // the fixed green/blue/red Staff gradient everyone else gets — free,
    // no Color Shop cost or lock (it's a role perk, not a purchase).
    if (currentUser.is_staff) {
      box.appendChild(sectionLabel('STAFF GRADIENT — YOUR OWN COLOR MIX'));
      const gradBox = document.createElement('div');
      gradBox.className = 'color-shop-row';
      gradBox.style.flexDirection = 'column';
      gradBox.style.alignItems = 'stretch';
      gradBox.style.gap = '8px';
      let current = [];
      try { current = currentUser.username_gradient ? JSON.parse(currentUser.username_gradient) : []; } catch (e) { current = []; }
      const preview = document.createElement('div');
      preview.style.fontWeight = '800';
      preview.style.fontSize = '18px';
      preview.className = current.length ? 'role-staff-preview' : '';
      if (current.length) {
        preview.style.backgroundImage = `linear-gradient(90deg, ${current.join(', ')})`;
        preview.style.webkitBackgroundClip = 'text';
        preview.style.backgroundClip = 'text';
        preview.style.webkitTextFillColor = 'transparent';
      }
      preview.textContent = currentUser.username;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '#22c55e, #2563eb, #ef4444, #eab308, #a855f7 (5-8 hex colors)';
      input.value = current.join(', ');
      input.style.width = '100%';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'primary-btn';
      saveBtn.textContent = 'Save gradient';
      saveBtn.addEventListener('click', async () => {
        const colors = input.value.split(',').map((c) => c.trim()).filter(Boolean);
        try {
          const { user } = await api('/colors/gradient', { method: 'POST', body: JSON.stringify({ colors }) });
          currentUser = user;
          toast('Gradient saved!');
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'secondary-btn';
      resetBtn.textContent = 'Reset to default';
      resetBtn.disabled = !current.length;
      resetBtn.addEventListener('click', async () => {
        try {
          const { user } = await api('/colors/gradient/reset', { method: 'POST' });
          currentUser = user;
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      gradBox.appendChild(preview);
      gradBox.appendChild(input);
      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.appendChild(saveBtn);
      btnRow.appendChild(resetBtn);
      gradBox.appendChild(btnRow);
      box.appendChild(gradBox);
    }

    catalog.forEach((c) => {
      const owned = currentUser.username_color === c.hex;
      const row = document.createElement('div');
      row.className = 'color-shop-row';
      row.innerHTML = `
        <div class="color-shop-swatch" style="background:${c.hex}"></div>
        <div class="list-row-body">
          <div class="list-row-title" style="color:${c.hex}">${escapeHtml(c.name)}</div>
          <div class="list-row-subtitle">
            ${currentUser.is_staff ? `
              <input type="number" class="color-price-input" data-id="${c.id}" value="${c.cost}" min="1" max="1000000" />
              <button type="button" class="color-price-save-btn" data-id="${c.id}">Save</button>
            ` : `${c.cost} 🪙`}
          </div>
        </div>
        <button class="color-buy-btn" ${owned || lockedUntil ? 'disabled' : ''}>${owned ? 'Equipped' : 'Buy'}</button>
      `;
      row.querySelector('.color-buy-btn').addEventListener('click', async () => {
        try {
          const { user } = await api(`/colors/${c.id}/buy`, { method: 'POST' });
          currentUser = user;
          updateUserBar();
          toast(`${c.name} equipped!`);
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      const saveBtn = row.querySelector('.color-price-save-btn');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const input = row.querySelector('.color-price-input');
        const cost = Math.round(Number(input.value));
        if (!cost || cost < 1) return toast('Enter a valid price');
        try {
          await api(`/colors/${c.id}/price`, { method: 'POST', body: JSON.stringify({ cost }) });
          toast(`${c.name} price updated`);
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      box.appendChild(row);
    });
    const resetRow = document.createElement('button');
    resetRow.className = 'primary-btn';
    resetRow.style.marginTop = '12px';
    resetRow.textContent = 'Reset to default color';
    resetRow.disabled = !!lockedUntil;
    resetRow.addEventListener('click', async () => {
      try {
        const { user } = await api('/colors/reset', { method: 'POST' });
        currentUser = user;
        updateUserBar();
        renderColorShop(box);
      } catch (err) {
        toast(err.message);
      }
    });
    box.appendChild(resetRow);
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- ROOM INFO ----------
// Opened from the chat screen's ⋮ action sheet. Shows the room's owner and
// moderator (if any), its live silence status, and — for whoever's allowed
// — controls to silence/unsilence the room and set/remove its moderator.
// The same actions are also reachable as chat commands (/silence <seconds>,
// /unsilence, /mod <username>, /unmod); this is just a friendlier front end
// for the same socket events (see silence_room/unsilence_room/set_moderator/
// remove_moderator in socket.js).
function infoRow(icon, iconBg, title, subtitle) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.innerHTML = `
    <div class="list-icon" style="background:${iconBg}">${icon}</div>
    <div class="list-row-body">
      <div class="list-row-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="list-row-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
  `;
  return row;
}

// Pinned banners at the top of the chat itself — who manages the room, a
// welcome message, and who's currently in it — always visible without
// opening a menu, mirroring mig66's per-room chat header. Silence/moderator
// management stays in the ⋮ → Room Info screen; this is just the always-on
// summary view of the same data.
// Pinned Announcement banner — shows/hides itself alongside the room-info
// banner (same trigger points: entering a room, switching rooms, a live
// membership update), so it's always in sync with whichever chat screen is
// on view without needing its own separate set of call sites.
function renderAnnouncementBanner() {
  const el = $('#announcementBanner');
  if (!el) return;
  if (!currentAnnouncement) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="announcement-label">📌 Announcement</span>
    <span class="announcement-text">${escapeHtml(currentAnnouncement.text)}</span>
  `;
}

// Live Broadcast flash banner — shown only for a genuinely fresh
// "/announcement" post (not the replay a joining user gets), visible across
// every screen for a few seconds then auto-hides.
let broadcastBannerTimer = null;
function showBroadcastBanner(by, text) {
  const el = $('#broadcastBanner');
  if (!el) return;
  el.innerHTML = `
    <span class="broadcast-label">📣 Broadcast</span>
    <span class="broadcast-text">📣 <b>${escapeHtml(by || 'Staff')}</b> · ${escapeHtml(text)}</span>
  `;
  el.classList.remove('hidden');
  clearTimeout(broadcastBannerTimer);
  broadcastBannerTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}

function renderRoomInfoBanner() {
  renderAnnouncementBanner();
  const banner = $('#roomInfoBanner');
  if (!banner) return;
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  if (!currentRoomId) { banner.innerHTML = ''; return; }
  if (!room) {
    // allRoomsCache is only populated by visiting Room Browser or Home —
    // someone who jumped straight into a room some other way won't have it
    // yet. Fetch it once rather than leaving the banner blank.
    banner.innerHTML = '';
    api('/rooms').then(({ rooms }) => {
      rooms.forEach((r) => {
        const idx = allRoomsCache.findIndex((x) => x.id === r.id);
        if (idx === -1) allRoomsCache.push(r); else allRoomsCache[idx] = r;
      });
      if (currentRoomId != null) renderRoomInfoBanner();
    }).catch(() => {});
    return;
  }

  const ownerName = room.owner_username || 'miniplatform';
  // "Currently in this room" should mean actually here right now — the
  // Participants panel is the place that still lists offline/logged-out
  // members (with an offline dot) since room membership itself is
  // persistent; this line is not, so it only counts online members.
  const memberNames = (lastRoomMembers || []).filter((m) => m.status !== 'offline').map((m) => m.username);
  const flag = countryFlag(room.name);
  const hasFlag = flag && flag !== '🌐';
  // Room Settings' free-text Room Description, when the owner/Staff has set
  // one, replaces the old hard-coded welcome line entirely — this is what
  // makes the banner editable per-room instead of one fixed template.
  const description = (room.description || '').trim()
    || `welcome to ${room.name}${hasFlag ? ' ' + flag : ''} ${hasFlag ? "country's" : ''} chatroom\nwe are so happy to see you here!`;
  const descLines = escapeHtml(description).split('\n');
  const descHtml = descLines.length > 1
    ? `${descLines[0]}<span class="room-banner-sub">${descLines.slice(1).join('<br>')}</span>`
    : descLines[0];

  // Once the room is actively chatting, appendMessage() flips this to true
  // (see ROOM_BANNER_COLLAPSE_AFTER) and the banner just disappears entirely
  // — no tap-to-expand, nothing pinned in place — so it never sits fixed
  // above a busy conversation. It comes back on its own next time the room
  // is (re-)entered, via the reset in enterRoom.
  const collapsed = !!roomBannerCollapsed.get(currentRoomId);
  if (collapsed) {
    banner.innerHTML = '';
    return;
  }

  banner.innerHTML = `
    <div class="room-banner-row">
      <span class="room-banner-icon">👥</span>
      <span class="room-banner-text">This room is managed by: <span class="room-banner-link">${escapeHtml(ownerName)}</span></span>
    </div>
    <div class="room-banner-row">
      <span class="room-banner-icon">🏷️</span>
      <span class="room-banner-text">${descHtml}</span>
    </div>
    <div class="room-banner-row">
      <span class="room-banner-icon">👥</span>
      <span class="room-banner-text"><b>Currently in this room:</b> ${memberNames.length ? memberNames.map((n) => `<span class="room-banner-link">${escapeHtml(n)}</span>`).join(', ') : '<span class="room-banner-sub" style="display:inline">no one yet</span>'}</span>
    </div>
  `;
}

// ---------- ROOM SETTINGS (⋮ → Room Settings) ----------
// Three tabs sharing one sub-screen: Settings (Ghost Mode, Room Description,
// Lock Level, Room Silence), Moderators (owner + add/remove), Banned
// (permanent bans + unban). Ghost Mode applies immediately on toggle;
// Description + Lock Level are staged edits saved together via the
// top-right Save link or the bottom Save Settings button.
let roomSettingsActiveTab = 'settings';

function refreshRoomSettingsIfOpen() {
  const topScreen = subScreenStack[subScreenStack.length - 1];
  if (topScreen && topScreen.render === renderRoomSettings) renderRoomSettings($('#subScreenContent'));
}

function renderRoomSettings(box) {
  const room = allRoomsCache.find((r) => r.id === currentRoomId);
  const subtitleEl = $('#subScreenSubtitle');
  const actionBtn = $('#subScreenActionBtn');

  box.innerHTML = '';
  if (!room) {
    subtitleEl.classList.add('hidden');
    actionBtn.classList.add('hidden');
    box.innerHTML = '<div class="empty-note">Room unavailable.</div>';
    return;
  }
  subtitleEl.textContent = room.name;
  subtitleEl.classList.remove('hidden');

  const moderators = room.moderator_usernames || [];
  const isModerator = moderators.includes(currentUser.username);
  const isPrivileged = currentUser.is_staff || currentUser.is_global_admin;
  // Staff/Global Admin ONLY — being the room's owner no longer grants any
  // editing rights here (description/lock level/ban/unban/moderators/delete).
  const canManageSettings = isPrivileged;
  const canManageSilence = isPrivileged || isModerator;
  const canManageMod = isPrivileged;

  const tabs = document.createElement('div');
  tabs.className = 'room-settings-tabs';
  [['settings', 'Settings'], ['moderators', 'Moderators'], ['banned', 'Banned']].forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'room-settings-tab' + (roomSettingsActiveTab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { roomSettingsActiveTab = key; renderRoomSettings(box); });
    tabs.appendChild(btn);
  });
  box.appendChild(tabs);

  const content = document.createElement('div');
  box.appendChild(content);

  if (roomSettingsActiveTab === 'settings') {
    renderRoomSettingsTab(content, room, canManageSettings, canManageSilence);
  } else if (roomSettingsActiveTab === 'moderators') {
    actionBtn.classList.add('hidden');
    renderRoomModeratorsTab(content, room, canManageMod, moderators);
  } else {
    actionBtn.classList.add('hidden');
    renderRoomBannedTab(content, room, canManageSettings);
  }
}

function renderRoomSettingsTab(content, room, canManageSettings, canManageSilence) {
  const actionBtn = $('#subScreenActionBtn');
  actionBtn.textContent = 'Save';
  actionBtn.classList.toggle('hidden', !canManageSettings);

  // Ghost Mode (join invisibly, hidden from the participant list) — same
  // Staff/Global Admin-only rule as the "Going Invisible" status option (see
  // openStatusPicker): being the room's owner alone is NOT enough, since
  // going invisible is a privileged capability, not a room-ownership one.
  const canGoGhost = currentUser.is_staff || currentUser.is_global_admin;
  if (canGoGhost) {
    const ghostCard = document.createElement('div');
    ghostCard.className = 'settings-card';
    ghostCard.innerHTML = `
      <div class="settings-card-row">
        <div>
          <div class="settings-card-title">👻 Ghost Mode</div>
          <div class="settings-card-heading">Join your room invisibly</div>
          <div class="settings-card-note">When ON you enter this room without showing in the user list. Takes effect the next time you join.</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="ghostModeToggle" ${room.my_ghost_mode ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
    `;
    content.appendChild(ghostCard);
    ghostCard.querySelector('#ghostModeToggle').addEventListener('change', (e) => {
      socket.emit('set_room_ghost_mode', { roomId: currentRoomId, ghost: e.target.checked });
    });
  }

  // Room Description — staged edit, saved with Lock Level below.
  const descCard = document.createElement('div');
  descCard.className = 'settings-card';
  descCard.innerHTML = `
    <div class="settings-card-title">📄 Room Description</div>
    <textarea class="room-desc-textarea" id="roomDescInput" maxlength="500" placeholder="Say something about this room…" ${canManageSettings ? '' : 'disabled'}>${escapeHtml(room.description || '')}</textarea>
    <div class="room-desc-count"><span id="roomDescCount">${(room.description || '').length}</span>/500</div>
  `;
  content.appendChild(descCard);
  const descInput = descCard.querySelector('#roomDescInput');
  const descCount = descCard.querySelector('#roomDescCount');
  descInput.addEventListener('input', () => { descCount.textContent = descInput.value.length; });

  // Room Capacity — Staff ONLY (narrower than canManageSettings, which also
  // includes Global Admin — see update_room_capacity in socket.js). Its own
  // Save button since it's a separate permission/socket event from
  // description+lock level below. Everyone who can see Room Settings at all
  // (Staff/Global Admin) can at least see the current capacity; only Staff
  // gets an editable input.
  const canEditCapacity = !!currentUser.is_staff;
  const capCard = document.createElement('div');
  capCard.className = 'settings-card';
  capCard.innerHTML = `
    <div class="settings-card-title">👥 Room Capacity</div>
    ${canEditCapacity
      ? `<input type="number" class="room-desc-textarea" id="roomCapacityInput" min="1" max="1000" value="${room.capacity || 25}" style="height:auto;" />`
      : `<div class="settings-card-note">${room.capacity || 25} — only Staff can change this.</div>`}
  `;
  content.appendChild(capCard);
  if (canEditCapacity) {
    const capInput = capCard.querySelector('#roomCapacityInput');
    const capBtn = document.createElement('button');
    capBtn.className = 'save-settings-btn';
    capBtn.textContent = '💾 Save Capacity';
    capBtn.addEventListener('click', () => {
      const cap = parseInt(capInput.value, 10);
      if (!Number.isFinite(cap) || cap < 1 || cap > 1000) return toast('Capacity must be between 1 and 1000');
      socket.emit('update_room_capacity', { roomId: currentRoomId, capacity: cap });
    });
    content.appendChild(capBtn);
  }

  // Lock Level — staged edit, 0-100, 0 = open to everyone.
  const lockCard = document.createElement('div');
  lockCard.className = 'settings-card';
  lockCard.innerHTML = `
    <div class="settings-card-title">🔒 Lock Level</div>
    <div class="lock-level-bar">
      <button class="lock-level-btn" id="lockLevelMinus" type="button" ${canManageSettings ? '' : 'disabled'}>−</button>
      <div class="lock-level-value" id="lockLevelValue">${room.lock_level || 0}</div>
      <button class="lock-level-btn" id="lockLevelPlus" type="button" ${canManageSettings ? '' : 'disabled'}>+</button>
    </div>
    <div id="lockLevelBadgeWrap"></div>
    <div class="settings-card-note">Enter 0 to remove lock. Max: 100.</div>
  `;
  content.appendChild(lockCard);
  const lockValueEl = lockCard.querySelector('#lockLevelValue');
  const lockBadgeWrap = lockCard.querySelector('#lockLevelBadgeWrap');
  function renderLockBadge() {
    const n = parseInt(lockValueEl.textContent, 10) || 0;
    lockBadgeWrap.innerHTML = n === 0 ? '<span class="lock-level-open-badge">🔓 Open to all — no level restriction</span>' : '';
  }
  renderLockBadge();
  lockCard.querySelector('#lockLevelMinus').addEventListener('click', () => {
    const n = Math.max(0, (parseInt(lockValueEl.textContent, 10) || 0) - 1);
    lockValueEl.textContent = n;
    renderLockBadge();
  });
  lockCard.querySelector('#lockLevelPlus').addEventListener('click', () => {
    const n = Math.min(100, (parseInt(lockValueEl.textContent, 10) || 0) + 1);
    lockValueEl.textContent = n;
    renderLockBadge();
  });

  function saveSettings() {
    socket.emit('update_room_settings', {
      roomId: currentRoomId,
      description: descInput.value,
      lockLevel: parseInt(lockValueEl.textContent, 10) || 0,
    });
  }
  actionBtn.onclick = canManageSettings ? saveSettings : null;

  if (canManageSettings) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-settings-btn';
    saveBtn.textContent = '💾 Save Settings';
    saveBtn.addEventListener('click', saveSettings);
    content.appendChild(saveBtn);
  }

  // Room Silence — kept from the earlier Room Info screen; not staged, takes
  // effect immediately like Ghost Mode.
  const silenced = !!currentRoomSilencedUntil;
  const remaining = silenced ? Math.max(0, Math.round((currentRoomSilencedUntil - Date.now()) / 1000)) : 0;
  const silenceCard = document.createElement('div');
  silenceCard.className = 'settings-card';
  silenceCard.innerHTML = `
    <div class="settings-card-title">${silenced ? '🔇' : '🔊'} Room Silence</div>
    <div class="settings-card-note">${silenced ? `Silenced — only Staff, Global Admin, the owner, and its moderators can talk — ~${remaining}s left` : 'Not currently silenced.'}</div>
  `;
  content.appendChild(silenceCard);
  if (canManageSilence) {
    const btn = document.createElement('button');
    btn.className = 'save-settings-btn';
    btn.textContent = silenced ? '🔊 Unsilence Room' : '🔇 Silence Room';
    btn.addEventListener('click', () => {
      if (silenced) {
        socket.emit('unsilence_room', { roomId: currentRoomId });
      } else {
        const secs = prompt('Silence this room for how many seconds?', '600');
        if (secs === null) return;
        const n = parseInt(secs, 10);
        if (!n || n <= 0) return toast('Enter a positive number of seconds');
        socket.emit('silence_room', { roomId: currentRoomId, seconds: n });
      }
      setTimeout(refreshRoomSettingsIfOpen, 300);
    });
    content.appendChild(btn);
  }

  // Permanently delete the room — Staff ONLY (narrower than Room Settings
  // editing/canManageSettings, which is Staff+Global Admin — Global Admin
  // does NOT get this button), and never offered for the built-in official rooms.
  if (currentUser.is_staff && !room.is_official) {
    const deleteCard = document.createElement('div');
    deleteCard.className = 'settings-card';
    deleteCard.innerHTML = `
      <div class="settings-card-title">🗑️ Delete Room</div>
      <div class="settings-card-note">Permanently deletes this room for everyone — its messages, members, moderators and bans. This cannot be undone.</div>
    `;
    content.appendChild(deleteCard);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger save-settings-btn';
    deleteBtn.textContent = '🗑️ Delete Room Permanently';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Permanently delete "${room.name}"? This cannot be undone.`)) return;
      socket.emit('delete_room', { roomId: currentRoomId });
    });
    content.appendChild(deleteBtn);
  }
}

function renderRoomModeratorsTab(content, room, canManageMod, moderators) {
  content.appendChild(infoRow('👑', '#f59e0b', 'Owner', room.owner_username || 'miniplatform'));
  content.appendChild(infoRow('🔰', '#eab308', moderators.length === 1 ? 'Moderator' : 'Moderators', moderators.length ? moderators.join(', ') : 'No moderators set'));

  if (canManageMod) {
    const modBtn = document.createElement('button');
    modBtn.className = 'save-settings-btn';
    modBtn.textContent = '🔰 Add Moderator';
    modBtn.addEventListener('click', () => {
      const uname = prompt("Username to add as this room's moderator:");
      if (!uname || !uname.trim()) return;
      socket.emit('set_moderator', { roomId: currentRoomId, username: uname.trim() });
      setTimeout(refreshRoomSettingsIfOpen, 300);
    });
    content.appendChild(modBtn);

    moderators.forEach((modUsername) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="list-icon" style="background:#eab308">🔰</div>
        <div class="list-row-body"><div class="list-row-title">${escapeHtml(modUsername)}</div></div>
      `;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        socket.emit('remove_moderator', { roomId: currentRoomId, username: modUsername });
        setTimeout(refreshRoomSettingsIfOpen, 300);
      });
      row.appendChild(removeBtn);
      content.appendChild(row);
    });
  }
}

function renderRoomBannedTab(content, room, canManageSettings) {
  content.innerHTML = '<div class="empty-note">Loading…</div>';
  socket.emit('get_room_bans', { roomId: currentRoomId }, (ack) => {
    if (!ack || !ack.ok) { content.innerHTML = '<div class="empty-note">Could not load banned users.</div>'; return; }
    content.innerHTML = '';
    if (!ack.banned.length) {
      content.appendChild(infoRow('🚫', '#64748b', 'No banned users', "Ban someone from the Participants panel's Ban button."));
      return;
    }
    ack.banned.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <div class="list-icon" style="background:#ef4444">🚫</div>
        <div class="list-row-body"><div class="list-row-title">${escapeHtml(u.username)}</div></div>
      `;
      if (canManageSettings) {
        const unbanBtn = document.createElement('button');
        unbanBtn.className = 'ban-row-remove secondary';
        unbanBtn.textContent = 'Unban';
        unbanBtn.addEventListener('click', () => {
          socket.emit('unban_user', { roomId: currentRoomId, targetUserId: u.id });
          setTimeout(refreshRoomSettingsIfOpen, 300);
        });
        row.appendChild(unbanBtn);
      }
      content.appendChild(row);
    });
  });
}

// ---------- AVATAR MAKER ----------
// Simplified from the reference app's layered outfit/scene compositor: a frame
// color + one pet emoji + one scene emoji, all free, immediately equipped.
async function renderAvatarMaker(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { frameColors, pets, scenes } = await api('/avatar/options');
    const draw = () => {
      box.innerHTML = `
        ${avatarPreviewHtml(currentUser)}
        <div class="list-section-label">FRAME COLOR</div>
        <div class="swatch-row" id="frameRow"></div>
        <div class="list-section-label">PET</div>
        <div class="swatch-row" id="petRow"></div>
        <div class="list-section-label">SCENE</div>
        <div class="swatch-row" id="sceneRow"></div>
      `;
      const frameRow = box.querySelector('#frameRow');
      frameColors.forEach((hex) => {
        const b = document.createElement('button');
        b.className = 'swatch-btn' + (currentUser.avatar_frame_color === hex ? ' selected' : '');
        b.style.background = hex;
        b.addEventListener('click', async () => { const { user } = await api('/avatar', { method: 'POST', body: JSON.stringify({ frameColor: hex }) }); currentUser = user; draw(); });
        frameRow.appendChild(b);
      });
      const petRow = box.querySelector('#petRow');
      pets.forEach((emoji) => {
        const b = document.createElement('button');
        b.className = 'emoji-btn' + (currentUser.avatar_pet === emoji ? ' selected' : '');
        b.textContent = emoji;
        b.addEventListener('click', async () => { const { user } = await api('/avatar', { method: 'POST', body: JSON.stringify({ pet: emoji }) }); currentUser = user; draw(); });
        petRow.appendChild(b);
      });
      const sceneRow = box.querySelector('#sceneRow');
      scenes.forEach((emoji) => {
        const b = document.createElement('button');
        b.className = 'emoji-btn' + (currentUser.avatar_scene === emoji ? ' selected' : '');
        b.textContent = emoji;
        b.addEventListener('click', async () => { const { user } = await api('/avatar', { method: 'POST', body: JSON.stringify({ scene: emoji }) }); currentUser = user; draw(); });
        sceneRow.appendChild(b);
      });
    };
    draw();
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- COMMAND LIST ----------
// Moderation/utility commands, shown on the "Commands" tab above the emote list.
const UTILITY_COMMANDS = [
  { cmd: '/whois <user>', desc: "Show a quick popup with a user's level, country, and online/away/busy/offline status" },
  { cmd: '/gift all <gift>', desc: 'Send a gift to everyone currently in the room' },
  { cmd: '/gift <user> <gift>', desc: 'Send a gift to one user by name' },
  { cmd: '/pick <code>', desc: 'Redeem a gift code' },
  { cmd: '/kick <user>', desc: 'Staff/Global Admin/moderator: remove a user from the room for 10 minutes' },
  { cmd: '/bump <user>', desc: 'Staff/Global Admin/moderator: remove a user from the room for 5 minutes' },
  { cmd: '/ban <user>', desc: "Staff/Global Admin/room owner: remove a user from the room until unbanned" },
  { cmd: '/unban <user>', desc: "Staff/Global Admin/room owner: lift a room ban" },
  { cmd: '/mod <user>', desc: "Room owner/Staff/Global Admin: add a room moderator" },
  { cmd: '/unmod <user>', desc: 'Remove a room moderator' },
  { cmd: '/silence <seconds>', desc: 'Staff/Global Admin/moderator: stop everyone else from typing for a while' },
  { cmd: '/unsilence', desc: 'Lift an active room silence early' },
];

// Roleplay/emote commands — kept in sync by hand with src/roleplayCommands.js
// (the actual server-side behavior); this list is for display only.
const EMOTE_COMMANDS = [
  'hi', 'hello', 'bye', 'afk', 'back', 'brb', 'gtg', 'bbl', 'sleep', 'wakeup', 'yawn',
  'agree', 'disagree', 'laugh', 'lol', 'smile', 'grin', 'cry', 'sad', 'angry', 'shock',
  'surprised', 'confused', 'blush', 'wink', 'eyeroll', 'facepalm', 'shrug', 'bored', 'sweat',
  'scared', 'proud', 'cool', 'think', 'sick', 'faint',
  'hug', 'kiss', 'slap', 'punch', 'poke', 'tickle', 'pat', 'nudge', 'highfive', 'handshake',
  'clap', 'cheer', 'dance', 'sing', 'bow', 'salute', 'pray', 'bless', 'crown', 'cuddle',
  'snuggle', 'love', 'glare', 'stare', 'wave', 'tackle', 'carry', 'spin', 'bite',
  'eat', 'drink', 'cheers', 'toast', 'party', 'smoke', 'yum',
  'act <text>',
  'aish', 'ami_beshi', 'amio_achi', 'apu_go', 'bujhini', 'charge_nai', 'dada_mane', 'dhur', 'dhivehi', 'goru',
].map((c) => ({ cmd: `/${c}`, desc: c.includes('<') ? 'Free-form custom action — post a custom third-person action line' : 'Optionally add a username to target them: e.g. /' + c.split(' ')[0] + ' username' }));

const SPECIAL_COMMANDS_LIST = [
  { cmd: '/8ball <question>', desc: 'Ask the Magic 8-Ball a yes/no question' },
  { cmd: '/coffee [username]', desc: 'Brew coffee for the room, or share one with a specific user' },
  { cmd: '/cupid <user1> [<user2>]', desc: 'Match two users (or yourself + one user) with a random compatibility %' },
  { cmd: '/findmymatch', desc: 'Official rooms only — get randomly paired with someone else currently in the room' },
  { cmd: '/flame <username>', desc: 'Playfully roast a user' },
  { cmd: '/whackit <username>', desc: 'Whack a user with a giant mallet 🔨' },
];

let commandListTab = 'commands';
function renderCommandList(box) {
  box.innerHTML = '';
  const tabs = document.createElement('div');
  tabs.className = 'command-list-tabs';
  tabs.innerHTML = `
    <button class="command-tab-btn ${commandListTab === 'commands' ? 'active' : ''}" data-tab="commands">Commands</button>
    <button class="command-tab-btn ${commandListTab === 'special' ? 'active' : ''}" data-tab="special">✨ Special</button>
  `;
  box.appendChild(tabs);

  const list = document.createElement('div');
  box.appendChild(list);

  const draw = () => {
    tabs.querySelectorAll('.command-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === commandListTab));
    list.innerHTML = '';
    const rows = commandListTab === 'special' ? SPECIAL_COMMANDS_LIST : [...UTILITY_COMMANDS, ...EMOTE_COMMANDS];
    rows.forEach((c) => list.appendChild(listRow({ icon: commandListTab === 'special' ? '✨' : '⌨️', iconBg: commandListTab === 'special' ? '#f59e0b' : '#10b981', title: c.cmd, subtitle: c.desc, trailing: ' ' })));
  };
  tabs.querySelectorAll('.command-tab-btn').forEach((b) => b.addEventListener('click', () => {
    commandListTab = b.dataset.tab;
    draw();
  }));
  draw();
}

// ---------- ANNOUNCEMENTS / BLOG (shared "posts" screen) ----------
// Resizes/compresses a picked image file to a small JPEG data URL (max 900px
// on the long edge) before it ever reaches the network — keeps a phone photo
// from blowing well past the 6mb request body limit.
function fileToCompressedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        const maxSide = 900;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPostsScreen(type) {
  const isBlog = type === 'blog';
  return async function (box) {
    box.innerHTML = '<div class="empty-note">Loading…</div>';
    const draw = async () => {
      try {
        const { posts } = await api(`/posts?type=${type}`);
        box.innerHTML = '';
        // Blog is open to every logged-in user; Announcements stay a
        // Staff-only official channel — same split the server enforces.
        const canCompose = isBlog || currentUser.is_staff;
        if (canCompose) {
          const composer = document.createElement('div');
          composer.className = 'post-composer';
          composer.innerHTML = `
            <input type="text" id="postTitleInput" placeholder="Title" maxlength="120" />
            <textarea id="postContentInput" placeholder="Write something..." rows="3" maxlength="2000"></textarea>
            ${isBlog ? `
              <input type="file" id="postImageInput" accept="image/*" class="hidden" />
              <button type="button" id="postAttachBtn" class="post-attach-btn">🖼️ Add picture</button>
              <div id="postImagePreviewWrap" class="post-image-picker hidden">
                <div class="post-image-preview-wrap">
                  <img id="postImagePreview" class="post-image-preview" />
                  <button type="button" id="postImageRemoveBtn" class="post-image-remove-btn" title="Remove picture">✕</button>
                </div>
              </div>
            ` : ''}
            <button id="postSubmitBtn" class="primary-btn">Post</button>
          `;
          let pendingImage = null;
          if (isBlog) {
            const fileInput = composer.querySelector('#postImageInput');
            const previewWrap = composer.querySelector('#postImagePreviewWrap');
            const previewImg = composer.querySelector('#postImagePreview');
            composer.querySelector('#postAttachBtn').addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', async () => {
              const file = fileInput.files && fileInput.files[0];
              if (!file) return;
              try {
                pendingImage = await fileToCompressedDataUrl(file);
                previewImg.src = pendingImage;
                previewWrap.classList.remove('hidden');
              } catch (err) {
                toast(err.message);
              } finally {
                fileInput.value = '';
              }
            });
            composer.querySelector('#postImageRemoveBtn').addEventListener('click', () => {
              pendingImage = null;
              previewWrap.classList.add('hidden');
              previewImg.src = '';
            });
          }
          composer.querySelector('#postSubmitBtn').addEventListener('click', async () => {
            const title = composer.querySelector('#postTitleInput').value.trim();
            const content = composer.querySelector('#postContentInput').value.trim();
            if (!title || !content) return toast('Title and content are required');
            try {
              const body = { type, title, content };
              if (isBlog && pendingImage) body.image = pendingImage;
              await api('/posts', { method: 'POST', body: JSON.stringify(body) });
              toast('Posted!');
              draw();
            } catch (err) {
              toast(err.message);
            }
          });
          box.appendChild(composer);
        }
        if (!posts.length) {
          // NOTE: was `box.innerHTML +=` — that re-serializes and reparses
          // every existing child (including the composer appended just above),
          // which silently destroys its Post button's click listener. Append
          // a real node instead so the composer stays wired up.
          const empty = document.createElement('div');
          empty.className = 'empty-note';
          empty.textContent = 'Nothing here yet.';
          box.appendChild(empty);
          return;
        }
        posts.forEach((p) => {
          const { relative, exact } = formatAlertTime(p.created_at);
          const row = document.createElement('div');
          row.className = 'notif-row';
          const reactionsHtml = isBlog ? `
            <div class="post-reactions">
              <button class="post-react-btn react-favorite ${p.my_reactions.includes('favorite') ? 'active' : ''}" data-id="${p.id}" data-kind="favorite">⭐ ${p.favorite_count}</button>
              <button class="post-react-btn react-like ${p.my_reactions.includes('like') ? 'active' : ''}" data-id="${p.id}" data-kind="like">👍 ${p.like_count}</button>
              <button class="post-react-btn react-dislike ${p.my_reactions.includes('dislike') ? 'active' : ''}" data-id="${p.id}" data-kind="dislike">👎 ${p.dislike_count}</button>
            </div>
          ` : '';
          row.innerHTML = `
            <div class="notif-icon" style="background:${type === 'announcement' ? '#3b82f6' : '#8b5cf6'}">${type === 'announcement' ? '📣' : '📰'}</div>
            <div class="notif-body">
              <div class="notif-title-line">${escapeHtml(p.title)}</div>
              ${isBlog ? `<div class="post-byline">by ${escapeHtml(p.created_by)}</div>` : ''}
              <div class="post-desc">${escapeHtml(p.content)}</div>
              ${p.image ? `<img class="post-body-img" src="${p.image}" alt="" />` : ''}
              ${reactionsHtml}
            </div>
            <div class="notif-time">
              <div class="notif-relative">${escapeHtml(relative)}</div>
              <div class="notif-exact">${escapeHtml(exact)}</div>
              ${(currentUser.is_staff || (isBlog && p.created_by === currentUser.username)) ? '<button class="post-delete-btn" title="Delete">🗑️</button>' : ''}
            </div>
          `;
          if (p.poll) row.querySelector('.notif-body').insertBefore(buildPollWidget(p, draw), row.querySelector('.post-reactions'));
          const delBtn = row.querySelector('.post-delete-btn');
          if (delBtn) delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await api(`/posts/${p.id}`, { method: 'DELETE' });
            draw();
          });
          if (isBlog) {
            row.querySelectorAll('.post-react-btn').forEach((btn) => {
              btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  await api(`/posts/${p.id}/react`, { method: 'POST', body: JSON.stringify({ kind: btn.dataset.kind }) });
                  draw();
                } catch (err) {
                  toast(err.message);
                }
              });
            });
          }
          box.appendChild(row);
        });
      } catch (err) {
        box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
      }
    };
    draw();
  };
}
function openDrawerBlog() { openSubScreenFromDrawer('Blog', renderPostsScreen('blog')); }

// ---------- HOME FEED ----------
// iNwe's own composer (see reference screenshot): own avatar + a single-line
// pill input for the question/status, a divider, then a "Photo/Video" and a
// "Poll" action button — no separate Post button until there's actually
// something to post. Builds a Blog post (optionally carrying an image or,
// via the Poll button, a set of poll options — see withReactions/POST
// /posts in posts.js).
function buildHomeComposer(draw) {
  const composer = document.createElement('div');
  composer.className = 'home-composer';
  composer.innerHTML = `
    <div class="home-composer-top">
      <div class="avatar-circle home-composer-avatar"></div>
      <input type="text" id="homePostContentInput" class="home-composer-input" placeholder="What's on your mind, ${escapeHtml(currentUser.username)}?" maxlength="4000" autocomplete="off" />
    </div>
    <input type="file" id="homePostImageInput" accept="image/*" class="hidden" />
    <div id="homePostImagePreviewWrap" class="post-image-picker hidden">
      <div class="post-image-preview-wrap">
        <img id="homePostImagePreview" class="post-image-preview" />
        <button type="button" id="homePostImageRemoveBtn" class="post-image-remove-btn" title="Remove picture">✕</button>
      </div>
    </div>
    <div id="homePollBuilder" class="poll-builder hidden">
      <div id="homePollOptionsList"></div>
      <button type="button" id="homePollAddOptionBtn" class="post-attach-btn">+ Add option</button>
    </div>
    <div class="home-composer-divider"></div>
    <div class="home-composer-actions">
      <button type="button" id="homePostAttachBtn" class="home-composer-action-btn">
        <span class="home-composer-action-icon photo">🖼️</span> Photo/Video
      </button>
      <button type="button" id="homePollToggleBtn" class="home-composer-action-btn">
        <span class="home-composer-action-icon poll">📊</span> Poll
      </button>
    </div>
    <button id="homePostSubmitBtn" class="primary-btn hidden">Post</button>
  `;
  paintAvatar(composer.querySelector('.home-composer-avatar'), currentUser.username);

  let pendingImage = null;
  let pollActive = false;
  const contentInput = composer.querySelector('#homePostContentInput');
  const fileInput = composer.querySelector('#homePostImageInput');
  const previewWrap = composer.querySelector('#homePostImagePreviewWrap');
  const previewImg = composer.querySelector('#homePostImagePreview');
  const pollBuilder = composer.querySelector('#homePollBuilder');
  const pollOptionsList = composer.querySelector('#homePollOptionsList');
  const pollAddOptionBtn = composer.querySelector('#homePollAddOptionBtn');
  const submitBtn = composer.querySelector('#homePostSubmitBtn');

  function refreshSubmitVisibility() {
    const hasPollOptions = pollActive && pollOptionsList.querySelectorAll('input').length > 0;
    const shouldShow = !!contentInput.value.trim() || !!pendingImage || hasPollOptions;
    submitBtn.classList.toggle('hidden', !shouldShow);
  }
  contentInput.addEventListener('input', refreshSubmitVisibility);

  function addPollOptionRow(value) {
    if (pollOptionsList.children.length >= 6) return;
    const row = document.createElement('div');
    row.className = 'poll-option-input-row';
    row.innerHTML = `
      <input type="text" class="poll-option-input" placeholder="Option ${pollOptionsList.children.length + 1}" maxlength="80" />
      <button type="button" class="poll-option-remove-btn" title="Remove option">✕</button>
    `;
    row.querySelector('.poll-option-input').value = value || '';
    row.querySelector('.poll-option-remove-btn').addEventListener('click', () => {
      if (pollOptionsList.children.length <= 2) return; // a poll always needs at least 2 options
      row.remove();
      refreshSubmitVisibility();
    });
    pollOptionsList.appendChild(row);
  }

  composer.querySelector('#homePostAttachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      pendingImage = await fileToCompressedDataUrl(file);
      previewImg.src = pendingImage;
      previewWrap.classList.remove('hidden');
      refreshSubmitVisibility();
    } catch (err) {
      toast(err.message);
    } finally {
      fileInput.value = '';
    }
  });
  composer.querySelector('#homePostImageRemoveBtn').addEventListener('click', () => {
    pendingImage = null;
    previewWrap.classList.add('hidden');
    previewImg.src = '';
    refreshSubmitVisibility();
  });

  composer.querySelector('#homePollToggleBtn').addEventListener('click', () => {
    pollActive = !pollActive;
    pollBuilder.classList.toggle('hidden', !pollActive);
    if (pollActive && !pollOptionsList.children.length) {
      addPollOptionRow('');
      addPollOptionRow('');
      contentInput.placeholder = 'Ask a question...';
    } else if (!pollActive) {
      pollOptionsList.innerHTML = '';
      contentInput.placeholder = `What's on your mind, ${currentUser.username}?`;
    }
    refreshSubmitVisibility();
  });
  pollAddOptionBtn.addEventListener('click', () => { addPollOptionRow(''); refreshSubmitVisibility(); });

  submitBtn.addEventListener('click', async () => {
    const content = contentInput.value.trim();
    if (!content) return toast(pollActive ? 'Write a poll question first' : 'Write something first');
    const body = { type: 'blog', content };
    if (pendingImage) body.image = pendingImage;
    if (pollActive) {
      const options = Array.from(pollOptionsList.querySelectorAll('.poll-option-input'))
        .map((el) => el.value.trim())
        .filter(Boolean);
      if (options.length < 2) return toast('A poll needs at least 2 options');
      body.pollOptions = options;
    }
    try {
      await api('/posts', { method: 'POST', body: JSON.stringify(body) });
      toast('Posted!');
      draw();
    } catch (err) {
      toast(err.message);
    }
  });

  return composer;
}

// Renders one poll's options as clickable bars (vote share fills in once you
// or anyone else has voted) — shared by the Home Feed and the Explore ->
// Blog screen, since a poll is stored as an ordinary Blog post (see
// withReactions in posts.js). Clicking an option votes/changes your vote;
// `onAfterVote` re-draws the caller's list so the live tally shows up.
function buildPollWidget(post, onAfterVote) {
  const { poll } = post;
  const wrap = document.createElement('div');
  wrap.className = 'poll-widget';
  const total = poll.totalVotes;
  poll.options.forEach((opt, i) => {
    const pct = total > 0 ? Math.round(((poll.votes[i] || 0) / total) * 100) : 0;
    const showResults = poll.myVote != null;
    const optBtn = document.createElement('button');
    optBtn.type = 'button';
    optBtn.className = 'poll-option' + (poll.myVote === i ? ' voted' : '');
    optBtn.innerHTML = `
      <div class="poll-option-fill" style="width:${showResults ? pct : 0}%"></div>
      <span class="poll-option-label">${escapeHtml(opt)}</span>
      ${showResults ? `<span class="poll-option-pct">${pct}%</span>` : ''}
    `;
    optBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(`/posts/${post.id}/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: i }) });
        if (onAfterVote) onAfterVote();
      } catch (err) {
        toast(err.message);
      }
    });
    wrap.appendChild(optBtn);
  });
  const totalEl = document.createElement('div');
  totalEl.className = 'poll-total';
  totalEl.textContent = `${total} vote${total === 1 ? '' : 's'}`;
  wrap.appendChild(totalEl);
  return wrap;
}

// The Home screen's Feed card (matches iNwe's home layout): the composer
// above (buildHomeComposer) posts as 'blog', above a single merged feed of
// EVERY post — announcements AND blog posts together, newest first (GET
// /posts?type=all). Announcements stay read-only here (no reactions,
// Staff-only to remove) since they're still the official Staff channel;
// only their content is shown alongside blog posts so nothing posted
// anywhere is missing from Home.
function renderHomeFeed(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  const draw = async () => {
    try {
      const { posts } = await api('/posts?type=all');
      box.innerHTML = '';

      box.appendChild(buildHomeComposer(draw));

      if (!posts.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = 'Nothing here yet — be the first to post!';
        box.appendChild(empty);
        return;
      }

      posts.forEach((p) => {
        const isBlog = p.type === 'blog';
        const { relative, exact } = formatAlertTime(p.created_at);
        const row = document.createElement('div');
        row.className = 'notif-row';
        const reactionsHtml = isBlog ? `
          <div class="post-reactions">
            <button class="post-react-btn react-favorite ${p.my_reactions.includes('favorite') ? 'active' : ''}" data-id="${p.id}" data-kind="favorite">⭐ ${p.favorite_count}</button>
            <button class="post-react-btn react-like ${p.my_reactions.includes('like') ? 'active' : ''}" data-id="${p.id}" data-kind="like">👍 ${p.like_count}</button>
            <button class="post-react-btn react-dislike ${p.my_reactions.includes('dislike') ? 'active' : ''}" data-id="${p.id}" data-kind="dislike">👎 ${p.dislike_count}</button>
          </div>
        ` : '';
        row.innerHTML = `
          <div class="notif-icon" style="background:${isBlog ? '#8b5cf6' : '#3b82f6'}">${isBlog ? '📰' : '📣'}</div>
          <div class="notif-body">
            ${!isBlog ? '<div class="post-byline">📣 Announcement</div>' : ''}
            <div class="post-byline">by ${escapeHtml(p.created_by)}</div>
            <div class="post-desc">${escapeHtml(p.content)}</div>
            ${p.image ? `<img class="post-body-img" src="${p.image}" alt="" />` : ''}
            ${reactionsHtml}
          </div>
          <div class="notif-time">
            <div class="notif-relative">${escapeHtml(relative)}</div>
            <div class="notif-exact">${escapeHtml(exact)}</div>
            ${(currentUser.is_staff || (isBlog && p.created_by === currentUser.username)) ? '<button class="post-delete-btn" title="Delete">🗑️</button>' : ''}
          </div>
        `;
        if (p.poll) row.querySelector('.notif-body').insertBefore(buildPollWidget(p, draw), row.querySelector('.post-reactions'));
        const delBtn = row.querySelector('.post-delete-btn');
        if (delBtn) delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api(`/posts/${p.id}`, { method: 'DELETE' });
          draw();
        });
        if (isBlog) {
          row.querySelectorAll('.post-react-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                await api(`/posts/${p.id}/react`, { method: 'POST', body: JSON.stringify({ kind: btn.dataset.kind }) });
                draw();
              } catch (err) {
                toast(err.message);
              }
            });
          });
        }
        box.appendChild(row);
      });
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    }
  };
  draw();
}

// ---------- GIFT STORE ----------
let giftStoreCatalog = null;
let giftStoreSelectedUser = null;
let giftStoreSelectedGift = null;

async function renderGiftStore(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  if (!giftStoreCatalog) {
    try { giftStoreCatalog = (await api('/gifts')).gifts; } catch (err) { giftStoreCatalog = []; }
  }
  giftStoreSelectedUser = null;
  giftStoreSelectedGift = null;
  box.innerHTML = `
    <div class="post-composer">
      <input type="text" id="giftStoreSearchInput" placeholder="Search a username..." />
      <div id="giftStoreSearchResults"></div>
    </div>
    <div id="giftStoreSelectedUserBox" class="empty-note">No recipient selected yet.</div>
    <div class="list-section-label">CHOOSE A GIFT</div>
    <div class="gift-store-grid" id="giftStoreGrid"></div>
    <button id="giftStoreSendBtn" class="primary-btn" style="margin-top:12px;" disabled>Send Gift</button>
  `;
  const grid = box.querySelector('#giftStoreGrid');
  giftStoreCatalog.forEach((g) => {
    const chip = document.createElement('button');
    chip.className = 'gift-chip';
    chip.textContent = `${g.emoji} ${g.name} (${g.cost}🪙)`;
    chip.addEventListener('click', () => {
      giftStoreSelectedGift = g;
      grid.querySelectorAll('.gift-chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
    });
    grid.appendChild(chip);
  });

  const input = box.querySelector('#giftStoreSearchInput');
  const results = box.querySelector('#giftStoreSearchResults');
  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = '';
        users.forEach((u) => {
          const row = document.createElement('div');
          row.className = 'list-row';
          row.innerHTML = `<div class="avatar-circle small" style="background:${colorFor(u.username)}">${escapeHtml(u.username.charAt(0).toUpperCase())}</div><div class="list-row-body"><div class="list-row-title">${usernameHtml(u)}</div></div>`;
          row.addEventListener('click', () => {
            giftStoreSelectedUser = u;
            box.querySelector('#giftStoreSelectedUserBox').outerHTML = `<div id="giftStoreSelectedUserBox" class="empty-note">Sending to: ${usernameHtml(u)}</div>`;
            results.innerHTML = '';
            input.value = '';
          });
          results.appendChild(row);
        });
      } catch (err) {}
    }, 250);
  });

  box.querySelector('#giftStoreSendBtn').disabled = false;
  box.querySelector('#giftStoreSendBtn').addEventListener('click', async () => {
    if (!giftStoreSelectedUser) return toast('Pick a recipient first');
    if (!giftStoreSelectedGift) return toast('Pick a gift first');
    try {
      const result = await api('/giftstore/send', { method: 'POST', body: JSON.stringify({ toUsername: giftStoreSelectedUser.username, giftId: giftStoreSelectedGift.id }) });
      currentUser.coins = result.coins;
      updateUserBar();
      toast(`Sent ${giftStoreSelectedGift.emoji} to ${giftStoreSelectedUser.username}!`);
      renderGiftStore(box);
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- BADGE STORE (Explore -> Badge Store) ----------
async function renderBadgeStore(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let data;
  try {
    data = await api('/badges');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'explore-grid';
  data.catalog.forEach((b) => {
    const card = exploreCard({
      icon: b.emoji, iconBg: '#a855f7',
      title: b.name,
      subtitle: b.owned ? 'Owned — manage it in Badge Panel' : `${b.cost.toLocaleString()} coins`,
      linkLabel: b.owned ? 'OWNED' : 'BUY',
      onClick: b.owned ? null : async () => {
        try {
          await api(`/badges/${b.id}/buy`, { method: 'POST' });
          toast(`Bought ${b.name}!`);
          renderBadgeStore(box);
        } catch (err) { toast(err.message); }
      },
    });
    if (b.owned) card.style.opacity = '0.6';
    grid.appendChild(card);
  });
  box.appendChild(grid);
}

// ---------- BADGE PANEL (Explore -> Badge Panel) — equip/unequip owned badges ----------
async function renderBadgePanel(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let data;
  try {
    data = await api('/badges');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  const owned = data.catalog.filter((b) => b.owned);
  box.innerHTML = '';
  if (!owned.length) {
    box.innerHTML = '<div class="empty-note">You don\'t own any badges yet — check out the Badge Store.</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'explore-grid';
  owned.forEach((b) => {
    const equipped = data.equippedBadgeId === b.id;
    const card = exploreCard({
      icon: b.emoji, iconBg: equipped ? '#22c55e' : '#64748b',
      title: b.name,
      subtitle: equipped ? 'Equipped — shown on your profile' : 'Tap to equip on your profile',
      linkLabel: equipped ? 'UNEQUIP' : 'EQUIP',
      onClick: async () => {
        try {
          const { user } = await api('/badges/equip', { method: 'POST', body: JSON.stringify({ badgeId: equipped ? null : b.id }) });
          currentUser = user;
          renderBadgePanel(box);
        } catch (err) { toast(err.message); }
      },
    });
    grid.appendChild(card);
  });
  box.appendChild(grid);
}

// ---------- STICKER STORE (Explore -> Sticker Store) ----------
async function renderStickerStore(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let data;
  try {
    data = await api('/stickers');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = '';
  data.packs.forEach((p) => {
    const section = document.createElement('div');
    section.className = 'section-card';
    section.innerHTML = `
      <div class="section-header">
        <span style="flex:1;">${escapeHtml(p.name)} — ${p.stickers.join(' ')}</span>
        <span class="count-chip">${p.owned ? 'Owned' : `${p.cost.toLocaleString()} 🪙`}</span>
      </div>
    `;
    if (!p.owned) {
      const btn = document.createElement('button');
      btn.className = 'primary-btn';
      btn.style.margin = '10px';
      btn.textContent = `Buy for ${p.cost.toLocaleString()} coins`;
      btn.addEventListener('click', async () => {
        try {
          await api(`/stickers/${p.id}/buy`, { method: 'POST' });
          toast(`Unlocked ${p.name}!`);
          ownedStickerPacksCache = null; // so the chat emoji picker's Stickers tab picks it up
          renderStickerStore(box);
        } catch (err) { toast(err.message); }
      });
      section.appendChild(btn);
    }
    box.appendChild(section);
  });
}

// ---------- BECOME A MERCHANT (Explore -> Become a Merchant) ----------
async function renderMerchantApply(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let status;
  try {
    status = await api('/merchant/status');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = '';

  if (status.isMerchant) {
    box.innerHTML = '<div class="empty-note">💼 You\'re already a Merchant.</div>';
    return;
  }
  if (status.application && status.application.status === 'pending') {
    box.innerHTML = `
      <div class="empty-note">⏳ Your application is pending review by Staff.</div>
      <div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">"${escapeHtml(status.application.message || '')}"</div></div></div>
    `;
    return;
  }

  const note = document.createElement('div');
  note.className = 'empty-note';
  note.textContent = status.application && status.application.status === 'rejected'
    ? 'Your last application was declined — you can apply again below.'
    : 'Tell Staff why you\'d like to become a Merchant, then submit.';
  box.appendChild(note);

  const composer = document.createElement('div');
  composer.className = 'post-composer';
  composer.innerHTML = `
    <textarea id="merchantApplyMessage" placeholder="Why should you become a Merchant?" maxlength="500" rows="4" style="width:100%;"></textarea>
    <button id="merchantApplySubmitBtn" class="primary-btn">Submit Application</button>
  `;
  box.appendChild(composer);
  $('#merchantApplySubmitBtn').addEventListener('click', async () => {
    const message = $('#merchantApplyMessage').value.trim();
    try {
      await api('/merchant/apply', { method: 'POST', body: JSON.stringify({ message }) });
      toast('Application submitted!');
      renderMerchantApply(box);
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- MERCHANT APPLICATIONS (Explore -> Merchant Applications, Staff only) ----------
async function renderMerchantApplications(box) {
  if (!currentUser.is_staff) { box.innerHTML = '<div class="empty-note">Staff only.</div>'; return; }
  box.innerHTML = '<div class="empty-note">Loading…</div>';

  const draw = async () => {
    let applications;
    try {
      ({ applications } = await api('/merchant/pending'));
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
      return;
    }
    box.innerHTML = '';
    if (!applications.length) {
      box.innerHTML = '<div class="empty-note">No pending applications.</div>';
      return;
    }
    applications.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      row.innerHTML = `
        <div class="list-row-title">${escapeHtml(a.username)}</div>
        <div class="list-row-subtitle">"${escapeHtml(a.message || '(no message)')}"</div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="primary-btn merchant-approve-btn" data-id="${a.id}">Approve</button>
          <button class="secondary-btn merchant-reject-btn" data-id="${a.id}">Reject</button>
        </div>
      `;
      row.querySelector('.merchant-approve-btn').addEventListener('click', async () => {
        try { await api(`/merchant/${a.id}/approve`, { method: 'POST' }); toast(`${a.username} is now a Merchant`); draw(); }
        catch (err) { toast(err.message); }
      });
      row.querySelector('.merchant-reject-btn').addEventListener('click', async () => {
        try { await api(`/merchant/${a.id}/reject`, { method: 'POST' }); toast('Application rejected'); draw(); }
        catch (err) { toast(err.message); }
      });
      box.appendChild(row);
    });
  };
  draw();
}

// ---------- BECOME A GLOBAL ADMINISTRATOR (Explore -> Become a Global Administrator) ----------
async function renderGlobalAdminApply(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let status;
  try {
    status = await api('/global-admin/status');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = '';

  if (status.isGlobalAdmin) {
    box.innerHTML = '<div class="empty-note">🛡️ You\'re already a Global Administrator.</div>';
    return;
  }
  if (status.application && status.application.status === 'pending') {
    box.innerHTML = `
      <div class="empty-note">⏳ Your application is pending review by Staff.</div>
      <div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">"${escapeHtml(status.application.message || '')}"</div></div></div>
    `;
    return;
  }

  const note = document.createElement('div');
  note.className = 'empty-note';
  note.textContent = status.application && status.application.status === 'rejected'
    ? 'Your last application was declined — you can apply again below.'
    : 'Tell Staff why you\'d like to become a Global Administrator, then submit. Approved admins instantly receive 1,000,000 coins.';
  box.appendChild(note);

  const composer = document.createElement('div');
  composer.className = 'post-composer';
  composer.innerHTML = `
    <textarea id="globalAdminApplyMessage" placeholder="Why should you become a Global Administrator?" maxlength="500" rows="4" style="width:100%;"></textarea>
    <button id="globalAdminApplySubmitBtn" class="primary-btn">Submit Application</button>
  `;
  box.appendChild(composer);
  $('#globalAdminApplySubmitBtn').addEventListener('click', async () => {
    const message = $('#globalAdminApplyMessage').value.trim();
    try {
      await api('/global-admin/apply', { method: 'POST', body: JSON.stringify({ message }) });
      toast('Application submitted!');
      renderGlobalAdminApply(box);
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- GLOBAL ADMINISTRATOR APPLICATIONS (Explore -> Global Administrator Applications, Staff only) ----------
async function renderGlobalAdminApplications(box) {
  if (!currentUser.is_staff) { box.innerHTML = '<div class="empty-note">Staff only.</div>'; return; }
  box.innerHTML = '<div class="empty-note">Loading…</div>';

  const draw = async () => {
    let applications;
    try {
      ({ applications } = await api('/global-admin/pending'));
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
      return;
    }
    box.innerHTML = '';
    if (!applications.length) {
      box.innerHTML = '<div class="empty-note">No pending applications.</div>';
      return;
    }
    applications.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      row.innerHTML = `
        <div class="list-row-title">${escapeHtml(a.username)}</div>
        <div class="list-row-subtitle">"${escapeHtml(a.message || '(no message)')}"</div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="primary-btn globaladmin-approve-btn" data-id="${a.id}">Approve</button>
          <button class="secondary-btn globaladmin-reject-btn" data-id="${a.id}">Reject</button>
        </div>
      `;
      row.querySelector('.globaladmin-approve-btn').addEventListener('click', async () => {
        try { await api(`/global-admin/${a.id}/approve`, { method: 'POST' }); toast(`${a.username} is now a Global Administrator (+1,000,000 coins)`); draw(); }
        catch (err) { toast(err.message); }
      });
      row.querySelector('.globaladmin-reject-btn').addEventListener('click', async () => {
        try { await api(`/global-admin/${a.id}/reject`, { method: 'POST' }); toast('Application rejected'); draw(); }
        catch (err) { toast(err.message); }
      });
      box.appendChild(row);
    });
  };
  draw();
}

// ---------- GIFT STORE ADMIN (Explore -> Gift Store Admin, Staff only) ----------
// Full CRUD over gifts_catalog — the same table every gift picker in the app
// (chat's Send Gift, Explore's Gift Store, favorites) reads from, so adding,
// editing, or removing a gift here shows up everywhere else right away.
async function renderGiftStoreAdmin(box) {
  if (!currentUser.is_staff) { box.innerHTML = '<div class="empty-note">Staff only.</div>'; return; }
  box.innerHTML = '<div class="empty-note">Loading…</div>';

  const draw = async () => {
    let gifts;
    try {
      gifts = (await api('/gifts')).gifts;
    } catch (err) {
      box.innerHTML = '<div class="empty-note">Couldn\'t load the gift catalog.</div>';
      return;
    }

    box.innerHTML = '';
    const composer = document.createElement('div');
    composer.className = 'post-composer';
    composer.innerHTML = `
      <input type="text" id="giftAdminEmojiInput" placeholder="Icon (emoji, e.g. 🌹)" maxlength="8" style="max-width:120px;" />
      <input type="text" id="giftAdminNameInput" placeholder="Gift name" maxlength="60" />
      <input type="number" id="giftAdminCostInput" placeholder="Price (coins)" min="1" />
      <button id="giftAdminAddBtn" class="primary-btn">Add Gift</button>
    `;
    composer.querySelector('#giftAdminAddBtn').addEventListener('click', async () => {
      const emoji = composer.querySelector('#giftAdminEmojiInput').value.trim();
      const name = composer.querySelector('#giftAdminNameInput').value.trim();
      const cost = Number(composer.querySelector('#giftAdminCostInput').value);
      if (!emoji || !name || !cost) return toast('Icon, name, and price are all required');
      try {
        await api('/gifts', { method: 'POST', body: JSON.stringify({ emoji, name, cost }) });
        toast('Gift added!');
        await loadGifts(); // refresh every other gift picker's cache
        giftStoreCatalog = null;
        draw();
      } catch (err) {
        toast(err.message);
      }
    });
    box.appendChild(composer);

    if (!gifts.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = 'No gifts in the catalog yet — add one above.';
      box.appendChild(empty);
      return;
    }

    gifts.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'notif-row';
      row.innerHTML = `
        <div class="notif-icon" style="background:#64748b;">${escapeHtml(g.emoji)}</div>
        <div class="notif-body">
          <input type="text" class="gift-admin-name" data-id="${g.id}" value="${escapeHtml(g.name)}" maxlength="60" style="width:100%; margin-bottom:4px;" />
          <div style="display:flex; gap:6px; align-items:center;">
            <input type="text" class="gift-admin-emoji" data-id="${g.id}" value="${escapeHtml(g.emoji)}" maxlength="8" style="width:60px;" />
            <input type="number" class="gift-admin-cost" data-id="${g.id}" value="${g.cost}" min="1" style="width:90px;" />
            <button type="button" class="gift-admin-save-btn" data-id="${g.id}">Save</button>
            <button type="button" class="gift-admin-delete-btn" data-id="${g.id}" title="Delete">🗑️</button>
          </div>
        </div>
      `;
      box.appendChild(row);
    });

    box.querySelectorAll('.gift-admin-save-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = box.querySelector(`.gift-admin-name[data-id="${id}"]`).value.trim();
        const emoji = box.querySelector(`.gift-admin-emoji[data-id="${id}"]`).value.trim();
        const cost = Number(box.querySelector(`.gift-admin-cost[data-id="${id}"]`).value);
        if (!name || !emoji || !cost) return toast('Icon, name, and price are all required');
        try {
          await api(`/gifts/${id}`, { method: 'PUT', body: JSON.stringify({ name, emoji, cost }) });
          toast('Gift updated');
          await loadGifts();
          giftStoreCatalog = null;
          draw();
        } catch (err) {
          toast(err.message);
        }
      });
    });
    box.querySelectorAll('.gift-admin-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/gifts/${btn.dataset.id}`, { method: 'DELETE' });
          toast('Gift removed');
          await loadGifts();
          giftStoreCatalog = null;
          draw();
        } catch (err) {
          toast(err.message);
        }
      });
    });
  };

  draw();
}

// ---------- MY PROFILE / MY ACCOUNT / SETTINGS / GAME LIST ----------
async function renderMyProfile(box) {
  const u = currentUser;
  box.innerHTML = `
    ${avatarPreviewHtml(u)}
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${usernameHtml(u)}${u.equipped_badge ? ` <span title="${escapeHtml(u.equipped_badge.name)}">${u.equipped_badge.emoji}</span>` : ''}</div><div class="list-row-subtitle">Level ${u.level} · ${u.xp} XP</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">🪙 ${u.coins} coins</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">🎁 ${u.gifts_sent_count || 0} gifts sent</div></div></div>
    <div class="list-row footprint-row" id="footprintRow"><div class="list-row-body"><div class="list-row-title">👣 Footprint</div><div class="list-row-subtitle">Who's seen your profile</div></div><div class="list-row-trailing"><span class="footprint-count-badge" id="footprintCountBadge">…</span></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${u.bio || 'No bio yet.'}</div></div></div>
    <div class="list-row"><div class="list-row-body">
      ${u.country
        ? `<div class="list-row-title">${countryFlag(u.country)} ${escapeHtml(u.country)}</div><div class="list-row-subtitle">Country is set and locked — only Staff can change it now.</div>`
        : `<div class="list-row-title">Choose your country</div>
           <div class="list-row-subtitle">You can only pick this once, so choose carefully.</div>
           <div style="display:flex; gap:6px; margin-top:6px;">
             <select id="myCountrySelect" style="flex:1;">
               <option value="">Select a country…</option>
               ${COUNTRIES.map(([flag, name]) => `<option value="${escapeHtml(name)}">${flag} ${escapeHtml(name)}</option>`).join('')}
             </select>
             <button type="button" id="myCountrySetBtn">Save</button>
           </div>`}
    </div></div>
    ${u.created_at ? `<div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">Member since ${escapeHtml(formatAlertTime(u.created_at).exact)}</div></div></div>` : ''}
  `;
  const setBtn = box.querySelector('#myCountrySetBtn');
  if (setBtn) {
    setBtn.addEventListener('click', async () => {
      const select = box.querySelector('#myCountrySelect');
      const country = select.value;
      if (!country) { toast('Pick a country first'); return; }
      try {
        const { user } = await api('/auth/country', { method: 'POST', body: JSON.stringify({ country }) });
        currentUser = user;
        toast('Country saved');
        renderMyProfile(box);
      } catch (err) {
        toast(err.message);
      }
    });
  }
  box.querySelector('#footprintRow').addEventListener('click', () => pushSubScreen('Profile Visitors', renderFootprintScreen));
  try {
    const { count } = await api('/users/me/footprint');
    const badge = box.querySelector('#footprintCountBadge');
    if (badge) badge.textContent = String(count);
  } catch (e) {}
}
function openDrawerMyProfile() { openSubScreenFromDrawer('My Profile', renderMyProfile); }
function openDrawerMyBalance() { openSubScreenFromDrawer('My Balance', renderMyBalance); }

// The list of users who've viewed My Profile (pushed on top of My Profile —
// see the footprint row above). Most-recently-viewed first.
async function renderFootprintScreen(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let visitors;
  try {
    ({ visitors } = await api('/users/me/footprint'));
  } catch (e) {
    box.innerHTML = '<div class="empty-note">Couldn\'t load your visitors.</div>';
    return;
  }
  box.innerHTML = '';
  if (!visitors.length) {
    box.innerHTML = '<div class="empty-note">No one has viewed your profile yet.</div>';
    return;
  }
  box.appendChild(sectionLabel(`SEEN YOUR PROFILE (${visitors.length})`));
  visitors.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'list-row view-profile-row';
    const nameStyle = usernameStyleAttr(v);
    row.innerHTML = `
      <div class="avatar-circle small" style="background:${colorFor(v.username)}">${escapeHtml(v.username.charAt(0).toUpperCase())}</div>
      <div class="list-row-body">
        <div class="list-row-title"><span class="${roleClass(v)}"${nameStyle}>${escapeHtml(v.username)}</span>${roleIcon(v)} <span class="status-dot ${statusDotClass(v.status)}" title="${STATUS_LABELS[v.status] || 'Offline'}"></span></div>
        <div class="list-row-subtitle">Lv.${v.level}${v.country ? ` · ${countryFlag(v.country)} ${escapeHtml(v.country)}` : ''}</div>
      </div>
      <div class="visitor-row-time">${escapeHtml(formatAlertTime(v.visited_at).relative)}</div>
    `;
    row.addEventListener('click', () => openUserProfile(v.username));
    box.appendChild(row);
  });
}

// Viewing someone ELSE's profile (tap a username in Participants, or in
// chat) — a read-only card, no footprint icon (that's only ever shown on
// your OWN My Profile). Viewing it is what leaves a footprint on THEIRS.
function openUserProfile(username) {
  if (currentUser && username.toLowerCase() === currentUser.username.toLowerCase()) {
    return openDrawerMyProfile();
  }
  pushSubScreen(username, (box) => renderUserProfile(box, username));
}

async function renderUserProfile(box, username) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let u;
  try {
    ({ user: u } = await api(`/users/${encodeURIComponent(username)}`));
  } catch (e) {
    box.innerHTML = '<div class="empty-note">User not found.</div>';
    return;
  }
  const nameStyle = usernameStyleAttr(u);
  box.innerHTML = `
    ${avatarPreviewHtml(u)}
    <div class="list-row"><div class="list-row-body">
      <div class="list-row-title"><span class="${roleClass(u)}"${nameStyle}>${escapeHtml(u.username)}</span>${roleIcon(u)} <span class="status-dot ${statusDotClass(u.status)}" title="${STATUS_LABELS[u.status] || 'Offline'}"></span>${u.equipped_badge ? ` <span title="${escapeHtml(u.equipped_badge.name)}">${u.equipped_badge.emoji}</span>` : ''}</div>
      <div class="list-row-subtitle">Level ${u.level} · ${STATUS_LABELS[u.status] || 'Offline'}</div>
    </div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">🎁 ${u.gifts_sent_count || 0} gifts sent</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${u.bio ? escapeHtml(u.bio) : 'No bio yet.'}</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${u.country ? `${countryFlag(u.country)} ${escapeHtml(u.country)}` : 'No country set'}</div></div></div>
    ${u.created_at ? `<div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">Member since ${escapeHtml(formatAlertTime(u.created_at).exact)}</div></div></div>` : ''}
  `;
}

// Category icon/label for the Activity feed and filter tabs — must match
// the categories db.logCoinTx writes server-side (games/gifts/transfers/other).
const COIN_TX_CATEGORIES = [
  { key: '', label: 'All', icon: '🪙' },
  { key: 'games', label: 'Games', icon: '🎮' },
  { key: 'gifts', label: 'Gifts', icon: '🎁' },
  { key: 'transfers', label: 'Transfers', icon: '🤝' },
  { key: 'other', label: 'Other', icon: '✨' },
];
let myBalanceActiveFilter = '';

async function renderMyBalance(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  myBalanceActiveFilter = '';

  const draw = async () => {
    let data;
    try {
      const qs = myBalanceActiveFilter ? `?category=${myBalanceActiveFilter}` : '';
      data = await api(`/coins/activity${qs}`);
    } catch (err) {
      box.innerHTML = '<div class="empty-note">Couldn\'t load your balance.</div>';
      return;
    }

    box.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'balance-card';
    card.innerHTML = `
      <div class="balance-card-label">My Balance</div>
      <div class="balance-card-amount">🪙 ${data.coins.toLocaleString()}</div>
      <div class="balance-card-sub">Coins</div>
      <div class="balance-today-row">
        <div class="balance-today-item">
          <div class="balance-today-icon earn">↑</div>
          <div>
            <div class="balance-today-value">+${data.earnedToday.toLocaleString()}</div>
            <div class="balance-today-caption">Earned today</div>
          </div>
        </div>
        <div class="balance-today-item">
          <div class="balance-today-icon spend">↓</div>
          <div>
            <div class="balance-today-value">-${data.spentToday.toLocaleString()}</div>
            <div class="balance-today-caption">Spent today</div>
          </div>
        </div>
      </div>
    `;
    box.appendChild(card);

    box.appendChild(sectionLabel(`ACTIVITY${data.activity.length ? ` (${data.activity.length})` : ''}`));

    const tabs = document.createElement('div');
    tabs.className = 'balance-filter-tabs';
    COIN_TX_CATEGORIES.forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'balance-filter-btn' + (myBalanceActiveFilter === c.key ? ' active' : '');
      btn.textContent = `${c.icon} ${c.label}`;
      btn.addEventListener('click', () => { myBalanceActiveFilter = c.key; draw(); });
      tabs.appendChild(btn);
    });
    box.appendChild(tabs);

    if (!data.activity.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = 'Nothing here yet.';
      box.appendChild(empty);
      return;
    }

    data.activity.forEach((tx) => {
      const meta = COIN_TX_CATEGORIES.find((c) => c.key === tx.category) || COIN_TX_CATEGORIES[COIN_TX_CATEGORIES.length - 1];
      const { relative, exact } = formatAlertTime(tx.created_at);
      const positive = tx.delta > 0;
      const row = document.createElement('div');
      row.className = 'notif-row';
      row.innerHTML = `
        <div class="notif-icon" style="background:${positive ? '#16a34a' : '#dc2626'}">${meta.icon}</div>
        <div class="notif-body">
          <div class="notif-title-line">${escapeHtml(tx.description)}</div>
          <div class="notif-relative">${escapeHtml(relative)} · ${escapeHtml(exact)}</div>
        </div>
        <div class="balance-tx-amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${tx.delta.toLocaleString()}</div>
      `;
      box.appendChild(row);
    });
  };

  draw();
}

function renderMyAccount(box) {
  box.innerHTML = `
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${escapeHtml(currentUser.username)}</div><div class="list-row-subtitle">Your account username</div></div></div>
    <div class="list-section-label">CHANGE PASSWORD</div>
    <div class="post-composer">
      <input type="password" id="accCurrentPw" placeholder="Current password" />
      <input type="password" id="accNewPw" placeholder="New password (min 4 characters)" />
      <button id="accChangePwBtn" class="primary-btn">Update Password</button>
    </div>
  `;
  box.querySelector('#accChangePwBtn').addEventListener('click', async () => {
    const currentPassword = box.querySelector('#accCurrentPw').value;
    const newPassword = box.querySelector('#accNewPw').value;
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      toast('Password updated');
      box.querySelector('#accCurrentPw').value = '';
      box.querySelector('#accNewPw').value = '';
    } catch (err) {
      toast(err.message);
    }
  });
}
function openDrawerMyAccount() { openSubScreenFromDrawer('My Account', renderMyAccount); }

function renderSettings(box) {
  box.innerHTML = '';

  const themeCard = document.createElement('div');
  themeCard.className = 'settings-card';
  themeCard.innerHTML = `
    <div class="settings-card-row">
      <div>
        <div class="settings-card-title">🌗 Dark Mode</div>
        <div class="settings-card-heading">Switch the app's look</div>
        <div class="settings-card-note">Light is the default. Turn this on for a dark theme instead — applies right away and remembers your choice on this device.</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="darkModeToggle" ${getStoredTheme() === 'dark' ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
  `;
  box.appendChild(themeCard);
  themeCard.querySelector('#darkModeToggle').addEventListener('change', (e) => {
    setStoredTheme(e.target.checked ? 'dark' : 'light');
  });

  box.appendChild(listRow({ icon: '🎨', iconBg: '#06b6d4', title: 'Color Shop', subtitle: 'Customize your username color', onClick: () => pushSubScreen('Color Shop', renderColorShop) }));
  box.appendChild(listRow({ icon: '🧑‍🎨', iconBg: '#ef4444', title: 'Avatar Maker', subtitle: 'Customize your avatar', onClick: () => pushSubScreen('Avatar Maker', renderAvatarMaker) }));
  box.appendChild(listRow({ icon: '🪪', iconBg: '#64748b', title: 'My Account', subtitle: 'Password & account settings', onClick: () => pushSubScreen('My Account', renderMyAccount) }));
  box.appendChild(listRow({ icon: '🚪', iconBg: '#ef4444', title: 'Logout', subtitle: 'Sign out of MiniPlatform', onClick: doLogout }));
}
function openDrawerSettings() { openSubScreenFromDrawer('Settings', renderSettings); }


$('#drawerExplore').addEventListener('click', openDrawerExplore);
$('#drawerMyProfile').addEventListener('click', openDrawerMyProfile);
$('#drawerMyBalance').addEventListener('click', openDrawerMyBalance);
$('#drawerBlog').addEventListener('click', openDrawerBlog);
$('#drawerSettings').addEventListener('click', openDrawerSettings);

// ---------- BOOTSTRAP ----------
(async function init() {
  try {
    const { user } = await api('/auth/me');
    if (user) {
      onLoggedIn(user);
    }
  } catch (e) {}
})();

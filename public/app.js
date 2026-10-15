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

// Long-press message menu (Reply/Copy/Report/Block + reactions) — see
// openMessageActionMenu() and the long-press binding in buildMessageEl().
let blockedUsernames = new Set(); // lowercased — loaded once at login, updated locally on block/unblock
let replyContext = null; // { id, username, content, type } while composing a reply, else null

async function loadBlockedUsers() {
  try {
    const { usernames } = await api('/users/blocked');
    blockedUsernames = new Set((usernames || []).map((u) => u.toLowerCase()));
  } catch (e) { /* best-effort — an empty set just means nothing is hidden yet */ }
}

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
  const escaped = escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return highlightMentions(escaped);
}

// Highlights "@username" in orange (see .chat-mention in styles.css) when
// that exact username belongs to someone actually in the room right now
// (lastRoomMembers) — never a blind "@word" match, so typing a literal "@"
// followed by something that isn't a real member's name is left as plain
// text. The viewer's own username gets the stronger "me" pill style so
// being mentioned is unmistakable at a glance — this, plus the persisted
// notification the server files for the mentioned user (see 'mention'
// alerts), is the "notify the user mentioned" behavior.
function highlightMentions(html) {
  if (!lastRoomMembers || !lastRoomMembers.length) return html;
  const byLower = new Map(lastRoomMembers.map((m) => [m.username.toLowerCase(), m.username]));
  return html.replace(/@([A-Za-z0-9_.-]+)/g, (match, name) => {
    const real = byLower.get(name.toLowerCase());
    if (!real) return match;
    const isMe = currentUser && real.toLowerCase() === currentUser.username.toLowerCase();
    return `<span class="chat-mention${isMe ? ' me' : ''}">@${escapeHtml(real)}</span>`;
  });
}

// Gift chat lines ("<<sender [15] gives a Rose 🌹 to recipient [22]!>>") get
// two small touches to match the reference's bold pink gift announcements:
// the "[level]" brackets pop in gold instead of blending into the pink, and
// the gift's own emoji renders noticeably larger, like an inline sticker,
// instead of plain inline text size.
// Regional-indicator pairs (🇸🇩, 🇺🇸, ...) make up most of the gift catalog
// (country-flag gifts) but aren't \p{Extended_Pictographic} themselves, so
// they're matched as their own alternative alongside normal pictographs.
const EMOJI_RUN_RE = /(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*)/gu;
function styleGiftText(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/\[(\d+)\]/g, '<span class="gift-level">[$1]</span>');
  html = html.replace(EMOJI_RUN_RE, '<span class="gift-emoji-inline">$1</span>');
  return html;
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
  // A real uploaded profile photo (Avatar Maker -> Upload photo) takes over
  // the whole circle in place of the colored-initial/scene/pet look — the
  // frame color ring and the Pet badge (now floating on the photo's corner
  // instead of replacing it) still apply, since those are independent picks.
  if (u.avatar_photo_url) {
    return `
      <div class="avatar-maker-preview" style="border-color:${u.avatar_frame_color || '#3b82f6'}">
        <div class="avatar-circle avatar-circle-photo" style="background-image:url('${escapeHtml(u.avatar_photo_url)}')">
          ${u.avatar_pet ? `<span class="avatar-circle-pet-badge">${u.avatar_pet}</span>` : ''}
        </div>
      </div>
    `;
  }
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

// Admin Panel -> Create User country picker, same fixed catalog, "No
// country" is a valid (optional) choice here unlike the Register form.
(function populateCreateUserCountry() {
  const select = $('#createUserCountry');
  if (!select) return;
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
  loadBlockedUsers();
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

// ---------- COLOR SHOP (tiered redesign) ----------
// Mirrors src/colorCatalog.js's COLOR_TIERS and src/routes/colors.js's
// ROLE_COLOR_DEFS — kept as a client-side copy (same pattern as EFFECT_THEME
// mirroring src/effectsCatalog.js) so a chat message or participant row can
// render a username's color + little round badge instantly, without a round
// trip to the Color Shop API just to look up what a tier's icon/ring is.
const COLOR_TIERS = {
  king: { name: 'King', hex: '#22d3ee', ring1: '#22d3ee', ring2: '#0e7490', icon: '👑', bold: true },
  queen: { name: 'Queen', hex: '#f472b6', ring1: '#f472b6', ring2: '#be185d', icon: '👑', bold: true },
  mafia: { name: 'Mafia', hex: '#fb7185', ring1: '#fb7185', ring2: '#9f1239', icon: '🎩', bold: false },
  vip: { name: 'Vip', hex: '#fb7185', ring1: '#fb7185', ring2: '#be123c', icon: '🏅', bold: true },
  diamond: { name: 'Diamond', hex: '#38bdf8', ring1: '#38bdf8', ring2: '#0369a1', icon: '💎', bold: false },
  premium: { name: 'Premium', hex: '#facc15', ring1: '#facc15', ring2: '#a16207', icon: '🅿️', bold: true },
  supporter: { name: 'Supporter', hex: '#38bdf8', ring1: '#38bdf8', ring2: '#1d4ed8', icon: '🆂', bold: false },
  streamer: { name: 'Streamer', hex: '#fb7185', ring1: '#fb7185', ring2: '#86198f', icon: '🎥', bold: false },
};
// Priority order for the AUTOMATIC default when active_color_key is NULL —
// same order roleClass()/roleIcon() always used. Staff is excluded — it's
// handled separately (gradient, always wins, see resolveActiveColor below).
const ROLE_COLOR_DEFS = [
  { key: 'exec_board', flag: 'is_exec_board', name: 'Executive Board', hex: '#6366f1', ring1: '#6366f1', ring2: '#4338ca', icon: '🎖️' },
  { key: 'global_admin', flag: 'is_global_admin', name: 'Global Admin', hex: '#facc15', ring1: '#facc15', ring2: '#a16207', icon: '🛡️' },
  // Room moderator — not a real account-level "owned color" (it's granted
  // per-room, see is_room_moderator elsewhere), so it's never listed in the
  // Color Shop's "My Owned Colors" or toggleable; it only ever applies via
  // the automatic-default fallback below, at the same priority slot the
  // original roleClass()/roleIcon() always gave it (between Global Admin
  // and Country Rep).
  { key: 'moderator', flag: 'is_moderator', name: 'Moderator', hex: '#facc15', ring1: '#facc15', ring2: '#a16207', icon: '🔰' },
  { key: 'country_rep', flag: 'is_country_rep', name: 'Country Rep', hex: '#b45309', ring1: '#b45309', ring2: '#78350f', icon: '🌐' },
  { key: 'elite', flag: 'is_elite', name: 'Elite', hex: '#14b8a6', ring1: '#14b8a6', ring2: '#0f766e', icon: '🏅' },
  { key: 'mentor', flag: 'is_mentor', name: 'Mentor', hex: '#ef4444', ring1: '#ef4444', ring2: '#b91c1c', icon: '🧭' },
  { key: 'merchant', flag: 'is_merchant', name: 'Merchant', hex: '#a855f7', ring1: '#a855f7', ring2: '#7e22ce', icon: '🅼' },
];

// The single source of truth for "what color/badge is this user showing
// right now" — used by roleClass()/usernameStyleAttr()/roleIcon() below so
// every existing call site (chat, participants, whois, leaderboards, ...)
// picks up the new tiered/role system automatically, with zero call-site
// changes. Resolution order: 1) Staff gradient/color always wins — can't be
// bought or toggled over. 2) u.active_color_key, if it still points at
// something the user actually holds (a role flag that's still true, or an
// unexpired purchased tier — we trust the server's snapshot here rather
// than re-checking expiry client-side). 3) Automatic default — the
// highest-priority held role. 4) A legacy flat username_color from the old
// single-color shop, if still set. 5) Nothing special.
function resolveActiveColor(u) {
  if (u.is_staff) return null; // handled by the existing Staff-gradient path in usernameStyleAttr/roleClass
  if (u.active_color_key) {
    const tier = COLOR_TIERS[u.active_color_key];
    if (tier) return { kind: 'purchased', key: u.active_color_key, ...tier };
    const roleDef = ROLE_COLOR_DEFS.find((d) => d.key === u.active_color_key);
    if (roleDef && u[roleDef.flag]) {
      const name = roleDef.key === 'elite' && (u.gender === 'male' || u.gender === 'female')
        ? `Elite ${u.gender === 'male' ? 'Male' : 'Female'}` : roleDef.name;
      return { kind: 'role', key: roleDef.key, name, hex: roleDef.hex, ring1: roleDef.ring1, ring2: roleDef.ring2, icon: roleDef.icon, bold: true };
    }
  }
  const topRole = ROLE_COLOR_DEFS.find((d) => u[d.flag]);
  if (topRole) {
    const name = topRole.key === 'elite' && (u.gender === 'male' || u.gender === 'female')
      ? `Elite ${u.gender === 'male' ? 'Male' : 'Female'}` : topRole.name;
    return { kind: 'role', key: topRole.key, name, hex: topRole.hex, ring1: topRole.ring1, ring2: topRole.ring2, icon: topRole.icon, bold: true };
  }
  if (u.username_color) return { kind: 'legacy', key: null, name: 'Custom color', hex: u.username_color, ring1: u.username_color, ring2: u.username_color, icon: null, bold: false };
  return null;
}

// Small round badge shown right after a username (chat, participants,
// whois, leaderboards, profile) — a colored ring matching the active
// color's tier/role, with its icon/emoji centered inside. Returns '' when
// there's nothing to show (plain user, no active color).
function colorBadgeHtml(u) {
  const active = resolveActiveColor(u);
  if (!active || !active.icon) return '';
  return `<span class="color-badge" title="${escapeHtml(active.name)}" style="background:linear-gradient(135deg, ${active.ring1}, ${active.ring2}); border-color:${active.ring1}">${active.icon}</span>`;
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
  return ''; // every other role/purchased color now renders via usernameStyleAttr's inline style, not a CSS class
}

function roleIcon(u) {
  if (u.is_staff) return ' 👑';
  return colorBadgeHtml(u);
}

// Inline style="" for a rendered username, in priority order:
// 1) A Staff member's own custom multi-color gradient (username_gradient —
//    5 to 8 hex colors picked in Settings -> Color Shop -> Staff Gradient),
//    which overrides the default 3-color green/blue/red .role-staff CSS
//    gradient with their personal mix.
// 2) The resolved active color (role or purchased tier, or a legacy flat
//    username_color) from resolveActiveColor() above.
function usernameStyleAttr(u) {
  if (u.is_staff && u.username_gradient) {
    let colors = null;
    try { colors = JSON.parse(u.username_gradient); } catch (e) { /* ignore malformed value */ }
    if (Array.isArray(colors) && colors.length >= 2) {
      const stops = colors.map((c) => escapeHtml(c)).join(', ');
      return ` style="background-image:linear-gradient(90deg, ${stops});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;"`;
    }
  }
  const active = !u.is_staff ? resolveActiveColor(u) : null;
  if (active) {
    return ` style="color:${escapeHtml(active.hex)}${active.bold ? ';font-weight:800' : ''}"`;
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

// A companion rank badge that visibly grows as you level up — shown in the
// Level screen's ring (in place of a static icon) plus its own "Galaxy
// Rank" strip of stages, locked ones greyed out. Each stage gets its own
// gradient badge (rendered as a circular background behind the emoji)
// instead of a CSS filter tint on a repeated icon, so every tier reads as
// a visually distinct rank at a glance.
const GROWTH_STAGES = [
  { min: 1, max: 5, name: 'Meteor', icon: '☄️', grad: 'linear-gradient(135deg,#cbd5e1,#64748b)' },
  { min: 6, max: 10, name: 'Comet', icon: '💫', grad: 'linear-gradient(135deg,#bae6fd,#0284c7)' },
  { min: 11, max: 20, name: 'Satellite', icon: '🛰️', grad: 'linear-gradient(135deg,#e0e7ff,#4f46e5)' },
  { min: 21, max: 30, name: 'Rocket', icon: '🚀', grad: 'linear-gradient(135deg,#fecaca,#dc2626)' },
  { min: 31, max: 40, name: 'Star Cruiser', icon: '🛸', grad: 'linear-gradient(135deg,#99f6e4,#0d9488)' },
  { min: 41, max: 50, name: 'Star', icon: '🌟', grad: 'linear-gradient(135deg,#fde68a,#f59e0b)' },
  { min: 51, max: 60, name: 'Pulsar', icon: '⚡', grad: 'linear-gradient(135deg,#ddd6fe,#7c3aed)' },
  { min: 61, max: 70, name: 'Supernova', icon: '💥', grad: 'linear-gradient(135deg,#fed7aa,#ea580c)' },
  { min: 71, max: 80, name: 'Nebula', icon: '🌌', grad: 'linear-gradient(135deg,#e9d5ff,#9333ea)' },
  { min: 81, max: 90, name: 'Black Hole', icon: '🕳️', grad: 'linear-gradient(135deg,#475569,#0f172a)' },
  { min: 91, max: Infinity, name: 'Galaxy', icon: '🌠', grad: 'linear-gradient(135deg,#312e81,#6d28d9)' },
];
function growthStageForLevel(level) {
  return GROWTH_STAGES.find((s) => level >= s.min && level <= s.max) || GROWTH_STAGES[GROWTH_STAGES.length - 1];
}
function growthStageIndex(level) {
  return GROWTH_STAGES.findIndex((s) => level >= s.min && level <= s.max);
}

// Daily xp-earn cap (Sudan calendar day — see src/xp.js) rendered as its own
// card on the Level screen. currentUser.dailyXp is sent by /api/auth/me and
// refreshed live over 'xp_update' (see the socket handler above), so this
// always reflects the server's real counter, never a client-side guess.
function formatLevelCountdown(resetsAtIso) {
  const ms = Math.max(0, new Date(resetsAtIso).getTime() - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
function renderLevelDailyXpCard() {
  const d = currentUser.dailyXp || { cap: 5000, earnedToday: 0, remainingToday: 5000, resetsAt: new Date().toISOString() };
  const pct = Math.max(0, Math.min(100, Math.round((d.earnedToday / d.cap) * 100)));
  const atCap = d.remainingToday <= 0;
  return `
    <div class="level-daily-xp-card" id="levelDailyXpCard">
      <div class="level-daily-xp-head">
        <span class="level-daily-xp-title">⚡ Daily XP limit</span>
        <span class="level-daily-xp-count">${d.earnedToday.toLocaleString()} <span class="level-daily-xp-cap">/ ${d.cap.toLocaleString()}</span></span>
      </div>
      <div class="level-daily-xp-track">
        <div class="level-daily-xp-fill${atCap ? ' maxed' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="level-daily-xp-foot">
        ${atCap
          ? `<span class="level-daily-xp-maxed-label">🔒 Today's limit reached</span>`
          : `<span>${d.remainingToday.toLocaleString()} XP left today</span>`}
        <span class="level-daily-xp-resets">Resets in ${formatLevelCountdown(d.resetsAt)} · 00:00 Sudan time</span>
      </div>
    </div>
  `;
}

let levelScreenCountdownTimer = null;
function renderLevelScreen(box) {
  const level = currentUser.level;
  const into = currentUser.xpIntoLevel || 0;
  const need = currentUser.xpForNextLevel || 1;
  const pct = Math.max(0, Math.min(100, Math.round((into / need) * 100)));
  const tier = tierForLevel(level);
  const tiles = levelRoadmapTiles(level);
  const nextTile = tiles[1];
  const stageIdx = growthStageIndex(level);
  const stage = GROWTH_STAGES[stageIdx];
  const nextStage = GROWTH_STAGES[stageIdx + 1] || null;

  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

  box.innerHTML = `
    <div class="level-screen-container">
      <div class="level-col-left">
        <div class="level-hero-card">
          <div class="level-ring-wrap">
            <div class="level-ring">
              <svg width="180" height="180" viewBox="0 0 180 180">
                <defs>
                  <linearGradient id="levelRingGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#fbbf24" />
                    <stop offset="100%" stop-color="#f97316" />
                  </linearGradient>
                </defs>
                <circle cx="90" cy="90" r="${radius}" fill="none" stroke="var(--panel-alt)" stroke-width="10" />
                <circle cx="90" cy="90" r="${radius}" fill="none" stroke="url(#levelRingGradient)" stroke-width="10" stroke-linecap="round"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 90 90)" />
              </svg>
              <div class="level-ring-center">
                <div class="level-ring-badge" style="background:${stage.grad}">${stage.icon}</div>
                <div class="level-ring-number">${level}</div>
                <div class="level-ring-label">Level</div>
              </div>
            </div>
          </div>
          <div class="level-stage-pills">
            <div class="level-stage-badge">${escapeHtml(stage.name.toUpperCase())}</div>
            <div class="level-tier-badge">⭐ ${escapeHtml(tier.name.toUpperCase())} TIER</div>
          </div>
          <div class="level-progress-row">
            <div class="level-progress-track"><div class="level-progress-fill" style="width:${pct}%"></div></div>
            <div class="level-progress-stats">
              <span class="level-progress-pct">${pct}%</span>
              <span class="level-progress-caption">Progress to level ${level + 1} · ${100 - pct}% to go</span>
            </div>
          </div>
        </div>

        ${renderLevelDailyXpCard()}

        ${nextStage ? `
          <div class="level-next-stage-card">
            <div class="level-next-stage-icon" style="background:${nextStage.grad}">${nextStage.icon}</div>
            <div>
              <div class="level-next-stage-title">Next: ${escapeHtml(nextStage.name)}</div>
              <div class="level-next-stage-sub">Ranks up at Lv ${nextStage.min} · ${nextStage.min - level} level${nextStage.min - level === 1 ? '' : 's'} to go</div>
            </div>
          </div>
        ` : ''}
        <div class="level-next-reward-card">
          <div class="level-next-reward-icon">${nextTile.icon}</div>
          <div>
            <div class="level-next-reward-title">${escapeHtml(nextTile.name)}</div>
            <div class="level-next-reward-sub">${escapeHtml(nextTile.desc || `Unlocks at level ${nextTile.level}`)}</div>
          </div>
          <div class="level-next-reward-badge">Lv ${nextTile.level}</div>
        </div>
      </div>

      <div class="level-col-right">
        <div class="level-roadmap-title">Galaxy rank</div>
        <div class="level-roadmap-scroll" id="growthScroll"></div>
        <div class="level-roadmap-title">Level roadmap</div>
        <div class="level-roadmap-scroll" id="levelRoadmapScroll"></div>
      </div>
    </div>
  `;

  // Keeps the "Resets in Xh Ym" line accurate while this screen stays open,
  // without needing a fresh xp event — cheap no-op once the screen is closed.
  if (levelScreenCountdownTimer) clearInterval(levelScreenCountdownTimer);
  levelScreenCountdownTimer = setInterval(() => {
    const top = subScreenStack[subScreenStack.length - 1];
    const el = document.querySelector('#levelDailyXpCard .level-daily-xp-resets');
    if (!el || !currentUser.dailyXp || !top || top.render !== renderLevelScreen) {
      clearInterval(levelScreenCountdownTimer);
      return;
    }
    el.textContent = `Resets in ${formatLevelCountdown(currentUser.dailyXp.resetsAt)} · 00:00 Sudan time`;
  }, 60_000);

  const growthScroll = box.querySelector('#growthScroll');
  GROWTH_STAGES.forEach((s, i) => {
    const reached = i <= stageIdx;
    const tile = document.createElement('div');
    tile.className = 'growth-tile' + (i === stageIdx ? ' current' : '') + (reached ? '' : ' locked');
    const rangeLabel = s.max === Infinity ? `Lv ${s.min}+` : `Lv ${s.min}–${s.max}`;
    tile.innerHTML = `
      ${i === stageIdx ? '<div class="growth-you">YOU</div>' : ''}
      <div class="growth-badge-icon" style="background:${reached ? s.grad : 'linear-gradient(135deg,#cbd5e1,#94a3b8)'}">${reached ? s.icon : '🔒'}</div>
      <div class="growth-range">${rangeLabel}</div>
      <div class="growth-name">${escapeHtml(s.name)}</div>
    `;
    growthScroll.appendChild(tile);
  });

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
  // A reaction chip changed anywhere this socket can see — update every
  // matching message element on screen (primary pane + any secondary
  // floating panels showing the same message).
  socket.on('message_reactions_update', ({ messageId, reactions }) => {
    updateReactionsOnScreen(messageId, reactions);
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
  // Both dice-betting games broadcast on the same event, identified by
  // gameKey — only the matching controller reacts (same pattern as the
  // shared LowCard/Cricket 'elimination_state' broadcast just below).
  socket.on('dicebet_state', (state) => {
    const p = DICE_BET_PANELS.find((pnl) => pnl.gameKey === state.gameKey);
    if (p) p.onState(state);
  });
  if (!diceBetCountdownTimer) {
    diceBetCountdownTimer = setInterval(() => {
      DICE_BET_PANELS.forEach((p) => p.tickCountdown());
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
  socket.on('xp_update', ({ xp, level, xpIntoLevel, xpForNextLevel, dailyXp }) => {
    const leveledUp = currentUser.level && level > currentUser.level;
    currentUser.xp = xp;
    currentUser.level = level;
    if (xpIntoLevel != null) currentUser.xpIntoLevel = xpIntoLevel;
    if (xpForNextLevel != null) currentUser.xpForNextLevel = xpForNextLevel;
    if (dailyXp) currentUser.dailyXp = dailyXp;
    updateUserBar();
    if (leveledUp) toast(`⭐ Level up! You're now Lv.${level}`);
    // Keep the Level screen's daily-XP meter live if it's the one open right now.
    const topSub = subScreenStack[subScreenStack.length - 1];
    if (topSub && topSub.render === renderLevelScreen && !$('#subScreenOverlay').classList.contains('hidden')) {
      renderLevelScreen($('#subScreenContent'));
    }
  });
  socket.on('gift_shower', (data) => playGiftShower(data));
  // "/purchase effect" store (see effectsCatalog.js on the server) — catalog
  // listing, the caller's own owned effects, and the themed visual/chat line
  // when someone actually fires an owned effect ("/bomb", "/thunder", ...).
  socket.on('effect_catalog', ({ effects }) => showEffectStoreModal(effects, 'catalog'));
  socket.on('effect_my_list', ({ effects }) => showEffectStoreModal(effects, 'owned'));
  socket.on('effect_triggered', (data) => playEffectImpact(data));
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
    // Keep My Profile's hero status dot live if it's the one open right now
    // (same pattern as xp_update's Level-screen refresh below).
    const topSub = subScreenStack[subScreenStack.length - 1];
    if (topSub && topSub.render === renderMyProfile && !$('#subScreenOverlay').classList.contains('hidden')) {
      renderMyProfile($('#subScreenContent'));
    }
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

  if (!openRoomTabs.find((r) => r.id === id)) openRoomTabs.push({ id, name });
  renderRoomTabs();
  updateMediaButtonsState();

  DICE_BET_PANELS.forEach((p) => p.onRoomSwitch());

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
  // Re-inserts the owner/welcome/who's-here banner as the first thing in the
  // (just-reset) chat log — see ensureRoomBannerHost — without waiting on
  // the join_room round trip below, which only needs to refresh it again
  // once live membership data comes back.
  renderRoomInfoBanner();

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
  if (msg.username) div.dataset.username = msg.username;
  div.className = 'msg ' + (msg.type || 'text');
  if (msg.type && msg.type.startsWith('effect_')) {
    // Purchased chat effect line ("/bomb", "/thunder", ...) — a persisted,
    // full-width gradient bar (theme keyed by the part of the type after
    // "effect_"), not a plain system notice. Content is "<emoji> <text>"
    // (see triggerPurchasedEffect in socket.js); split the leading emoji off
    // into its own icon badge, matching the reference bar's layout.
    const key = msg.type.slice(7);
    const theme = EFFECT_THEME[key] || EFFECT_THEME_DEFAULT;
    div.className = 'msg effect-bar';
    div.style.background = `linear-gradient(90deg, ${theme.color1}, ${theme.color2})`;
    const content = msg.content || '';
    const spaceIdx = content.indexOf(' ');
    const icon = spaceIdx === -1 ? content : content.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1);
    div.innerHTML = `<span class="effect-bar-icon">${escapeHtml(icon)}</span> ${escapeHtml(rest)}`;
  } else if (msg.type === 'system' || msg.type === 'voucher') {
    div.textContent = msg.content;
  } else if (msg.type === 'gift') {
    div.innerHTML = styleGiftText(msg.content);
  } else if (msg.type === 'legendary' || msg.type === 'luxury') {
    // Multi-line bot messages (bet confirmations, dice rolls, payouts) —
    // preserve line breaks, bold bot-name prefix (purple for Legendary,
    // gold/amber for Luxury Bet), bubble bg.
    const botLabel = msg.type === 'luxury' ? 'Luxury Bet' : 'Legendary Bot';
    div.innerHTML = `<span class="user dicebet-bot-name ${msg.type}">${botLabel}:</span> ${escapeHtml(msg.content).replace(/\n/g, '<br>')}`;
  } else if (msg.type === 'game_bot') {
    // LowCard / Cricket bot messages — same bubble treatment as the dice-
    // betting bots, but the name comes from msg.username (e.g. "LowCard Bot").
    div.innerHTML = `<span class="user dicebet-bot-name legendary">${escapeHtml(msg.username || 'Game Bot')}:</span> ${escapeHtml(msg.content).replace(/\n/g, '<br>')}`;
  } else if (msg.type === 'image' || msg.type === 'voice') {
    const cls = roleClass(msg);
    const nameStyle = usernameStyleAttr(msg);
    const mediaHtml = msg.type === 'image'
      ? `<img class="chat-shared-image" src="${escapeHtml(msg.content)}" alt="shared picture" loading="lazy" />`
      : `<audio class="chat-voice-note" src="${escapeHtml(msg.content)}" controls></audio>`;
    div.innerHTML = `<div><span class="user clickable-username ${cls}"${nameStyle} data-username="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}${roleIcon(msg)}:</span></div>${mediaHtml}`;
  } else {
    // Classic flat chat line — "ColoredUsername: message text" — matching
    // the mig33/mig66 reference exactly: no bubble, no avatar, every
    // message (yours or anyone else's) renders the same way, distinguished
    // only by each user's own name color. A reply still gets its quote card
    // above the line so that context isn't lost without bubbles.
    const cls = roleClass(msg);
    const nameStyle = usernameStyleAttr(msg);
    const replyHtml = msg.replyTo ? buildReplyQuoteHtml(msg.replyTo) : '';
    div.innerHTML = `${replyHtml}<span class="user clickable-username ${cls}"${nameStyle} data-username="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}${roleIcon(msg)}</span>: ${escapeChatText(msg.content)}`;
  }
  // Every persisted message type (not just plain text) can carry reactions —
  // appended once here rather than duplicated in each branch above.
  if (msg.id != null) {
    const reactionsBox = document.createElement('div');
    reactionsBox.className = 'msg-reactions hidden';
    div.appendChild(reactionsBox);
    renderReactionChips(reactionsBox, msg);
  }
  bindMessageLongPress(div, msg);
  return div;
}

// "10:47 PM" — created_at comes from SQLite's datetime('now') (UTC, space-
// separated, no "Z"); a live broadcast's created_at is already a proper ISO
// string. Normalize both the same way formatAlertTime does elsewhere.
function formatMsgTime(createdAt) {
  if (!createdAt) return '';
  try {
    const s = String(createdAt);
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) { return ''; }
}

// The nested quote card at the top of a reply bubble ("↩ replying to X" +
// a truncated copy of the original) — see the first reference screenshot's
// "roktim replied to tanvir121" block.
function buildReplyQuoteHtml(replyTo) {
  const snippetSource = replyTo.type === 'image' ? '📷 Photo' : replyTo.type === 'voice' ? '🎤 Voice note' : replyTo.content;
  const snippet = escapeHtml(String(snippetSource || '').slice(0, 120));
  return `
    <div class="reply-quote">
      <span class="reply-quote-icon">↩</span>
      <div class="reply-quote-body">
        <div class="reply-quote-to">${escapeHtml(replyTo.username)}</div>
        <div class="reply-quote-text">${snippet}</div>
      </div>
    </div>
  `;
}

// ---------- MESSAGE REACTIONS ----------
// One reaction per user per message (see toggle_reaction in socket.js) —
// myReactionsByMsgId remembers what *I* currently have on each message so a
// reactions_update broadcast (counts only, no per-user info) still knows
// which chip to highlight as "mine".
let myReactionsByMsgId = new Map();

function renderReactionChips(container, msg) {
  if (!container) return;
  if (msg.myReaction) myReactionsByMsgId.set(String(msg.id), msg.myReaction);
  container.innerHTML = '';
  const reactions = msg.reactions || {};
  const entries = Object.entries(reactions).filter(([, c]) => c > 0);
  if (!entries.length) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  const mine = myReactionsByMsgId.get(String(msg.id));
  entries.forEach(([emoji, count]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'msg-reaction-chip' + (emoji === mine ? ' mine' : '');
    chip.innerHTML = `${emoji} <span class="msg-reaction-count">${count}</span>`;
    chip.addEventListener('click', () => toggleReaction(msg.id, emoji));
    container.appendChild(chip);
  });
}

function toggleReaction(messageId, emoji) {
  if (!messageId || !socket) return;
  socket.emit('toggle_reaction', { messageId, emoji }, (ack) => {
    if (!ack) return;
    if (!ack.ok) return toast(ack.error || 'Could not react to that message');
    if (ack.myReaction) myReactionsByMsgId.set(String(messageId), ack.myReaction);
    else myReactionsByMsgId.delete(String(messageId));
    updateReactionsOnScreen(messageId, ack.reactions);
  });
}

// Rebuilds every on-screen copy of a message's reaction row (it can appear
// in both the primary pane and a secondary floating panel at once).
function updateReactionsOnScreen(messageId, reactions) {
  $$(`.msg[data-msg-id="${CSS.escape(String(messageId))}"] .msg-reactions`).forEach((el) => {
    renderReactionChips(el, { id: messageId, reactions, myReaction: myReactionsByMsgId.get(String(messageId)) });
  });
}

// ---------- LONG-PRESS MESSAGE MENU (Reply/Copy/Report/Block + reactions) ----------
const MSG_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '😠', '😎', '👍', '👎'];
const LONG_PRESS_MS = 450;
let longPressTimer = null;

function bindMessageLongPress(div, msg) {
  // Only real, persisted messages have anything to act on — system notices,
  // effect bars, etc. (no DB id) are skipped entirely.
  if (msg.id == null) return;
  const cancel = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };
  const start = () => {
    cancel();
    longPressTimer = setTimeout(() => { longPressTimer = null; openMessageActionMenu(div, msg); }, LONG_PRESS_MS);
  };
  div.addEventListener('touchstart', start, { passive: true });
  div.addEventListener('touchend', cancel);
  div.addEventListener('touchmove', cancel);
  div.addEventListener('mousedown', start);
  div.addEventListener('mouseup', cancel);
  div.addEventListener('mouseleave', cancel);
  // Desktop convenience: right-click opens it immediately, no holding required.
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); openMessageActionMenu(div, msg); });
}

function openMessageActionMenu(targetEl, msg) {
  const menu = $('#msgActionMenu');
  const backdrop = $('#msgActionBackdrop');
  if (!menu || !backdrop) return;
  const isOwn = !!(currentUser && msg.username && msg.username.toLowerCase() === currentUser.username.toLowerCase());
  const canBlock = !isOwn && msg.user_id != null;

  const reactionRow = MSG_REACTION_EMOJIS
    .map((e) => `<button type="button" class="msg-action-emoji" data-emoji="${e}">${e}</button>`)
    .join('');
  menu.innerHTML = `
    <div class="msg-action-reactions">${reactionRow}</div>
    <div class="msg-action-list">
      <button type="button" class="msg-action-item" data-action="reply">↩ <span>Reply</span></button>
      <button type="button" class="msg-action-item" data-action="copy">📋 <span>Copy</span></button>
      <button type="button" class="msg-action-item msg-action-danger" data-action="report">🚩 <span>Report</span></button>
      ${canBlock ? '<button type="button" class="msg-action-item msg-action-danger" data-action="block">🚫 <span>Block</span></button>' : ''}
    </div>
  `;
  menu.querySelectorAll('.msg-action-emoji').forEach((btn) => {
    btn.addEventListener('click', () => { toggleReaction(msg.id, btn.dataset.emoji); closeMessageActionMenu(); });
  });
  menu.querySelector('[data-action="reply"]').addEventListener('click', () => { startReply(msg); closeMessageActionMenu(); });
  menu.querySelector('[data-action="copy"]').addEventListener('click', () => { copyMessageText(msg); closeMessageActionMenu(); });
  menu.querySelector('[data-action="report"]').addEventListener('click', () => { reportMessage(msg); closeMessageActionMenu(); });
  const blockBtn = menu.querySelector('[data-action="block"]');
  if (blockBtn) blockBtn.addEventListener('click', () => { blockUserFlow(msg.username); closeMessageActionMenu(); });

  backdrop.classList.remove('hidden');
  menu.classList.remove('hidden');
  menu.style.visibility = 'hidden';
  const rect = targetEl.getBoundingClientRect();
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    let top = rect.top - menuRect.height - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - menuRect.height - 8);
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
    if (left < 8) left = 8;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = 'visible';
  });
}

function closeMessageActionMenu() {
  const menu = $('#msgActionMenu');
  const backdrop = $('#msgActionBackdrop');
  if (menu) menu.classList.add('hidden');
  if (backdrop) backdrop.classList.add('hidden');
}

function copyMessageText(msg) {
  const text = msg.type === 'image' ? msg.content : msg.type === 'voice' ? '[voice note]' : msg.content;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('📋 Copied')).catch(() => toast('Could not copy'));
  } else {
    toast('Copy is not supported in this browser');
  }
}

function reportMessage(msg) {
  if (!socket) return;
  socket.emit('report_message', { messageId: msg.id }, (ack) => {
    toast(ack && ack.ok ? '🚩 Message reported to Staff' : (ack && ack.error) || 'Could not report this message');
  });
}

async function blockUserFlow(username) {
  if (!username) return;
  if (!confirm(`Block ${username}? You won't see their messages in any room anymore.`)) return;
  try {
    await api(`/users/${encodeURIComponent(username)}/block`, { method: 'POST' });
    blockedUsernames.add(username.toLowerCase());
    $$('.msg[data-username]').forEach((el) => {
      if (el.dataset.username && el.dataset.username.toLowerCase() === username.toLowerCase()) el.remove();
    });
    toast(`🚫 Blocked ${username} — their messages are now hidden for you`);
  } catch (err) {
    toast(err.message || 'Could not block this user');
  }
}

// ---------- REPLY COMPOSE BAR ----------
function startReply(msg) {
  replyContext = { id: msg.id, username: msg.username, content: msg.content, type: msg.type };
  renderReplyPreview();
  const input = $('#chatInput');
  if (input) input.focus();
}

function cancelReply() {
  replyContext = null;
  renderReplyPreview();
}

function renderReplyPreview() {
  const bar = $('#replyPreviewBar');
  if (!bar) return;
  if (!replyContext) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const snippetSource = replyContext.type === 'image' ? '📷 Photo' : replyContext.type === 'voice' ? '🎤 Voice note' : replyContext.content;
  bar.innerHTML = `
    <span class="reply-preview-icon">↩</span>
    <div class="reply-preview-body">
      <div class="reply-preview-to">Replying to ${escapeHtml(replyContext.username)}</div>
      <div class="reply-preview-text">${escapeHtml(String(snippetSource || '').slice(0, 100))}</div>
    </div>
    <button type="button" class="reply-preview-close" id="replyPreviewCloseBtn">✕</button>
  `;
  bar.classList.remove('hidden');
  $('#replyPreviewCloseBtn').addEventListener('click', cancelReply);
}

$('#msgActionBackdrop').addEventListener('click', closeMessageActionMenu);

// A blocked user's messages are hidden for the blocker only (see the
// long-press "Block" action) — purely a client-side filter, never sent at
// all rather than sent-then-hidden, so there's nothing to leak if the DOM
// were inspected. Never hides your own messages (blocking yourself isn't
// possible server-side either) or anything with no real author (bots,
// system notices).
function isBlockedMessage(msg) {
  if (!msg || !msg.username || msg.user_id == null) return false;
  if (currentUser && msg.username.toLowerCase() === currentUser.username.toLowerCase()) return false;
  return blockedUsernames.has(msg.username.toLowerCase());
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
  if (isBlockedMessage(msg)) return;
  const div = buildMessageEl(msg);
  const box = $('#messages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
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

// Purchased chat effect ("/bomb", "/thunder", ...) — themed look shared by
// two things: the persisted full-width gradient bar embedded right in the
// chat scrollback (see buildMessageEl's "effect_<key>" branch — that's the
// actual "<user> summoned a thunderstorm!" line, posted + persisted like a
// gift/legendary-bot line, see triggerPurchasedEffect in socket.js) and the
// one-shot big center-screen "IMPACT!" celebration below. One place to add,
// recolor, or reword an effect's look.
const EFFECT_THEME = {
  bomb: { headline: 'BOOM!', color1: '#7c2d12', color2: '#dc2626', glow: '#f97316', debris: '#fca5a5' },
  missile: { headline: 'IMPACT!', color1: '#7f1d1d', color2: '#b91c1c', glow: '#f59e0b', debris: '#fcd34d' },
  grenade: { headline: 'BOOM!', color1: '#365314', color2: '#4d7c0f', glow: '#a3e635', debris: '#bef264' },
  love: { headline: 'LOVE!', color1: '#831843', color2: '#db2777', glow: '#f472b6', debris: '#fbcfe8' },
  bird: { headline: 'FREEDOM!', color1: '#0c4a6e', color2: '#0284c7', glow: '#7dd3fc', debris: '#bae6fd' },
  butterfly: { headline: 'BEAUTY!', color1: '#581c87', color2: '#9333ea', glow: '#e9d5ff', debris: '#d8b4fe' },
  dragon: { headline: 'ROAR!', color1: '#14532d', color2: '#15803d', glow: '#4ade80', debris: '#86efac' },
  rain: { headline: 'SPLASH!', color1: '#0c4a6e', color2: '#0369a1', glow: '#7dd3fc', debris: '#bae6fd' },
  ghost: { headline: 'BOO!', color1: '#312e81', color2: '#4338ca', glow: '#c7d2fe', debris: '#e0e7ff' },
  meteor: { headline: 'IMPACT!', color1: '#7c2d12', color2: '#c2410c', glow: '#fb923c', debris: '#fed7aa' },
  thunder: { headline: 'STRIKE!', color1: '#3b0764', color2: '#6d28d9', glow: '#facc15', debris: '#fde68a' },
  snowball: { headline: 'SPLAT!', color1: '#0c4a6e', color2: '#0891b2', glow: '#e0f2fe', debris: '#f0f9ff' },
  tomato: { headline: 'SPLAT!', color1: '#7f1d1d', color2: '#b91c1c', glow: '#fca5a5', debris: '#fecaca' },
  laser: { headline: 'ZAP!', color1: '#1e3a8a', color2: '#2563eb', glow: '#93c5fd', debris: '#bfdbfe' },
  firework: { headline: 'BOOM!', color1: '#7c2d12', color2: '#c026d3', glow: '#fde047', debris: '#fef08a' },
};
const EFFECT_THEME_DEFAULT = { headline: 'WOW!', color1: '#3b0764', color2: '#6d28d9', glow: '#facc15', debris: '#fde68a' };

// Each effect gets its own full-screen "shape", not just a recolored
// version of the same burst — a storm genuinely looks like a storm (dark
// cloud + lightning), rain genuinely falls, birds genuinely fly across
// instead of exploding outward. `kind` picks the particle motion:
//   burst  — scattered across the screen, tumbling outward then falling (explosions)
//   fall   — starts above the viewport, falls straight down (rain/snow/meteor)
//   rise   — starts near the bottom, drifts upward (love/fire/ghost)
//   fly    — starts off one edge, crosses the screen (birds/butterflies)
//   storm  — no particles; a dark cloud band + flickering lightning bolts (thunder)
const EFFECT_ARCHETYPE = {
  bomb: { kind: 'burst', shake: true, ring: true, flash: true },
  missile: { kind: 'burst', shake: true, ring: true, flash: true },
  grenade: { kind: 'burst', shake: true, ring: true, flash: true },
  firework: { kind: 'burst', particle: '✨', shake: false, ring: true, flash: true },
  tomato: { kind: 'burst', particle: '🍅', shake: true, ring: true, flash: true },
  laser: { kind: 'burst', particle: '⚡', shake: false, ring: true, flash: true },
  meteor: { kind: 'fall', particle: '☄️', shake: true, ring: true, flash: true, fast: true },
  rain: { kind: 'fall', shake: false, ring: false, flash: false, dense: true, color: 'rgba(125,211,252,0.7)' },
  snowball: { kind: 'fall', particle: '❄️', shake: false, ring: false, flash: false, slow: true },
  love: { kind: 'rise', particle: '💖', shake: false, ring: false, flash: false },
  dragon: { kind: 'rise', particle: '🔥', shake: true, ring: true, flash: true },
  ghost: { kind: 'rise', particle: '👻', shake: false, ring: false, flash: false, dark: true },
  bird: { kind: 'fly', particle: '🐦', shake: false, ring: false, flash: false },
  butterfly: { kind: 'fly', particle: '🦋', shake: false, ring: false, flash: false },
  thunder: { kind: 'storm', shake: true, ring: true, flash: true },
};
const EFFECT_ARCHETYPE_DEFAULT = { kind: 'burst', shake: true, ring: true, flash: true };

function playEffectImpact({ key, emoji, username, level, target }) {
  const theme = EFFECT_THEME[key] || EFFECT_THEME_DEFAULT;
  const arch = EFFECT_ARCHETYPE[key] || EFFECT_ARCHETYPE_DEFAULT;
  const wrap = document.createElement('div');
  wrap.className = 'effect-impact';
  wrap.style.setProperty('--fx-glow', theme.glow);
  wrap.style.setProperty('--fx-text', theme.glow);

  // Full-viewport color wash — the "whole screen reacts" part. A quick
  // flash in, long fade out. Most effects tint from their glow color; a
  // "dark"-flagged one (ghost) washes toward black instead for a spookier
  // read.
  if (arch.flash) {
    const flash = document.createElement('div');
    flash.className = 'effect-impact-flash';
    flash.style.background = arch.dark
      ? 'radial-gradient(circle, rgba(10,10,25,0.15) 0%, rgba(5,5,20,0.7) 100%)'
      : `radial-gradient(circle, ${theme.glow} 0%, transparent 70%)`;
    wrap.appendChild(flash);
  }

  // Storm (thunder): a dark cloud band across the top of the screen plus a
  // few staggered lightning-flash strobes — no debris, the sky itself is
  // the effect.
  if (arch.kind === 'storm') {
    const cloud = document.createElement('div');
    cloud.className = 'effect-impact-cloud';
    wrap.appendChild(cloud);
    [0, 0.35, 0.85].forEach((delay) => {
      const bolt = document.createElement('div');
      bolt.className = 'effect-impact-bolt';
      bolt.style.animationDelay = delay + 's';
      wrap.appendChild(bolt);
    });
  }

  // A shockwave ring sized in vmax so it genuinely grows to cover the
  // screen (not just a small circle in the middle) — two, staggered, for
  // a bit of depth. Only for effects with a real "impact" (explosions,
  // dragon roar, thunder clap) — a shower of birds doesn't shock the room.
  if (arch.ring) {
    const ring1 = document.createElement('div'); ring1.className = 'effect-impact-ring';
    const ring2 = document.createElement('div'); ring2.className = 'effect-impact-ring ring2';
    wrap.append(ring1, ring2);
  }

  const vw = window.innerWidth, vh = window.innerHeight;
  let ttl = 2800;

  if (arch.kind === 'burst') {
    // Scattered across the ENTIRE viewport (not bursting from one center
    // point) — each particle picks its own random spot on screen, tumbles
    // a little, and falls, so the whole screen feels hit rather than one
    // badge in the middle of it.
    const count = 60;
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'effect-impact-debris';
      d.style.left = Math.random() * vw + 'px';
      d.style.top = (Math.random() * vh * 0.7) + 'px';
      d.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
      d.style.setProperty('--dy', `${120 + Math.random() * (vh * 0.5)}px`);
      d.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
      d.style.animationDuration = (1.4 + Math.random() * 0.8) + 's';
      d.style.animationDelay = (Math.random() * 0.4) + 's';
      if (arch.particle) {
        d.textContent = arch.particle;
        d.style.fontSize = (14 + Math.random() * 14) + 'px';
        d.style.lineHeight = '1';
      } else {
        d.style.background = theme.debris;
        const size = 6 + Math.random() * 10;
        d.style.width = size + 'px';
        d.style.height = size + 'px';
        d.style.borderRadius = Math.random() < 0.4 ? '50%' : '2px';
      }
      wrap.appendChild(d);
    }
    ttl = 2800;
  } else if (arch.kind === 'fall') {
    // Starts above the viewport and falls straight down past the bottom —
    // rain (dense, fast, thin streaks, slight consistent wind-drift), snow
    // (sparse, slow, drifting flakes), or meteor (fast diagonal streaks
    // with an impact shake+ring when they land).
    const count = arch.dense ? 110 : arch.fast ? 16 : 60;
    const durRange = arch.dense ? [0.5, 0.9] : arch.fast ? [0.9, 1.3] : [1.8, 2.6];
    const delayMax = arch.dense ? 1.0 : arch.fast ? 0.6 : 1.0;
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'effect-impact-drift';
      d.style.left = Math.random() * vw + 'px';
      d.style.top = (-40 - Math.random() * vh * 0.4) + 'px';
      const driftX = arch.dense ? (-40 - Math.random() * 20) : (Math.random() - 0.5) * 100;
      d.style.setProperty('--dx', `${driftX}px`);
      d.style.setProperty('--dy', `${vh * 1.3 + Math.random() * vh * 0.3}px`);
      d.style.setProperty('--rot', arch.dense || arch.fast ? '0deg' : `${(Math.random() - 0.5) * 360}deg`);
      d.style.animationDuration = (durRange[0] + Math.random() * (durRange[1] - durRange[0])) + 's';
      d.style.animationDelay = (Math.random() * delayMax) + 's';
      if (arch.particle) {
        d.textContent = arch.particle;
        d.style.fontSize = (arch.fast ? 20 + Math.random() * 10 : 12 + Math.random() * 10) + 'px';
        d.style.lineHeight = '1';
      } else {
        d.style.width = '2px';
        d.style.height = (14 + Math.random() * 10) + 'px';
        d.style.background = arch.color || theme.debris;
        d.style.borderRadius = '2px';
        d.style.transform = 'rotate(10deg)';
      }
      wrap.appendChild(d);
    }
    ttl = arch.dense || arch.fast ? 2200 : 3800;
  } else if (arch.kind === 'rise') {
    // Starts near the bottom and drifts upward — hearts floating up, fire
    // and embers rising, a handful of ghosts bobbing skyward.
    const count = key === 'ghost' ? 10 : 36;
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'effect-impact-drift';
      d.style.left = Math.random() * vw + 'px';
      d.style.top = (vh * 0.7 + Math.random() * vh * 0.3) + 'px';
      d.style.setProperty('--dx', `${(Math.random() - 0.5) * 140}px`);
      d.style.setProperty('--dy', `${-(vh * 0.7 + Math.random() * vh * 0.4)}px`);
      d.style.setProperty('--rot', `${(Math.random() - 0.5) * 180}deg`);
      d.style.animationDuration = (1.8 + Math.random() * 1.2) + 's';
      d.style.animationDelay = (Math.random() * 0.8) + 's';
      d.textContent = arch.particle;
      d.style.fontSize = (16 + Math.random() * 14) + 'px';
      d.style.lineHeight = '1';
      if (arch.dark) d.style.opacity = '0.85';
      wrap.appendChild(d);
    }
    ttl = 3800;
  } else if (arch.kind === 'fly') {
    // Starts off one random edge of the screen and crosses to the other —
    // birds/butterflies passing through the room rather than exploding in it.
    const count = 14;
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'effect-impact-drift';
      const fromLeft = Math.random() < 0.5;
      d.style.left = (fromLeft ? -40 : vw + 40) + 'px';
      d.style.top = (vh * 0.1 + Math.random() * vh * 0.6) + 'px';
      d.style.setProperty('--dx', `${(fromLeft ? 1 : -1) * (vw * 0.8 + Math.random() * vw * 0.4)}px`);
      d.style.setProperty('--dy', `${(Math.random() - 0.5) * 140}px`);
      d.style.setProperty('--rot', '0deg');
      d.style.animationDuration = (1.8 + Math.random() * 1) + 's';
      d.style.animationDelay = (Math.random() * 0.8) + 's';
      d.textContent = arch.particle;
      d.style.fontSize = (18 + Math.random() * 12) + 'px';
      d.style.lineHeight = '1';
      wrap.appendChild(d);
    }
    ttl = 3400;
  } else if (arch.kind === 'storm') {
    ttl = 3200;
  }

  const headline = document.createElement('div');
  headline.className = 'effect-impact-headline';
  headline.textContent = theme.headline;
  wrap.appendChild(headline);

  const who = level != null ? `${username} [${level}]` : username;
  const by = document.createElement('div');
  by.className = 'effect-impact-by';
  by.innerHTML = target
    ? `${emoji || '✨'} ${escapeHtml(who)} → ${escapeHtml(target)}`
    : `${emoji || '✨'} by ${escapeHtml(who)}`;
  wrap.appendChild(by);

  // A brief screen-shake sells the "impact" — applied to the whole app
  // shell, not just this overlay, so it reads as the room itself getting
  // hit rather than a sticker floating on top of it. Only for effects that
  // should actually jolt the screen (explosions, dragon roar, thunderclap).
  if (arch.shake) {
    const shell = document.getElementById('app') || document.body;
    shell.classList.add('effect-screen-shake');
    setTimeout(() => shell.classList.remove('effect-screen-shake'), 500);
  }

  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), ttl);
}

// "/purchase effect" (catalog) and "/purchase effect info" (owned-only) both
// render through the same modal — mode picks the title/footer/empty state.
function showEffectStoreModal(effects, mode) {
  $('#effectStoreTitle').textContent = mode === 'owned' ? '🎒 Your Effects' : '✨ Effects on Sale';
  $('#effectStoreFooter').classList.toggle('hidden', mode === 'owned');
  const list = $('#effectStoreList');
  list.innerHTML = '';
  if (!effects.length) {
    list.innerHTML = `<div class="empty-note">${mode === 'owned' ? "You don't own any effects yet — try /purchase effect" : 'Nothing on sale right now.'}</div>`;
  } else {
    effects.forEach((e) => {
      let subtitle = `${e.price.toLocaleString()} coins · ${e.days} days`;
      if (mode === 'owned') {
        const daysLeft = Math.max(0, Math.ceil((new Date(e.expiresAt.replace(' ', 'T') + 'Z') - Date.now()) / 86400000));
        subtitle = `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
      } else if (e.owned) {
        subtitle += ' · already owned';
      }
      list.appendChild(listRow({ icon: e.emoji, iconBg: '#7c3aed', title: `/${e.key}`, subtitle }));
    });
  }
  $('#effectStoreModal').classList.remove('hidden');
}
function closeEffectStore() { $('#effectStoreModal').classList.add('hidden'); }

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

$('#closeEffectStoreBtn').addEventListener('click', closeEffectStore);
$('#effectStoreModal').addEventListener('click', (e) => { if (e.target.id === 'effectStoreModal') closeEffectStore(); });

// ---------- DICE-BETTING GAMES (Legendary Bot, Luxury Bet) ----------
// Both games are the exact same mechanic (bet coins on one of six faces,
// the bot rolls 6 dice, payout by match count) — only the room, bot name
// and face set differ. One controller factory, instantiated twice, instead
// of duplicating the whole panel; mirrors createDiceBettingGame server-side.
function formatBetAmount(n) { return n >= 1000 ? `${n / 1000}k` : String(n); }

function createDiceBetController({ gameKey, roomName, panelId, title, titleIcon, subtitle, faces, betAmounts }) {
  let selectedAmount = betAmounts[0];
  let selectedFace = null;
  let state = { phase: 'idle', endsAt: 0, totals: {}, betCount: 0 };
  // Two independent declutter controls, matching the reference bar's 👁/− pair:
  // minimized keeps the header strip (countdown + current bet) but hides the
  // face/amount rows; hidden drops the whole bar, leaving only a small tab to
  // bring it back. Both reset on room re-entry (not persisted) since they're
  // just "I don't want to look at this right now" toggles, not a preference.
  let minimized = false;
  let hidden = false;
  // 👁 toggle: shows what everyone else (including the bots now playing too)
  // has bet on this round, fetched on demand from the server so it's always
  // current. null = not fetched yet for this toggle-on.
  let showBets = false;
  let betsList = null;

  function isInRoom() { return currentRoomName === roomName; }

  function onRoomSwitch() {
    selectedFace = null;
    minimized = false;
    hidden = false;
    showBets = false;
    betsList = null;
    if (isInRoom()) {
      socket.emit('dicebet_get_state', { gameKey }, (s) => { if (s) { state = s; render(); } });
    } else {
      render(); // hides the panel when leaving this game's room
    }
  }

  function onState(s) {
    state = s;
    // A new round clears last round's bets server-side — drop our stale copy
    // so the 👁 view doesn't keep showing a previous round's bettors.
    if (s.phase === 'betting' && betsList) betsList = null;
    if (isInRoom()) {
      render();
      if (showBets) {
        socket.emit('dicebet_get_bets', { gameKey }, (res) => {
          betsList = (res && res.bettors) || [];
          if (isInRoom() && showBets) render();
        });
      }
    }
  }

  function tickCountdown() {
    if (isInRoom() && state.phase === 'betting') render();
  }

  function render() {
    const panel = $(panelId);
    if (!panel) return;
    if (!isInRoom()) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

    if (hidden) {
      panel.classList.remove('hidden');
      panel.innerHTML = `<button type="button" class="dicebet-reopen-tab">${titleIcon} ${title}</button>`;
      panel.querySelector('.dicebet-reopen-tab').addEventListener('click', () => { hidden = false; render(); });
      return;
    }
    panel.classList.remove('hidden');

    const secondsLeft = state.phase === 'betting' ? Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)) : 0;
    const selectedFaceObj = faces.find((f) => f.key === selectedFace);
    const isIdle = state.phase !== 'betting' && state.phase !== 'resolving';

    panel.innerHTML = `
      <div class="dicebet-header">
        <span class="dicebet-round-badge">${state.betCount || 0}</span>
        <div class="dicebet-title-col">
          <span class="dicebet-title"><span class="dicebet-title-icon">${titleIcon}</span> ${title}</span>
          <span class="dicebet-subtitle">${subtitle}</span>
        </div>
        <span class="dicebet-header-spacer"></span>
        ${state.phase === 'betting'
          ? `<span class="dicebet-badge dicebet-countdown">${secondsLeft}s</span>`
          : state.phase === 'resolving'
            ? `<span class="dicebet-badge dicebet-countdown idle">rolling dice…</span>`
            : `<button type="button" class="dicebet-badge dicebet-start-btn" id="${gameKey}StartBtn">▶ Start</button>`}
        ${selectedFaceObj ? `<span class="dicebet-badge dicebet-bet-summary">${selectedFaceObj.emoji} ${formatBetAmount(selectedAmount)}</span>` : ''}
        <button type="button" class="dicebet-icon-btn" id="${gameKey}DoubleBtn" title="Double the selected bet amount">2x</button>
        <button type="button" class="dicebet-icon-btn${showBets ? ' active' : ''}" id="${gameKey}EyeBtn" title="See everyone's bets">👁</button>
        <button type="button" class="dicebet-icon-btn" id="${gameKey}MinBtn" title="${minimized ? 'Expand' : 'Minimize'}">${minimized ? '+' : '−'}</button>
        <button type="button" class="dicebet-icon-btn" id="${gameKey}HideBtn" title="Hide">✕</button>
      </div>
      ${minimized ? '' : `
        ${showBets ? '<div class="dicebet-bets-list"></div>' : ''}
        <div class="dicebet-face-row"></div>
        <div class="dicebet-amount-row"></div>
        <div class="dicebet-hint">👆 Tap a character to bid instantly</div>
      `}
    `;

    if (isIdle) {
      panel.querySelector(`#${gameKey}StartBtn`).addEventListener('click', () => {
        socket.emit('dicebet_start', { gameKey }, (ack) => {
          if (ack && !ack.ok) toast(ack.error || 'Could not start a round');
        });
      });
    }
    panel.querySelector(`#${gameKey}DoubleBtn`).addEventListener('click', () => {
      const idx = betAmounts.indexOf(selectedAmount);
      selectedAmount = betAmounts[Math.min(betAmounts.length - 1, idx + 1)];
      render();
    });
    panel.querySelector(`#${gameKey}EyeBtn`).addEventListener('click', () => {
      showBets = !showBets;
      if (showBets) {
        socket.emit('dicebet_get_bets', { gameKey }, (res) => {
          betsList = (res && res.bettors) || [];
          render();
        });
      }
      render();
    });
    panel.querySelector(`#${gameKey}HideBtn`).addEventListener('click', () => { hidden = true; render(); });
    panel.querySelector(`#${gameKey}MinBtn`).addEventListener('click', () => { minimized = !minimized; render(); });

    if (minimized) return;

    if (showBets) {
      const betsBox = panel.querySelector('.dicebet-bets-list');
      if (!betsList) {
        betsBox.innerHTML = `<div class="dicebet-bets-empty">Loading bets…</div>`;
      } else if (!betsList.length) {
        betsBox.innerHTML = `<div class="dicebet-bets-empty">No one has placed a bet yet this round.</div>`;
      } else {
        betsBox.innerHTML = betsList.map((b) => `
          <div class="dicebet-bet-row">
            <span class="dicebet-bet-user">${b.isBot ? '🤖 ' : ''}${escapeHtml(b.username)}</span>
            <span class="dicebet-bet-amounts">${b.bets.map((x) => `${x.emoji} ${formatBetAmount(x.amount)}`).join('  ')}</span>
          </div>
        `).join('');
      }
    }

    const row = panel.querySelector('.dicebet-face-row');
    faces.forEach((f) => {
      const item = document.createElement('div');
      item.className = 'dicebet-face-item' + (f.key === selectedFace ? ' selected' : '');
      const total = (state.totals && state.totals[f.key]) || 0;
      item.innerHTML = `
        <div class="dicebet-face-avatar">${f.emoji}</div>
        <div class="dicebet-face-item-label">${f.label}</div>
        <div class="dicebet-face-total">${total > 0 ? formatBetAmount(total) : ''}</div>
      `;
      item.addEventListener('click', () => {
        selectedFace = f.key;
        if (state.phase !== 'betting') { render(); return toast('Betting is closed — wait for the next round'); }
        socket.emit('dicebet_place_bet', { gameKey, face: f.key, amount: selectedAmount }, (ack) => {
          if (!ack || !ack.ok) toast((ack && ack.error) || 'Could not place that bet');
        });
        render();
      });
      row.appendChild(item);
    });

    const amountRow = panel.querySelector('.dicebet-amount-row');
    betAmounts.forEach((amt) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dicebet-amount-pill' + (amt === selectedAmount ? ' selected' : '');
      chip.textContent = formatBetAmount(amt);
      chip.addEventListener('click', () => { selectedAmount = amt; render(); });
      amountRow.appendChild(chip);
    });
  }

  return { gameKey, roomName, isInRoom, onRoomSwitch, onState, tickCountdown, render };
}

const LEGENDARY_FACES = [
  { key: 'lion', label: 'Lion', emoji: '🦁' },
  { key: 'tiger', label: 'Tiger', emoji: '🐯' },
  { key: 'fox', label: 'Fox', emoji: '🦊' },
  { key: 'wolf', label: 'Wolf', emoji: '🐺' },
  { key: 'bear', label: 'Bear', emoji: '🐻' },
  { key: 'panda', label: 'Panda', emoji: '🐼' },
];
const DICE_BET_AMOUNTS = [500, 1000, 2000, 5000, 10000, 15000, 20000];

const legendaryPanel = createDiceBetController({
  gameKey: 'legendary', roomName: 'Legendary Bot Official', panelId: '#legendaryGamePanel',
  title: 'Legendary', titleIcon: '🎲', subtitle: 'tap to bid', faces: LEGENDARY_FACES, betAmounts: DICE_BET_AMOUNTS,
});

const LUXURY_FACES = [
  { key: 'laila', label: 'Laila', emoji: '🧕' },
  { key: 'majnu', label: 'Majnu', emoji: '👱' },
  { key: 'romeo', label: 'Romeo', emoji: '🤵' },
  { key: 'juliet', label: 'Juliet', emoji: '👱‍♀️' },
  { key: 'shirin', label: 'Shirin', emoji: '💃' },
  { key: 'farhad', label: 'Farhad', emoji: '🕺' },
];
const luxuryPanel = createDiceBetController({
  gameKey: 'luxury', roomName: 'Luxury Bet Official', panelId: '#luxuryGamePanel',
  title: 'Luxury Bet', titleIcon: '🎰', subtitle: 'tap to bid', faces: LUXURY_FACES, betAmounts: DICE_BET_AMOUNTS,
});

const DICE_BET_PANELS = [legendaryPanel, luxuryPanel];
let diceBetCountdownTimer = null;

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

$('#sendBtn').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', (e) => {
  if (mentionKeydown(e)) return; // popover open — it owns Enter/Arrows/Escape right now
  if (e.key === 'Enter') sendChat();
});

// ---------- @MENTION AUTOCOMPLETE ----------
// Typing "@" opens a popover listing everyone currently in the room (same
// data the Participants panel/room banner use — lastRoomMembers), filtered
// live as more of the name is typed; picking one inserts "@username " at
// the cursor. Mirrors the reference app's "Mention a user" panel.
let mentionActive = false;
let mentionStart = -1; // index of the "@" in the input's current value
let mentionIndex = 0;  // keyboard-highlighted row, for Up/Down + Enter

function mentionCandidates(query) {
  const q = (query || '').toLowerCase();
  // Same "actually here right now" filter renderRoomInfoBanner uses for its
  // "Currently in this room" line — room membership itself is persistent
  // (and can include dozens of bots/past visitors), but mentioning someone
  // who isn't actually online to see it isn't useful.
  return (lastRoomMembers || [])
    .filter((m) => m.status !== 'offline' && m.username.toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username));
}

function closeMentionPopover() {
  mentionActive = false;
  mentionStart = -1;
  mentionIndex = 0;
  $('#mentionPopover').classList.add('hidden');
  $('#mentionPopover').innerHTML = '';
}

// Scans back from the cursor to see if we're still inside an "@token" (no
// whitespace since the "@"). Returns { start, query } or null.
function findMentionContext(input) {
  const pos = input.selectionStart;
  const value = input.value;
  let i = pos - 1;
  while (i >= 0 && /[A-Za-z0-9_.-]/.test(value[i])) i--;
  if (i < 0 || value[i] !== '@') return null;
  // "@" must start a token (start of string, or preceded by whitespace) —
  // so a plain email-looking "name@x" never triggers the popover.
  if (i > 0 && !/\s/.test(value[i - 1])) return null;
  return { start: i, query: value.slice(i + 1, pos) };
}

function selectMention(username) {
  const input = $('#chatInput');
  const value = input.value;
  const pos = input.selectionStart;
  const before = value.slice(0, mentionStart);
  const after = value.slice(pos);
  const insertion = `@${username} `;
  input.value = before + insertion + after;
  const newPos = before.length + insertion.length;
  input.focus();
  input.setSelectionRange(newPos, newPos);
  closeMentionPopover();
}

function renderMentionPopover(query) {
  const pop = $('#mentionPopover');
  const candidates = mentionCandidates(query);
  mentionIndex = 0;
  if (!candidates.length) {
    pop.innerHTML = `
      <div class="mention-popover-header">👤 Mention a user</div>
      <div class="mention-popover-empty">No one matching "${escapeHtml(query)}" is in this room</div>
    `;
  } else {
    pop.innerHTML = `
      <div class="mention-popover-header">👤 Mention a user <span class="mention-popover-count">${candidates.length}</span></div>
      <div class="mention-popover-list"></div>
    `;
    const list = pop.querySelector('.mention-popover-list');
    candidates.forEach((m, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mention-popover-row' + (idx === mentionIndex ? ' active' : '');
      row.innerHTML = `
        <div class="avatar-circle small" style="background:${colorFor(m.username)}">${escapeHtml(m.username.charAt(0).toUpperCase())}</div>
        <span class="${roleClass(m)}"${usernameStyleAttr(m)}>@${escapeHtml(m.username)}</span>
      `;
      // mousedown (not click) so it fires before the input's blur
      row.addEventListener('mousedown', (e) => { e.preventDefault(); selectMention(m.username); });
      list.appendChild(row);
    });
  }
  pop.classList.remove('hidden');
}

$('#chatInput').addEventListener('input', () => {
  const input = $('#chatInput');
  const ctx = findMentionContext(input);
  if (!ctx) { if (mentionActive) closeMentionPopover(); return; }
  mentionActive = true;
  mentionStart = ctx.start;
  renderMentionPopover(ctx.query);
});
$('#chatInput').addEventListener('blur', () => {
  // Small delay so a row's mousedown (which calls preventDefault but still
  // fires after blur starts) can complete its click before we tear down.
  setTimeout(() => closeMentionPopover(), 150);
});

// Returns true if it handled the key itself (popover open), meaning the
// normal Enter-to-send handler above should NOT also run.
function mentionKeydown(e) {
  if (!mentionActive) return false;
  const pop = $('#mentionPopover');
  const rows = Array.from(pop.querySelectorAll('.mention-popover-row'));
  if (e.key === 'Escape') { closeMentionPopover(); return true; }
  if (!rows.length) return false;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    mentionIndex = Math.min(rows.length - 1, mentionIndex + 1);
    rows.forEach((r, i) => r.classList.toggle('active', i === mentionIndex));
    rows[mentionIndex].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIndex = Math.max(0, mentionIndex - 1);
    rows.forEach((r, i) => r.classList.toggle('active', i === mentionIndex));
    rows[mentionIndex].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const candidates = mentionCandidates(findMentionContext($('#chatInput'))?.query || '');
    if (candidates[mentionIndex]) selectMention(candidates[mentionIndex].username);
    return true;
  }
  return false;
}

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
  const payload = { roomId: currentRoomId, text };
  if (replyContext) payload.replyToId = replyContext.id;
  socket.emit('chat_message', payload);
  input.value = '';
  cancelReply();
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

// "Gift Gallery" card grid — one circular icon badge + name + coin-cost pill
// per gift, shared by the in-chat Send Gift picker and the Explore -> Gift
// Store screen so both pickers look and behave identically. `onSelect(gift,
// cardEl)` fires on click; the caller decides what selecting means (send
// immediately vs. just highlight-and-wait-for-a-recipient).
function buildGiftGalleryGrid(catalog, onSelect) {
  const grid = document.createElement('div');
  grid.className = 'gift-gallery-grid';
  catalog.forEach((g) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gift-gallery-card';
    card.innerHTML = `
      <div class="gift-gallery-icon">${g.emoji}</div>
      <div class="gift-gallery-name">${escapeHtml(g.name)}</div>
      <div class="gift-gallery-cost">🪙 ${g.cost.toLocaleString()}</div>
    `;
    card.addEventListener('click', () => onSelect(g, card));
    grid.appendChild(card);
  });
  return grid;
}

// Full-catalog picker, opened from the chat ⋮ menu's "Send Gift" action.
function renderSendGiftPicker(box) {
  box.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'gift-gallery-header';
  header.innerHTML = `
    <div class="gift-gallery-title">🎁 Gift Gallery</div>
    <div class="gift-gallery-subtitle">Coins · Pick a gift to send in this room</div>
  `;
  box.appendChild(header);
  box.appendChild(buildGiftGalleryGrid(allGiftsCache, (g) => sendGiftFlow(g)));
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
  renderRoomInfoBanner(); // the banner lives inside #messages too — restore it after the wipe
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
  mention: { icon: '@', bg: '#f59e0b' },
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
  resetCreateUserForm();
}

// ---------- ADMIN PANEL: CREATE USER ----------
// The only UI path to a short (3-5 letter) User ID — see POST
// /admin/users/create in routes/admin.js for why this can't just reuse the
// public Register form/endpoint (that one always replaces the CALLER's own
// session with the new account, which would log Staff out of themselves).
function resetCreateUserForm() {
  $('#createUserUsername').value = '';
  $('#createUserEmail').value = '';
  $('#createUserPassword').value = '';
  $('#createUserGender').value = 'male';
  $('#createUserCountry').value = '';
  const result = $('#createUserResult');
  result.classList.add('hidden');
  result.textContent = '';
}
$('#createUserBtn').addEventListener('click', async () => {
  const username = $('#createUserUsername').value.trim();
  const email = $('#createUserEmail').value.trim();
  const password = $('#createUserPassword').value;
  const gender = $('#createUserGender').value;
  const country = $('#createUserCountry').value;
  const result = $('#createUserResult');
  result.classList.remove('hidden');
  result.style.color = '';
  result.textContent = 'Creating…';
  try {
    const { user } = await api('/admin/users/create', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, gender, country }),
    });
    result.style.color = 'var(--success, #22c55e)';
    result.textContent = `✅ Created "${user.username}" — they can log in with the Secret Code you set.`;
    toast(`User "${user.username}" created`);
    $('#createUserUsername').value = '';
    $('#createUserEmail').value = '';
    $('#createUserPassword').value = '';
    if (lastAdminSearch) runAdminSearch();
  } catch (err) {
    result.style.color = 'var(--danger, #ef4444)';
    result.textContent = err.message;
  }
});

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
      const card = document.createElement('div');
      card.className = 'staff-user-card';

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
      const roleChip = (cls, checked, label, opts = {}) => `
        <label class="staff-role-chip${checked ? ' checked' : ''}${opts.disabled ? ' disabled' : ''}" title="${opts.title || ''}">
          <input type="checkbox" class="${cls}" data-id="${u.id}" ${checked ? 'checked' : ''} ${opts.disabled ? 'disabled' : ''}/>
          <span>${label}${opts.disabled ? ' 🔒' : ''}</span>
        </label>`;
      const rolesGridHtml = [
        roleChip('staff-toggle', u.is_staff || staffLocked, 'Staff', staffLocked ? { disabled: true, title: "This account is always Staff and this can't be changed" } : {}),
        roleChip('admin-toggle', u.is_global_admin, 'Global Admin'),
        roleChip('execboard-toggle', u.is_exec_board, 'Executive Board'),
        roleChip('countryrep-toggle', u.is_country_rep, 'Country Rep'),
        roleChip('elite-toggle', u.is_elite, 'Elite User'),
        roleChip('mentor-toggle', u.is_mentor, 'Mentor'),
        roleChip('merchant-toggle', u.is_merchant, 'Merchant'),
      ].join('');

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

      card.innerHTML = `
        <div class="staff-user-head">
          <div class="staff-user-id">#${u.id}</div>
          <div class="staff-user-name">${usernameHtml(u)}</div>
          <div class="staff-user-roles-summary">${rolesHtml}</div>
          <div class="staff-user-coins">🪙 ${Number(u.coins).toLocaleString()}</div>
        </div>
        <div class="staff-user-body">
          <div class="staff-control-group">
            <div class="staff-control-label">Level</div>
            ${levelControl}
          </div>
          <div class="staff-control-group">
            <div class="staff-control-label">Country</div>
            ${countryControl}
          </div>
        </div>
        <div class="staff-roles-section">
          <div class="staff-control-label">Roles</div>
          <div class="staff-roles-grid">${rolesGridHtml}</div>
        </div>
      `;
      tbody.appendChild(card);
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

// Tournament Arena (Explore -> Contest) — a lightweight placeholder: there's
// no scheduled-tournament backend yet, so this just shows a friendly empty
// state rather than a dead/missing link. Easy to wire up to real data later
// without touching the Explore layout.
function renderTournamentArena(box) {
  box.innerHTML = `
    <div class="empty-note">🚩 No tournament is running right now — check back later for tonight's bracket and results.</div>
  `;
}

// Effect Shop (Explore -> Store) — full-screen page (dark card grid, Shop /
// My effects tabs, direct Buy/Extend buttons) replacing the old chat-only
// "/purchase <effect>" + "/purchase confirm" flow for this entry point. The
// chat commands themselves (handlePurchaseCommand in socket.js) and the
// small popup they still reply through (showEffectStoreModal, below) are
// untouched — this is just a second, friendlier door into the same
// user_effects table, via GET/POST /api/effects.
function openEffectShop() {
  pushSubScreen('Effect Shop', (box) => renderEffectShop(box, 'shop'));
}

async function renderEffectShop(box, tab) {
  // Render the static catalog INSTANTLY with the tabs already in place (same
  // "don't sit blank waiting on the server" idea as the old modal), then
  // swap in the real owned/expiry data once /api/effects answers.
  box.innerHTML = '';
  box.appendChild(effectShopTabs(box, tab, null));
  const grid = document.createElement('div');
  grid.className = 'effect-shop-grid';
  grid.innerHTML = '<div class="empty-note">Loading…</div>';
  box.appendChild(grid);

  try {
    const { catalog, myEffects } = await api('/effects');
    box.innerHTML = '';
    box.appendChild(effectShopTabs(box, tab, myEffects.length));
    box.appendChild(effectShopGrid(box, tab === 'my' ? myEffects : catalog, tab));
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(effectShopTabs(box, tab, null));
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = err.message || 'Could not load the Effect Shop.';
    box.appendChild(note);
  }
}

function effectShopTabs(box, activeTab, ownedCount) {
  const tabs = document.createElement('div');
  tabs.className = 'effect-shop-tabs';
  const shopTab = document.createElement('button');
  shopTab.type = 'button';
  shopTab.className = 'effect-shop-tab' + (activeTab === 'shop' ? ' active' : '');
  shopTab.textContent = 'Shop';
  shopTab.addEventListener('click', () => renderEffectShop(box, 'shop'));
  const myTab = document.createElement('button');
  myTab.type = 'button';
  myTab.className = 'effect-shop-tab' + (activeTab === 'my' ? ' active' : '');
  myTab.textContent = `My effects${ownedCount != null ? ` (${ownedCount})` : ''}`;
  myTab.addEventListener('click', () => renderEffectShop(box, 'my'));
  tabs.appendChild(shopTab);
  tabs.appendChild(myTab);
  return tabs;
}

function effectShopGrid(box, effects, tab) {
  const grid = document.createElement('div');
  grid.className = 'effect-shop-grid';
  if (!effects.length) {
    grid.innerHTML = `<div class="empty-note">${tab === 'my' ? "You don't own any effects yet — grab one from the Shop tab." : 'Nothing on sale right now.'}</div>`;
    return grid;
  }
  effects.forEach((e) => {
    const canAfford = currentUser.coins >= e.price;
    const daysLeft = e.expiresAt
      ? Math.max(0, Math.ceil((new Date(e.expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 86400000))
      : null;
    const card = document.createElement('div');
    card.className = 'effect-card';
    card.innerHTML = `
      <div class="effect-card-preview">${e.emoji}</div>
      ${e.owned ? '<div class="effect-card-owned-tag">OWNED</div>' : ''}
      <div class="effect-card-name">${escapeHtml(e.label)}</div>
      <div class="effect-card-slug">/${e.key}</div>
      <div class="effect-card-meta">${e.owned && daysLeft != null
        ? `⏱ ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
        : `${e.price.toLocaleString()} coins · ${e.days} days`}</div>
      <button class="effect-card-buy-btn" ${e.owned || canAfford ? '' : 'disabled'}>
        ${e.owned ? 'Extend' : canAfford ? 'Buy' : '🔒 Need more'}
      </button>
    `;
    card.querySelector('.effect-card-buy-btn').addEventListener('click', async () => {
      if (!e.owned && !canAfford) return;
      try {
        const res = await api(`/effects/${e.key}/buy`, { method: 'POST' });
        currentUser = res.user;
        updateUserBar();
        toast(`${e.emoji} /${e.key} ${e.owned ? 'extended' : 'purchased'}!`);
        renderEffectShop(box, tab);
      } catch (err) {
        toast(err.message);
      }
    });
    grid.appendChild(card);
  });
  return grid;
}

// ---------- EXPLORE HUB ----------
// Sectioned layout: a full-width Announcements banner, then STORE (compact
// icon tiles), CONTEST (a 2-column grid of list rows), COMMUNITY (a plain
// list), and MORE (another compact 2-up row) — plus any staff-only tools
// grouped into their own trailing STAFF section so nothing existing is lost.
function renderExplore(box) {
  box.innerHTML = '';

  const announcement = document.createElement('div');
  announcement.className = 'explore-announcement-banner';
  announcement.innerHTML = `
    <div class="list-icon" style="background:#eab30822; color:#eab308">📣</div>
    <div class="list-row-body">
      <div class="list-row-title">Announcements</div>
      <div class="list-row-subtitle">News & updates from Staff</div>
    </div>
    <div class="list-chevron">›</div>
  `;
  announcement.addEventListener('click', () => pushSubScreen('Announcements', renderPostsScreen('announcement')));
  box.appendChild(announcement);

  function sectionWrap(label) {
    box.appendChild(sectionLabel(label));
    const wrap = document.createElement('div');
    wrap.className = 'explore-section-wrap';
    box.appendChild(wrap);
    return wrap;
  }
  function storeTile({ icon, iconBg, title, onClick }) {
    const tile = document.createElement('div');
    tile.className = 'explore-store-tile';
    tile.innerHTML = `
      <div class="explore-store-tile-icon" style="background:${iconBg}22; color:${iconBg}">${icon}</div>
      <div class="explore-store-tile-title">${escapeHtml(title)}</div>
    `;
    tile.addEventListener('click', onClick);
    return tile;
  }

  // STORE
  const storeWrap = sectionWrap('STORE');
  const storeRow = document.createElement('div');
  storeRow.className = 'explore-store-row';
  storeRow.appendChild(storeTile({ icon: '🎁', iconBg: '#ec4899', title: 'Gift Store', onClick: () => pushSubScreen('Gift Store', renderGiftStore) }));
  storeRow.appendChild(storeTile({ icon: '🎨', iconBg: '#8b5cf6', title: 'Color Shop', onClick: () => pushSubScreen('Color Shop', renderColorShop) }));
  storeRow.appendChild(storeTile({ icon: '✨', iconBg: '#f97316', title: 'Effect Shop', onClick: openEffectShop }));
  storeRow.appendChild(storeTile({ icon: '🎖️', iconBg: '#a855f7', title: 'Badge Store', onClick: () => pushSubScreen('Badge Store', renderBadgeStore) }));
  storeRow.appendChild(storeTile({ icon: '🌟', iconBg: '#f43f5e', title: 'Sticker Store', onClick: () => pushSubScreen('Sticker Store', renderStickerStore) }));
  storeWrap.appendChild(storeRow);

  // CONTEST
  const contestWrap = sectionWrap('CONTEST');
  const contestGrid = document.createElement('div');
  contestGrid.className = 'explore-2col-grid';
  contestGrid.appendChild(listRow({ icon: '🎁', iconBg: '#ef4444', title: 'Gift Contest', subtitle: 'Top gifters', onClick: () => pushSubScreen('Gift Contest', renderLeaderboardScreen('gifts')) }));
  contestGrid.appendChild(listRow({ icon: '🏆', iconBg: '#eab308', title: 'Legendary Contest', subtitle: 'Top players by spend', onClick: () => pushSubScreen('Legendary Contest', renderLeaderboardScreen('spend')) }));
  contestGrid.appendChild(listRow({ icon: '🚩', iconBg: '#10b981', title: 'Tournament Arena', subtitle: "Tonight's tournament and results", onClick: () => pushSubScreen('Tournament Arena', renderTournamentArena) }));
  contestGrid.appendChild(listRow({ icon: '📊', iconBg: '#06b6d4', title: 'Leader Board', subtitle: 'Top game winners', onClick: () => pushSubScreen('Leader Board', renderLeaderboardScreen('wins')) }));
  contestWrap.appendChild(contestGrid);

  // COMMUNITY
  const communityWrap = sectionWrap('COMMUNITY');
  communityWrap.appendChild(listRow({ icon: '👥', iconBg: '#3b82f6', title: 'Members', subtitle: 'Staff, global mods, mentors & merchants', onClick: () => pushSubScreen('Members', renderMembersGroups) }));
  communityWrap.appendChild(listRow({ icon: '🧑‍💼', iconBg: '#10b981', title: 'Merchant', subtitle: 'Become a merchant or manage your merchant role', onClick: () => pushSubScreen('Merchant', renderMerchantApply) }));
  communityWrap.appendChild(listRow({ icon: '⌨️', iconBg: '#64748b', title: 'Command List', subtitle: 'All chat commands and their responses', onClick: () => pushSubScreen('Command List', renderCommandList) }));
  if (!currentUser.is_global_admin) {
    communityWrap.appendChild(listRow({ icon: '🛡️', iconBg: '#dc2626', title: 'Become a Global Administrator', subtitle: 'Apply for Global Administrator permissions', onClick: () => pushSubScreen('Become a Global Administrator', renderGlobalAdminApply) }));
  }
  communityWrap.appendChild(listRow({ icon: '🛡️', iconBg: '#64748b', title: 'Badge Panel', subtitle: 'Manage and equip your earned badges', onClick: () => pushSubScreen('Badge Panel', renderBadgePanel) }));

  // MORE
  const moreWrap = sectionWrap('MORE');
  const moreGrid = document.createElement('div');
  moreGrid.className = 'explore-2col-grid';
  moreGrid.appendChild(listRow({ icon: '🎰', iconBg: '#8b5cf6', title: 'Daily Spin', subtitle: 'One free spin every day', onClick: () => pushSubScreen('Daily Spin', renderSpin) }));
  moreGrid.appendChild(listRow({ icon: '🧑‍🎨', iconBg: '#22c55e', title: 'Avatar Maker', subtitle: 'Build your character', onClick: () => pushSubScreen('Avatar Maker', renderAvatarMaker) }));
  moreWrap.appendChild(moreGrid);

  // MENTOR (only shown to Mentor accounts) — their own merchants + requests,
  // scoped server-side to just this mentor (see GET /api/mentor/dashboard
  // and GET /api/merchant/pending's mentor-only queue).
  if (currentUser.is_mentor) {
    const mentorWrap = sectionWrap('MENTOR');
    mentorWrap.appendChild(listRow({ icon: '📊', iconBg: '#ef4444', title: 'Mentor Dashboard', subtitle: 'Your merchants, daily gain & trial status', onClick: () => pushSubScreen('Mentor Dashboard', renderMentorDashboard) }));
    mentorWrap.appendChild(listRow({ icon: '📋', iconBg: '#ef4444', title: 'Merchant Requests', subtitle: 'Accept or reject your merchants’ requests', onClick: () => pushSubScreen('Merchant Requests', renderMerchantApplications) }));
  }

  // STAFF (unchanged tools, just grouped into their own section)
  if (currentUser.is_staff) {
    const staffWrap = sectionWrap('STAFF');
    staffWrap.appendChild(listRow({ icon: '🛠️', iconBg: '#64748b', title: 'Gift Store Admin', subtitle: 'Add, edit, or remove gifts', onClick: () => pushSubScreen('Gift Store Admin', renderGiftStoreAdmin) }));
    staffWrap.appendChild(listRow({ icon: '📋', iconBg: '#64748b', title: 'Merchant Applications', subtitle: 'Review pending Merchant requests (all Mentors)', onClick: () => pushSubScreen('Merchant Applications', renderMerchantApplications) }));
    staffWrap.appendChild(listRow({ icon: '📋', iconBg: '#dc2626', title: 'Global Administrator Applications', subtitle: 'Review pending Global Administrator requests', onClick: () => pushSubScreen('Global Administrator Applications', renderGlobalAdminApplications) }));
  }
}
function openDrawerExplore() { openSubScreenFromDrawer('Explore', renderExplore); }

// ---------- MEMBERS / COMMUNITY ----------
const MEMBER_GROUP_META = {
  exec_board: { icon: '🏅', color: '#6366f1', subtitle: 'FOUNDER • Owner • Executive' },
  global_admin: { icon: '🛡️', color: '#eab308', subtitle: 'Admin IDs' },
  country_rep: { icon: '🌐', color: '#64748b', subtitle: 'Country representatives' },
  staff: { icon: '🪪', color: '#10b981', subtitle: 'Staff IDs' },
  elite: { icon: '🛡️', color: '#0ea5e9', subtitle: 'Elite members' },
  mentor: { icon: '💼', color: '#ef4444', subtitle: 'Mentors' },
  merchant: { icon: '🏪', color: '#a855f7', subtitle: 'Verified merchants' },
  top_level: { icon: '🏆', color: '#f59e0b', subtitle: 'Highest level users' },
};

// A horizontal, color-themed category card (icon + title/subtitle + a
// matching-color chevron bubble) — used only for the Community directory,
// where each category gets its own identity color; exploreCard() (the
// vertical icon-on-top tile) stays the default for Badge Store/Panel etc.
function communityCard({ icon, color, title, subtitle, onClick }) {
  const card = document.createElement('div');
  card.className = 'community-card';
  card.style.setProperty('--card-color', color || '#3b82f6');
  card.innerHTML = `
    <div class="community-card-icon">${icon || '•'}</div>
    <div class="community-card-body">
      <div class="community-card-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="community-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
    </div>
    <div class="community-card-chevron">›</div>
  `;
  if (onClick) card.addEventListener('click', onClick);
  return card;
}

// The "Community" role directory (Executive Board, Admin, Country Rep,
// Staff, Elite under "Management"; Mentor, Merchant, Top Level under
// "Community") — same underlying /members grouping as before.
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
      const meta = MEMBER_GROUP_META[g.key] || { icon: '👤', color: '#64748b', subtitle: `${g.count} member${g.count === 1 ? '' : 's'}` };
      grid.appendChild(communityCard({
        icon: meta.icon, color: meta.color, title: g.label, subtitle: meta.subtitle,
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
      if (!users.length) { box.innerHTML = `<div class="empty-note">No ${escapeHtml(label)} yet.</div>`; }
      users.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'member-row';
        row.innerHTML = `
          ${avatarPreviewHtml(u).replace('avatar-maker-preview', 'avatar-maker-preview member-row-avatar')}
          <div class="member-row-body">
            <div class="member-row-name">${usernameHtml(u)}</div>
            <div class="member-row-sub">Level ${u.level}${u.country ? ` · ${escapeHtml(u.country)}` : ''}</div>
          </div>
          ${u.country ? `<div class="member-row-pill">${countryFlag(u.country)} ${escapeHtml(u.country)}</div>` : ''}
          <div class="list-chevron">›</div>
        `;
        row.addEventListener('click', () => openUserProfile(u.username));
        box.appendChild(row);
      });
      const back = document.createElement('div');
      back.className = 'member-list-back-btn';
      back.textContent = '← All categories';
      back.addEventListener('click', () => subScreenBack());
      box.appendChild(back);
    } catch (err) {
      box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    }
  };
}

// ---------- LEADERBOARDS / CONTESTS ----------
// Each board (wins/spend/gifts) can be viewed over a few time windows — All
// Time (the lifetime running total, same as before this feature existed),
// Today, Last Day, Last Week, Last Month — via server-computed rankings (see
// routes/leaderboard.js). Switching tabs re-fetches and re-renders just the
// results list underneath; the tab bar itself stays put.
const LEADERBOARD_PERIOD_ORDER = ['alltime', 'today', 'last_day', 'last_week', 'last_month'];
const LEADERBOARD_PERIOD_LABELS = { alltime: 'All Time', today: 'Today', last_day: 'Last Day', last_week: 'Last Week', last_month: 'Last Month' };

function renderLeaderboardScreen(board) {
  return async function (box) {
    box.innerHTML = '';
    let period = 'alltime';

    const tabBar = document.createElement('div');
    tabBar.className = 'leaderboard-period-tabs';
    LEADERBOARD_PERIOD_ORDER.forEach((p) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'leaderboard-period-tab' + (p === period ? ' active' : '');
      tab.textContent = LEADERBOARD_PERIOD_LABELS[p];
      tab.dataset.period = p;
      tab.addEventListener('click', () => {
        if (p === period) return;
        period = p;
        tabBar.querySelectorAll('.leaderboard-period-tab').forEach((t) => t.classList.toggle('active', t.dataset.period === period));
        loadResults();
      });
      tabBar.appendChild(tab);
    });
    box.appendChild(tabBar);

    const resultsEl = document.createElement('div');
    resultsEl.className = 'leaderboard-results';
    box.appendChild(resultsEl);

    async function loadResults() {
      resultsEl.innerHTML = '<div class="empty-note">Loading…</div>';
      try {
        const { label, subtitle, entries } = await api(`/leaderboard/${board}?period=${period}`);
        resultsEl.innerHTML = '';
        resultsEl.appendChild(sectionLabel(subtitle || label));
        if (!entries.length) {
          resultsEl.innerHTML += `<div class="empty-note">No rankings yet for ${escapeHtml(LEADERBOARD_PERIOD_LABELS[period])} — be the first!</div>`;
          return;
        }

        // #1 gets a big featured card (gold ring avatar + country flag badge,
        // name, score) instead of sitting flush in the list with everyone
        // else; ranks 2+ render as the regular compact rows underneath.
        const top = entries[0];
        const topCard = document.createElement('div');
        topCard.className = 'leaderboard-top-card';
        topCard.innerHTML = `
          <div class="leaderboard-top-avatar-wrap">
            <div class="leaderboard-top-avatar" style="background:${colorFor(top.username)}">${(top.username || '?').charAt(0).toUpperCase()}</div>
            ${top.country ? `<span class="leaderboard-top-flag">${countryFlag(top.country)}</span>` : ''}
          </div>
          <div class="leaderboard-top-rank">🥇 #1 ON THE ${escapeHtml((label || 'LEADER BOARD').toUpperCase())}</div>
          <div class="leaderboard-top-name">${usernameHtml(top)}</div>
          <div class="leaderboard-top-meta">${escapeHtml(top.country || '')}${top.country ? ' · ' : ''}Level ${top.level}</div>
          <div class="leaderboard-top-score">${top.score.toLocaleString()}</div>
        `;
        resultsEl.appendChild(topCard);

        const medals = ['', '🥈', '🥉'];
        entries.slice(1).forEach((u, idx) => {
          const i = idx + 1; // true rank index (0-based), rank 2 == i===1
          const row = document.createElement('div');
          row.className = 'list-row';
          row.innerHTML = `
            <div class="list-row-rank-num">${medals[i] || (i + 1)}</div>
            <div class="avatar-circle small" style="background:${colorFor(u.username)}">${(u.username || '?').charAt(0).toUpperCase()}</div>
            <div class="list-row-body">
              <div class="list-row-title">${u.country ? `<span class="list-row-flag">${countryFlag(u.country)}</span>` : ''}${usernameHtml(u)}</div>
              <div class="list-row-subtitle">${u.country ? `${escapeHtml(u.country)} · ` : ''}Level ${u.level}</div>
            </div>
            <div class="list-row-trailing">${u.score.toLocaleString()}</div>
          `;
          resultsEl.appendChild(row);
        });
      } catch (err) {
        resultsEl.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
      }
    }

    loadResults();
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

// A slice's fill color — coins and XP get their own two-tone palette
// (alternating shade per index so neighboring slices of the same prize type
// still read as separate wedges), with the actual SPIN_COLOR_WINNER used to
// repaint whichever slice the wheel actually lands on afterward.
const SPIN_COIN_COLORS = ['#111827', '#1f2937'];
const SPIN_XP_COLORS = ['#4c1d95', '#5b21b6'];
const SPIN_COLOR_WINNER = '#2563eb';

function spinSliceColor(prize, i) {
  const pair = prize.type === 'xp' ? SPIN_XP_COLORS : SPIN_COIN_COLORS;
  return pair[i % 2];
}

function spinWheelGradient(prizes, winnerIdx) {
  const n = prizes.length;
  const sliceAngle = 360 / n;
  return prizes
    .map((p, i) => {
      const color = i === winnerIdx ? SPIN_COLOR_WINNER : spinSliceColor(p, i);
      return `${color} ${i * sliceAngle}deg ${(i + 1) * sliceAngle}deg`;
    })
    .join(', ');
}

// Builds the wheel + pointer + center button, with one label per prize
// rotated out to sit mid-slice (rotate to the slice's angle, push out along
// the now-rotated axis, rotate back so the text itself stays upright).
function buildSpinWheelHtml(prizes) {
  const n = prizes.length;
  const sliceAngle = 360 / n;
  const labels = prizes
    .map((p, i) => {
      const mid = i * sliceAngle + sliceAngle / 2;
      const text = p.type === 'coins' ? `${p.amount}<small>coins</small>` : `+${p.amount}<small>XP</small>`;
      return `<div class="spin-wheel-label" style="transform: rotate(${mid}deg) translateY(-96px) rotate(${-mid}deg)">${text}</div>`;
    })
    .join('');
  return `
    <div class="spin-wheel-wrap">
      <div class="spin-wheel-pointer">▼</div>
      <div class="spin-wheel" id="spinWheel" style="background: conic-gradient(${spinWheelGradient(prizes, -1)});">
        ${labels}
      </div>
      <button type="button" class="spin-wheel-center" id="spinCenterBtn">SPIN</button>
    </div>
  `;
}

// Spins the wheel to land on `prize` (the real result the server already
// committed) — never a fake animation that could disagree with what the
// player actually won. Keeps spinning forward from wherever it last
// stopped (via the element's own data-rotation) so a second spin never
// looks like it snaps backward.
function spinWheelTo(wheel, prizes, prize, onDone) {
  const n = prizes.length;
  const sliceAngle = 360 / n;
  let idx = prizes.findIndex((p) => p.type === prize.type && p.amount === prize.amount);
  if (idx === -1) idx = 0;
  const sliceMid = idx * sliceAngle + sliceAngle / 2;
  const jitter = (Math.random() - 0.5) * sliceAngle * 0.6; // lands somewhere inside the slice, not dead-center every time
  const extraSpins = 6;

  const current = parseFloat(wheel.dataset.rotation || '0');
  const currentMod = ((current % 360) + 360) % 360;
  // Pointer is fixed at the top (0deg) — rotating the wheel clockwise by R
  // moves the point that was at angle A to (A + R) mod 360. We need the
  // slice's own angle to land on 0 (mod 360) under the pointer.
  const targetMod = ((360 - sliceMid - jitter) % 360 + 360) % 360;
  let delta = targetMod - currentMod;
  if (delta < 0) delta += 360;
  const final = current + extraSpins * 360 + delta;

  wheel.style.transition = 'transform 4.2s cubic-bezier(0.12, 0.73, 0.14, 1)';
  wheel.style.transform = `rotate(${final}deg)`;
  wheel.dataset.rotation = String(final);

  setTimeout(() => {
    wheel.style.background = `conic-gradient(${spinWheelGradient(prizes, idx)})`;
    onDone();
  }, 4300);
}

function spinResultBannerHtml(prize) {
  const label = prize.type === 'coins' ? `${prize.amount} coins` : `+${prize.amount} XP`;
  const icon = prize.type === 'coins' ? '🪙' : '⚡';
  return `
    <div class="spin-result-banner">
      <div class="spin-result-icon">${icon}</div>
      <div class="spin-result-text">
        <div class="spin-result-label">Today you won</div>
        <div class="spin-result-amount">${label}</div>
      </div>
    </div>
  `;
}

function renderSpinCountdownCard(secondsLeft) {
  const total = Math.max(0, Math.round(secondsLeft));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // Progress bar fills back up toward the 24h cooldown as it elapses —
  // "how close is the next spin", not "how much is left".
  const pct = Math.max(0, Math.min(100, 100 - (total / (24 * 3600)) * 100));
  return `
    <div class="spin-countdown-card">
      <div class="spin-countdown-card-label">NEXT FREE SPIN IN</div>
      <div class="spin-countdown-digits">
        <div class="spin-countdown-box"><div class="spin-countdown-num" id="spinH">${String(h).padStart(2, '0')}</div><div class="spin-countdown-unit">HOURS</div></div>
        <div class="spin-countdown-box"><div class="spin-countdown-num" id="spinM">${String(m).padStart(2, '0')}</div><div class="spin-countdown-unit">MIN</div></div>
        <div class="spin-countdown-box"><div class="spin-countdown-num" id="spinS">${String(s).padStart(2, '0')}</div><div class="spin-countdown-unit">SEC</div></div>
      </div>
      <div class="spin-progress-track"><div class="spin-progress-fill" id="spinProgressFill" style="width:${pct}%"></div></div>
      <div class="spin-countdown-note">A new spin unlocks every 24 hours.</div>
    </div>
  `;
}

async function renderSpin(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { canSpin, secondsLeft, prizes } = await api('/spin/status');
    box.innerHTML = `
      <div id="spinResultSlot"></div>
      ${buildSpinWheelHtml(prizes)}
      <div id="spinCountdownSlot">${canSpin ? '' : renderSpinCountdownCard(secondsLeft)}</div>
    `;
    const wheel = box.querySelector('#spinWheel');
    const centerBtn = box.querySelector('#spinCenterBtn');

    if (canSpin) {
      centerBtn.textContent = 'SPIN';
      centerBtn.addEventListener('click', async () => {
        centerBtn.disabled = true;
        centerBtn.textContent = '…';
        try {
          const result = await api('/spin/play', { method: 'POST' });
          spinWheelTo(wheel, prizes, result.prize, () => {
            box.querySelector('#spinResultSlot').innerHTML = spinResultBannerHtml(result.prize);
            box.querySelector('#spinCountdownSlot').innerHTML = renderSpinCountdownCard(86400);
            centerBtn.textContent = 'DONE';
            centerBtn.disabled = false;
            centerBtn.onclick = () => renderSpin(box);
          });
        } catch (err) {
          toast(err.message);
          centerBtn.disabled = false;
          centerBtn.textContent = 'SPIN';
        }
      });
    } else {
      centerBtn.textContent = 'DONE';
      centerBtn.disabled = true;
      let left = secondsLeft;
      const timer = setInterval(() => {
        left -= 1;
        if (!box.isConnected) return clearInterval(timer);
        if (left <= 0) { clearInterval(timer); renderSpin(box); return; }
        const slot = box.querySelector('#spinCountdownSlot');
        if (slot) slot.innerHTML = renderSpinCountdownCard(left);
      }, 1000);
    }
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- COLOR SHOP ----------
// Color Shop (tiered redesign) — "My Owned Colors" (role perks + purchased
// tiers you hold, each toggleable on/off) above "Available Colors" (the
// 8-tier catalog as 2-column cards: badge icon, price, duration/bold tag,
// a couple of perk icons, and Buy/Need more).
async function renderColorShop(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { catalog, myColors } = await api('/colors');
    box.innerHTML = '';

    const coinsRow = document.createElement('div');
    coinsRow.className = 'color-shop-coins-row';
    coinsRow.textContent = `🪙 ${currentUser.coins.toLocaleString()}`;
    box.appendChild(coinsRow);

    // ---- My Owned Colors ----
    if (myColors.length) {
      const ownedSection = document.createElement('div');
      ownedSection.className = 'color-owned-section';
      ownedSection.innerHTML = `
        <div class="color-owned-header">
          <div>
            <div class="color-owned-title">🏅 My Owned Colors</div>
            <div class="color-owned-subtitle">Toggle each color on/off. When OFF, your role color (mod/user) shows.</div>
          </div>
          <div class="color-owned-count">${myColors.length}</div>
        </div>
      `;
      myColors.forEach((c) => {
        const daysLeft = c.expiresAt ? Math.max(1, Math.ceil((new Date(c.expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
        const row = document.createElement('div');
        row.className = 'color-owned-row' + (c.active ? ' active' : '');
        row.innerHTML = `
          <span class="color-badge big" style="background:linear-gradient(135deg, ${c.ring1}, ${c.ring2}); border-color:${c.ring1}">${c.icon || '🎨'}</span>
          <div class="list-row-body">
            <div class="list-row-title">${escapeHtml(c.name)} ${c.active ? '<span class="color-active-tag">ACTIVE</span>' : ''}</div>
            <div class="list-row-subtitle">${daysLeft != null ? `⏱ ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Role perk'}</div>
          </div>
          <label class="color-toggle-switch">
            <input type="checkbox" class="color-toggle-input" ${c.active ? 'checked' : ''} />
            <span class="color-toggle-slider"></span>
          </label>
        `;
        row.querySelector('.color-toggle-input').addEventListener('change', async (e) => {
          const on = e.target.checked;
          try {
            const res = await api(`/colors/${c.key}/toggle`, { method: 'POST', body: JSON.stringify({ on }) });
            currentUser = res.user;
            updateUserBar();
            renderColorShop(box);
          } catch (err) {
            toast(err.message);
            e.target.checked = !on;
          }
        });
        ownedSection.appendChild(row);
      });
      box.appendChild(ownedSection);
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

    // ---- Available Colors ----
    box.appendChild(sectionLabel(`Available Colors · ${catalog.length} styles`));
    const grid = document.createElement('div');
    grid.className = 'color-catalog-grid';
    catalog.forEach((c) => {
      const canAfford = currentUser.coins >= c.cost;
      const card = document.createElement('div');
      card.className = 'color-tier-card';
      card.style.setProperty('--tier-ring1', c.ring1);
      card.style.setProperty('--tier-ring2', c.ring2);
      card.innerHTML = `
        <div class="color-tier-strip"></div>
        <div class="color-tier-badge-wrap">
          <span class="color-badge huge" style="background:linear-gradient(135deg, ${c.ring1}, ${c.ring2}); border-color:${c.ring1}">${c.icon}</span>
        </div>
        <div class="color-tier-name"><span class="color-tier-dot" style="background:${c.hex}"></span>${escapeHtml(c.name)}</div>
        <div class="color-tier-price">${c.cost.toLocaleString()}</div>
        <div class="color-tier-tag">${c.days} days${c.bold ? ' · bold' : ''}</div>
        <div class="color-tier-perks">
          <span title="Custom badge included">🖼️</span>
          <span title="${c.voicePerk ? 'Voice perk included' : 'No voice perk'}">${c.voicePerk ? '🎤' : '🚫🎤'}</span>
        </div>
        ${currentUser.is_staff ? `
          <div class="color-tier-price-edit">
            <input type="number" class="color-price-input" value="${c.cost}" min="1" max="5000000" />
            <button type="button" class="color-price-save-btn">Save</button>
          </div>
        ` : ''}
        <button class="color-tier-buy-btn" ${c.owned || canAfford ? '' : 'disabled'}>
          ${c.owned ? '✓ Owned — Extend' : canAfford ? 'Buy' : '🔒 Need more'}
        </button>
      `;
      card.querySelector('.color-tier-buy-btn').addEventListener('click', async () => {
        if (!c.owned && !canAfford) return;
        try {
          const res = await api(`/colors/${c.id}/buy`, { method: 'POST' });
          currentUser = res.user;
          updateUserBar();
          toast(`${c.name} equipped!`);
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      const saveBtn = card.querySelector('.color-price-save-btn');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const priceInput = card.querySelector('.color-price-input');
        const cost = Math.round(Number(priceInput.value));
        if (!cost || cost < 1) return toast('Enter a valid price');
        try {
          await api(`/colors/${c.id}/price`, { method: 'POST', body: JSON.stringify({ cost }) });
          toast(`${c.name} price updated`);
          renderColorShop(box);
        } catch (err) {
          toast(err.message);
        }
      });
      grid.appendChild(card);
    });
    box.appendChild(grid);
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

// Banners at the top of the chat log itself — who manages the room, a
// welcome message, and who's currently in it — shown without opening a menu,
// mirroring mig66's per-room chat header. Silence/moderator management
// stays in the ⋮ → Room Info screen; this is just the summary view of the
// same data. They live as the first children of #messages (not pinned above
// it) so they scroll away with the rest of the conversation like normal chat
// content instead of sitting fixed in place forever — ensureRoomBannerHost()
// (re)creates the two host elements there any time #messages gets wiped and
// rebuilt (room switch, Clear Chat, ...).
function ensureRoomBannerHost() {
  const container = $('#messages');
  if (!container) return null;
  let banner = document.getElementById('roomInfoBanner');
  if (!banner || !container.contains(banner)) {
    banner = document.createElement('div');
    banner.id = 'roomInfoBanner';
    container.insertBefore(banner, container.firstChild);
  }
  let announcement = document.getElementById('announcementBanner');
  if (!announcement || !container.contains(announcement)) {
    announcement = document.createElement('div');
    announcement.id = 'announcementBanner';
    announcement.className = 'hidden';
    banner.after(announcement);
  }
  return { banner, announcement };
}

// Announcement banner — shows/hides itself alongside the room-info banner
// (same trigger points: entering a room, switching rooms, a live membership
// update), so it's always in sync with whichever chat screen is on view
// without needing its own separate set of call sites.
function renderAnnouncementBanner() {
  const host = ensureRoomBannerHost();
  const el = host ? host.announcement : $('#announcementBanner');
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
  const host = ensureRoomBannerHost();
  const banner = host ? host.banner : $('#roomInfoBanner');
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
  const allMemberNames = (lastRoomMembers || []).filter((m) => m.status !== 'offline').map((m) => m.username);
  // Capped display — a busy official/bot room (Legendary Bot Official,
  // Lobby, ...) can easily have 60+ names here, which with no limit would
  // make a single banner entry unreasonably tall. Capping the list here
  // (with a "+N more" tail) keeps it bounded regardless of room population;
  // the banner itself now lives inside the scrollable chat log (see
  // ensureRoomBannerHost) so it simply scrolls out of view like any other
  // message once there's enough happening below it, instead of needing to
  // collapse itself away.
  const ROOM_BANNER_MEMBER_CAP = 12;
  const memberNames = allMemberNames.slice(0, ROOM_BANNER_MEMBER_CAP);
  const extraMemberCount = allMemberNames.length - memberNames.length;
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
      <span class="room-banner-text"><b>Currently in this room:</b> ${memberNames.length ? memberNames.map((n) => `<span class="room-banner-link">${escapeHtml(n)}</span>`).join(', ') : '<span class="room-banner-sub" style="display:inline">no one yet</span>'}${extraMemberCount > 0 ? ` <span class="room-banner-sub" style="display:inline">+${extraMemberCount} more</span>` : ''}</span>
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
        <div class="avatar-photo-upload-row">
          <button type="button" class="secondary-btn" id="avatarPhotoBtn">${currentUser.avatar_photo_url ? '📷 Change photo' : '📷 Upload photo'}</button>
          ${currentUser.avatar_photo_url ? '<button type="button" class="secondary-btn" id="avatarPhotoRemoveBtn">Remove photo</button>' : ''}
          <input type="file" id="avatarPhotoInput" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden" />
        </div>
        <div class="list-section-label">FRAME COLOR</div>
        <div class="swatch-row" id="frameRow"></div>
        <div class="list-section-label">PET</div>
        <div class="swatch-row" id="petRow"></div>
        <div class="list-section-label">SCENE</div>
        <div class="swatch-row" id="sceneRow"></div>
      `;
      const photoInput = box.querySelector('#avatarPhotoInput');
      box.querySelector('#avatarPhotoBtn').addEventListener('click', () => photoInput.click());
      const removeBtn = box.querySelector('#avatarPhotoRemoveBtn');
      if (removeBtn) removeBtn.addEventListener('click', async () => {
        const { user } = await api('/avatar', { method: 'POST', body: JSON.stringify({ removePhoto: true }) });
        currentUser = user;
        updateUserBar();
        draw();
      });
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files && photoInput.files[0];
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) return toast('File too large — max 6MB');
        const buf = await file.arrayBuffer();
        socket.emit('upload_avatar_photo', { mime: file.type, data: buf }, (res) => {
          if (!res || !res.ok) return toast((res && res.error) || 'Upload failed');
          currentUser = res.user;
          updateUserBar();
          toast('Photo updated!');
          draw();
        });
      });
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
  { cmd: '/purchase effect', desc: 'See the chat effects on sale (💣 /bomb, ⚡ /thunder, 🎆 /firework, ...)' },
  { cmd: '/purchase <effect>', desc: 'Start buying an effect — then type /purchase confirm within 60s' },
  { cmd: '/purchase confirm', desc: 'Confirm a pending effect purchase (deducts coins, unlocks for 30 days)' },
  { cmd: '/purchase effect info', desc: 'See which effects you own and how many days are left' },
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
    <div class="gift-gallery-header">
      <div class="gift-gallery-title">🎁 Gift Gallery</div>
      <div class="gift-gallery-subtitle">Coins · Special &amp; Limited</div>
    </div>
    <div class="post-composer">
      <input type="text" id="giftStoreSearchInput" placeholder="Search a username..." />
      <div id="giftStoreSearchResults"></div>
    </div>
    <div id="giftStoreSelectedUserBox" class="empty-note">No recipient selected yet.</div>
    <div class="list-section-label">CHOOSE A GIFT</div>
    <div id="giftStoreGrid"></div>
    <button id="giftStoreSendBtn" class="primary-btn" style="margin-top:12px;" disabled>Send Gift</button>
  `;
  const gridHost = box.querySelector('#giftStoreGrid');
  const grid = buildGiftGalleryGrid(giftStoreCatalog, (g, card) => {
    giftStoreSelectedGift = g;
    grid.querySelectorAll('.gift-gallery-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
  });
  gridHost.replaceWith(grid);
  grid.id = 'giftStoreGrid';

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

// A circular owned/total ring, shared by Badge Store and Badge Panel — the
// one real "achievement" number this cosmetic badge system actually has.
// Deliberately NOT per-category progress bars (no "messages sent" /
// "friends added" counters exist anywhere in the backend to back those).
function badgeRingCardHtml(owned, total, title, sub) {
  const pct = total > 0 ? Math.round((owned / total) * 100) : 0;
  const deg = Math.round(pct * 3.6);
  return `
    <div class="badge-ring-card">
      <div class="badge-ring" style="background:conic-gradient(var(--accent) ${deg}deg, var(--panel-alt) ${deg}deg)">
        <div class="badge-ring-inner">
          <div class="badge-ring-pct">${pct}%</div>
          <div class="badge-ring-count">${owned}/${total}</div>
        </div>
      </div>
      <div>
        <div class="badge-ring-body-title">${escapeHtml(title)}</div>
        <div class="badge-ring-body-sub">${escapeHtml(sub)}</div>
      </div>
    </div>
  `;
}

let badgeStoreFilter = 'all';
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
  const ownedCount = data.catalog.filter((b) => b.owned).length;
  box.innerHTML = badgeRingCardHtml(ownedCount, data.catalog.length, 'Badge Collection', `${ownedCount} of ${data.catalog.length} badges owned`);

  const tabs = document.createElement('div');
  tabs.className = 'badge-filter-tabs';
  [['all', 'All'], ['owned', 'Owned'], ['locked', 'Locked']].forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'badge-filter-btn' + (badgeStoreFilter === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { badgeStoreFilter = key; renderBadgeStore(box); });
    tabs.appendChild(btn);
  });
  box.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'explore-grid';
  data.catalog
    .filter((b) => badgeStoreFilter === 'all' || (badgeStoreFilter === 'owned' ? b.owned : !b.owned))
    .forEach((b) => {
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
  box.innerHTML = badgeRingCardHtml(owned.length, data.catalog.length, 'Your Badges', owned.length ? 'Tap one to equip it on your profile' : "You don't own any badges yet — check out the Badge Store.");
  if (!owned.length) return;
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

// ---------- ACHIEVEMENTS POPUP (tap the Badges stat tile on My Profile) ----------
// Real progress toward real milestones (src/achievements.js /
// /api/achievements) — messages sent, friends, rooms joined, profile views,
// gifts sent/received, coins spent on gifts, game wins, level, account age,
// and role unlocks. Deliberately NOT the coins-for-cosmetics Badge Store —
// that's still its own thing under Explore, untouched. Every number here is
// real; a metric this app has no way to track (Followers, Following, Votes,
// seasonal Events) is never shown with a placeholder value — the "Events"
// tab stays visible but honestly empty rather than being faked or hidden.
let achievementsModalCategory = 'all';
function achievementTierPipsHtml(item) {
  if (item.special) return '';
  return `<div class="achv-tier-pips">${item.tierThresholds.map((t, i) => `<span class="achv-tier-pip${i < item.unlockedTiers ? ' filled' : ''}"></span>`).join('')}</div>`;
}
function achievementCardHtml(item) {
  const lockedIcon = item.unlockedTiers > 0 ? item.icon : '🔒';
  const ringClass = item.maxed ? 'achv-icon-ring maxed' : item.unlockedTiers > 0 ? 'achv-icon-ring active' : 'achv-icon-ring locked';
  const bottomLabel = item.special ? '' : formatCompactNum(item.target);
  return `
    <div class="achv-card${item.maxed ? ' maxed' : ''}">
      <div class="${ringClass}">
        <span class="achv-icon-emoji">${lockedIcon}</span>
        ${bottomLabel ? `<span class="achv-icon-label">${escapeHtml(bottomLabel)}</span>` : ''}
      </div>
      <div class="achv-card-body">
        <div class="achv-card-title">${escapeHtml(item.name)}${item.maxed ? ' <span class="achv-max-pill">MAX</span>' : ''}</div>
        <div class="achv-card-desc">${escapeHtml(item.special ? item.desc : item.desc)}</div>
        ${item.special
          ? ''
          : `<div class="achv-progress-track"><div class="achv-progress-fill" style="width:${item.pct}%"></div></div>
             <div class="achv-progress-row"><span></span><span class="achv-progress-value">${formatCompactNum(item.value)}/${formatCompactNum(item.target)}</span></div>
             ${achievementTierPipsHtml(item)}`
        }
      </div>
    </div>
  `;
}
function formatCompactNum(n) {
  if (n >= 1000000) return (n % 1000000 === 0 ? n / 1000000 : (n / 1000000).toFixed(1)) + 'M';
  if (n >= 1000) return (n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)) + 'K';
  return String(n);
}
async function renderAchievementsModalBody() {
  const body = $('#badgesModalBody');
  body.innerHTML = '<div class="empty-note">Loading…</div>';
  let data;
  try {
    data = await api('/achievements');
  } catch (err) {
    body.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  const pct = data.totalBadges > 0 ? Math.round((data.totalUnlocked / data.totalBadges) * 100) : 0;
  body.innerHTML = `
    <div class="achv-header">
      <div class="achv-ring" style="background:conic-gradient(#ec4899 ${Math.round(pct * 3.6)}deg, rgba(255,255,255,0.15) ${Math.round(pct * 3.6)}deg)">
        <div class="achv-ring-inner"><span class="achv-ring-trophy">🏆</span><span class="achv-ring-pct">${pct}%</span></div>
      </div>
      <div class="achv-header-body">
        <div class="achv-header-label">ACHIEVEMENTS</div>
        <div class="achv-header-count">${data.totalUnlocked}</div>
        <div class="achv-header-sub">of ${data.totalBadges} badges unlocked</div>
      </div>
    </div>
  `;
  const tabs = document.createElement('div');
  tabs.className = 'achv-tabs';
  const allBtn = document.createElement('button');
  allBtn.className = 'achv-tab' + (achievementsModalCategory === 'all' ? ' active' : '');
  allBtn.innerHTML = `✦ All <span class="achv-tab-count">${data.totalUnlocked}</span>`;
  allBtn.addEventListener('click', () => { achievementsModalCategory = 'all'; renderAchievementsModalBody(); });
  tabs.appendChild(allBtn);
  data.categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.className = 'achv-tab' + (achievementsModalCategory === cat.key ? ' active' : '');
    btn.innerHTML = `${cat.icon} ${escapeHtml(cat.label)} <span class="achv-tab-count">${cat.unlocked}/${cat.total}</span>`;
    btn.addEventListener('click', () => { achievementsModalCategory = cat.key; renderAchievementsModalBody(); });
    tabs.appendChild(btn);
  });
  body.appendChild(tabs);

  const list = document.createElement('div');
  list.className = 'achv-list';
  const cats = achievementsModalCategory === 'all' ? data.categories : data.categories.filter((c) => c.key === achievementsModalCategory);
  cats.forEach((cat) => {
    if (achievementsModalCategory === 'all') {
      const label = document.createElement('div');
      label.className = 'achv-section-label';
      label.innerHTML = `${cat.icon} <span>${escapeHtml(cat.label.toUpperCase())}</span><span class="achv-section-count">${cat.unlocked}/${cat.total}</span>`;
      list.appendChild(label);
    }
    if (!cat.items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = cat.key === 'events' ? 'No events running right now.' : 'Nothing here yet.';
      list.appendChild(empty);
      return;
    }
    cat.items.forEach((item) => {
      const card = document.createElement('div');
      card.innerHTML = achievementCardHtml(item);
      list.appendChild(card.firstElementChild);
    });
  });
  body.appendChild(list);
}
function openBadgesModal() {
  $('#badgesModal').classList.remove('hidden');
  renderAchievementsModalBody();
}
function closeBadgesModal() { $('#badgesModal').classList.add('hidden'); }
$('#closeBadgesModalBtn').addEventListener('click', closeBadgesModal);
$('#badgesModal').addEventListener('click', (e) => { if (e.target.id === 'badgesModal') closeBadgesModal(); });

// ---------- VIEWS POPUP (tap the Views stat tile on My Profile) ----------
// Same /users/me/footprint data as the full-screen "Profile Visitors"
// sub-screen (renderFootprintScreen) — just as a quick popup from the tile.
async function renderViewsModalBody() {
  const body = $('#viewsModalBody');
  body.innerHTML = '<div class="empty-note">Loading…</div>';
  let visitors;
  try {
    ({ visitors } = await api('/users/me/footprint'));
  } catch (e) {
    body.innerHTML = '<div class="empty-note">Couldn\'t load your visitors.</div>';
    return;
  }
  body.innerHTML = '';
  if (!visitors.length) {
    body.innerHTML = '<div class="empty-note">No one has viewed your profile yet.</div>';
    return;
  }
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
    row.addEventListener('click', () => { closeViewsModal(); openUserProfile(v.username); });
    body.appendChild(row);
  });
}
function openViewsModal() {
  $('#viewsModal').classList.remove('hidden');
  renderViewsModalBody();
}
function closeViewsModal() { $('#viewsModal').classList.add('hidden'); }
$('#closeViewsModalBtn').addEventListener('click', closeViewsModal);
$('#viewsModal').addEventListener('click', (e) => { if (e.target.id === 'viewsModal') closeViewsModal(); });

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
    const pendingRenewal = status.application && status.application.status === 'pending' && status.application.type === 'renewal';
    box.innerHTML = `
      <div class="empty-note">💼 You're a Merchant, under Mentor <b>${escapeHtml(status.mentorUsername || '—')}</b>.</div>
      <div class="list-row">
        <div class="list-row-body">
          <div class="list-row-title">${status.trialExpired ? '🔴 Trial expired' : '🟢 Trial active'}</div>
          <div class="list-row-subtitle">${status.trialExpiresAt ? `${status.trialExpired ? 'Expired' : 'Renews/expires'} ${new Date(status.trialExpiresAt).toLocaleDateString()}` : 'No trial date on file'}</div>
        </div>
      </div>
    `;
    if (pendingRenewal) {
      box.innerHTML += '<div class="empty-note">⏳ Your renewal request is pending review by your Mentor.</div>';
    } else {
      const renewBtn = document.createElement('button');
      renewBtn.className = 'primary-btn';
      renewBtn.style.marginTop = '10px';
      renewBtn.textContent = status.trialExpired ? 'Request renewal from your Mentor' : 'Request early renewal';
      renewBtn.addEventListener('click', async () => {
        try { await api('/merchant/renew', { method: 'POST', body: JSON.stringify({}) }); toast('Renewal requested!'); renderMerchantApply(box); }
        catch (err) { toast(err.message); }
      });
      box.appendChild(renewBtn);
    }
    return;
  }
  if (status.application && status.application.status === 'pending') {
    box.innerHTML = `
      <div class="empty-note">⏳ Your application is pending review by your chosen Mentor.</div>
      <div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">"${escapeHtml(status.application.message || '')}"</div></div></div>
    `;
    return;
  }

  let mentors = [];
  try { ({ mentors } = await api('/merchant/mentors')); } catch (err) { /* fall through — box below still renders, just with an empty picker */ }

  const note = document.createElement('div');
  note.className = 'empty-note';
  note.textContent = status.application && status.application.status === 'rejected'
    ? 'Your last application was declined — you can apply again below.'
    : "Every Merchant belongs to a Mentor — choose one, tell them why you'd like to become a Merchant, then submit.";
  box.appendChild(note);

  if (!mentors.length) {
    box.innerHTML += '<div class="empty-note">No Mentors are available to apply under right now — check back later.</div>';
    return;
  }

  const composer = document.createElement('div');
  composer.className = 'post-composer';
  composer.innerHTML = `
    <select id="merchantApplyMentor" style="width:100%; margin-bottom:8px;">
      <option value="">Choose a Mentor…</option>
      ${mentors.map((m) => `<option value="${m.id}">${escapeHtml(m.username)}</option>`).join('')}
    </select>
    <textarea id="merchantApplyMessage" placeholder="Why should you become a Merchant?" maxlength="500" rows="4" style="width:100%;"></textarea>
    <button id="merchantApplySubmitBtn" class="primary-btn">Submit Application</button>
  `;
  box.appendChild(composer);
  $('#merchantApplySubmitBtn').addEventListener('click', async () => {
    const mentorId = $('#merchantApplyMentor').value;
    const message = $('#merchantApplyMessage').value.trim();
    if (!mentorId) return toast('Choose a Mentor first');
    try {
      await api('/merchant/apply', { method: 'POST', body: JSON.stringify({ mentorId: Number(mentorId), message }) });
      toast('Application submitted!');
      renderMerchantApply(box);
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- MERCHANT APPLICATIONS (Explore -> Merchant Requests/Applications — Mentors see
// only their own queue, Staff see every pending request across all Mentors; see
// GET /api/merchant/pending) ----------
async function renderMerchantApplications(box) {
  if (!currentUser.is_staff && !currentUser.is_mentor) { box.innerHTML = '<div class="empty-note">Staff or Mentor only.</div>'; return; }
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
      box.innerHTML = '<div class="empty-note">No pending requests.</div>';
      return;
    }
    applications.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      row.innerHTML = `
        <div class="list-row-title">${escapeHtml(a.username)} ${a.type === 'renewal' ? '<span class="count-chip">Renewal</span>' : '<span class="count-chip">New</span>'}</div>
        <div class="list-row-subtitle">"${escapeHtml(a.message || '(no message)')}"</div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="primary-btn merchant-approve-btn" data-id="${a.id}">Accept</button>
          <button class="secondary-btn merchant-reject-btn" data-id="${a.id}">Reject</button>
        </div>
      `;
      row.querySelector('.merchant-approve-btn').addEventListener('click', async () => {
        try { await api(`/merchant/${a.id}/approve`, { method: 'POST' }); toast(a.type === 'renewal' ? `${a.username}'s trial was renewed` : `${a.username} is now a Merchant`); draw(); }
        catch (err) { toast(err.message); }
      });
      row.querySelector('.merchant-reject-btn').addEventListener('click', async () => {
        try { await api(`/merchant/${a.id}/reject`, { method: 'POST' }); toast('Request rejected'); draw(); }
        catch (err) { toast(err.message); }
      });
      box.appendChild(row);
    });
  };
  draw();
}

// ---------- MENTOR DASHBOARD (Explore -> Mentor Dashboard, Mentor only) ----------
// The merchants belonging to this mentor (see users.mentor_id), each one's
// today's xp gain and trial status, plus a summary strip and a shortcut into
// the pending-requests queue (renderMerchantApplications, same mentor-scoped
// GET /merchant/pending).
async function renderMentorDashboard(box) {
  if (!currentUser.is_mentor) { box.innerHTML = '<div class="empty-note">Mentor only.</div>'; return; }
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let data;
  try {
    data = await api('/mentor/dashboard');
  } catch (err) {
    box.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  box.innerHTML = '';

  const summaryRow = document.createElement('div');
  summaryRow.className = 'explore-2col-grid';
  summaryRow.style.marginBottom = '14px';
  const summaryTile = (label, value) => `
    <div class="list-row" style="flex-direction:column; align-items:flex-start; gap:2px;">
      <div class="list-row-subtitle">${escapeHtml(label)}</div>
      <div class="list-row-title" style="font-size:18px;">${value}</div>
    </div>
  `;
  summaryRow.innerHTML =
    summaryTile('Merchants', data.summary.merchantCount) +
    summaryTile('Pending requests', data.summary.pendingCount) +
    summaryTile('Trials expired', data.summary.trialsExpired) +
    summaryTile("Today's total XP gain", data.summary.totalDailyGainXp.toLocaleString());
  box.appendChild(summaryRow);

  if (data.summary.pendingCount > 0) {
    const pendingBtn = document.createElement('button');
    pendingBtn.className = 'primary-btn';
    pendingBtn.style.marginBottom = '14px';
    pendingBtn.textContent = `Review ${data.summary.pendingCount} pending request${data.summary.pendingCount === 1 ? '' : 's'}`;
    pendingBtn.addEventListener('click', () => pushSubScreen('Merchant Requests', renderMerchantApplications));
    box.appendChild(pendingBtn);
  }

  box.appendChild(sectionLabel('Your merchants'));
  if (!data.merchants.length) {
    box.innerHTML += '<div class="empty-note">No merchants under you yet.</div>';
    return;
  }
  data.merchants.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `
      <div class="avatar-circle small" style="background:${colorFor(m.username)}">${(m.username || '?').charAt(0).toUpperCase()}</div>
      <div class="list-row-body">
        <div class="list-row-title">${escapeHtml(m.username)}</div>
        <div class="list-row-subtitle">Level ${m.level} · Daily gain ${m.dailyGainXp.toLocaleString()} XP · ${m.trialExpired ? '🔴 Trial expired' : '🟢 Trial active'}${m.trialExpiresAt ? ` (${new Date(m.trialExpiresAt).toLocaleDateString()})` : ''}</div>
      </div>
    `;
    box.appendChild(row);
  });
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
// A whole-number "days since" a stored timestamp — used for "Member since" /
// the Days-here stat tile. Returns null when the date is missing/unparsable
// so callers can skip the tile rather than show a wrong "0".
function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

// One stat-grid cell — a small real-data tile (count + icon + label), never
// a fabricated metric. Used by both My Profile and someone else's profile,
// each passing only the tiles backed by data that endpoint actually returns.
function profileStatTile(icon, value, label, opts) {
  const o = opts || {};
  return `
    <div class="profile-stat-tile profile-stat-tile-${o.color || 'slate'}"${o.id ? ` id="${o.id}"` : ''}${o.clickable ? ' role="button" tabindex="0"' : ''}>
      <div class="profile-stat-icon">${icon}</div>
      <div class="profile-stat-value">${escapeHtml(String(value))}</div>
      <div class="profile-stat-label">${escapeHtml(label)}</div>
    </div>
  `;
}

// The banner + overlapping-avatar "hero" card shared by My Profile and
// someone else's profile. The role label under the name comes straight from
// resolveActiveColor() — the same resolver chat/participants/leaderboards
// already use — so it can never show a role the user doesn't actually hold.
// xpIntoLevel/xpForNextLevel are present on both the full (My Profile) and
// public (someone else's) user shapes, so the progress bar works for both.
// editable=true only on My Profile — adds the cover/avatar camera buttons
// and makes the status dot tappable (openStatusPicker, the same picker the
// Home screen's own status dot already uses). Someone else's profile never
// gets editable=true, so their photos/status can't be touched from here.
function profileHeroHtml(u, editable) {
  const active = !u.is_staff ? resolveActiveColor(u) : null;
  const roleLabel = u.is_staff ? '👑 Staff' : active ? `${active.icon ? active.icon + ' ' : ''}${escapeHtml(active.name)}` : null;
  const pct = u.xpForNextLevel ? Math.min(100, Math.round((u.xpIntoLevel / u.xpForNextLevel) * 100)) : 0;
  const genderLine = u.gender === 'male' ? '♂ Male' : u.gender === 'female' ? '♀ Female' : null;
  const bannerStyle = u.cover_photo_url ? ` style="background-image:url('${escapeHtml(u.cover_photo_url)}')"` : '';
  return `
    <div class="profile-hero">
      <div class="profile-hero-banner${u.cover_photo_url ? ' has-photo' : ''}"${bannerStyle}>
        ${editable ? '<button type="button" class="profile-hero-cover-edit-btn" id="profileCoverEditBtn" title="Change cover photo">📷 Cover</button>' : ''}
      </div>
      <div class="profile-hero-avatar">
        ${avatarPreviewHtml(u)}
        ${editable ? '<button type="button" class="profile-hero-avatar-edit-btn" id="profileAvatarEditBtn" title="Change profile picture">📷</button>' : ''}
      </div>
      <div class="profile-hero-topline">
        <div class="profile-hero-name">${usernameHtml(u)} <span class="status-dot ${statusDotClass(u.status)}${editable ? ' own' : ''}" id="${editable ? 'profileHeroStatusDot' : ''}" title="${STATUS_LABELS[u.status] || 'Offline'}${editable ? ' — tap to change' : ''}"></span>${u.equipped_badge ? ` <span title="${escapeHtml(u.equipped_badge.name)}">${u.equipped_badge.emoji}</span>` : ''}</div>
        ${roleLabel ? `<div class="profile-hero-role">${roleLabel}</div>` : ''}
        <div class="profile-hero-meta">
          <span>Level ${u.level}</span>
          ${genderLine ? `<span>· ${genderLine}</span>` : ''}
          ${u.country ? `<span>· ${countryFlag(u.country)} ${escapeHtml(u.country)}</span>` : ''}
        </div>
        <div class="profile-hero-xp-row">
          <div class="level-progress-track"><div class="level-progress-fill" style="width:${pct}%"></div></div>
          <span class="profile-hero-xp-label">${u.xpIntoLevel}/${u.xpForNextLevel} XP to next level</span>
        </div>
      </div>
      <div class="profile-hero-bio">💬 ${u.bio ? escapeHtml(u.bio) : 'No bio yet.'}</div>
    </div>
  `;
}

// Wires the cover/avatar camera buttons + status dot inside profileHeroHtml
// when it was rendered with editable=true. Kept as its own function since
// both come from hidden <input type=file> elements appended once to body,
// re-used across re-renders instead of leaking a new one each time.
let profilePhotoInputs = null;
function wireProfileHeroEditing(box) {
  if (!profilePhotoInputs) {
    const avatarInput = document.createElement('input');
    avatarInput.type = 'file'; avatarInput.accept = 'image/png,image/jpeg,image/gif,image/webp'; avatarInput.className = 'hidden';
    const coverInput = document.createElement('input');
    coverInput.type = 'file'; coverInput.accept = 'image/png,image/jpeg,image/gif,image/webp'; coverInput.className = 'hidden';
    document.body.appendChild(avatarInput);
    document.body.appendChild(coverInput);
    const handleUpload = (input, event, label) => {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) return toast('File too large — max 6MB');
        const buf = await file.arrayBuffer();
        socket.emit(event, { mime: file.type, data: buf }, (res) => {
          if (!res || !res.ok) return toast((res && res.error) || 'Upload failed');
          currentUser = res.user;
          updateUserBar();
          toast(`${label} updated!`);
          if (profilePhotoInputs.currentBox) renderMyProfile(profilePhotoInputs.currentBox);
        });
      });
    };
    handleUpload(avatarInput, 'upload_avatar_photo', 'Profile picture');
    handleUpload(coverInput, 'upload_cover_photo', 'Cover photo');
    profilePhotoInputs = { avatarInput, coverInput, currentBox: null };
  }
  profilePhotoInputs.currentBox = box;
  const avatarBtn = box.querySelector('#profileAvatarEditBtn');
  if (avatarBtn) avatarBtn.addEventListener('click', () => profilePhotoInputs.avatarInput.click());
  const coverBtn = box.querySelector('#profileCoverEditBtn');
  if (coverBtn) coverBtn.addEventListener('click', () => profilePhotoInputs.coverInput.click());
  const statusDot = box.querySelector('#profileHeroStatusDot');
  if (statusDot) statusDot.addEventListener('click', (e) => { e.stopPropagation(); openStatusPicker(e.currentTarget); });
}

async function renderMyProfile(box) {
  const u = currentUser;
  const days = daysSince(u.created_at);
  box.innerHTML = `
    ${profileHeroHtml(u, true)}
    <div class="profile-edit-row"><button type="button" id="editProfileBtn" class="secondary profile-edit-btn">✎ Edit Profile</button></div>
    <div class="profile-stat-grid" id="profileStatGrid">
      ${profileStatTile('🤝', '…', 'Friends', { color: 'blue' })}
      ${profileStatTile('🎁', u.gifts_sent_count || 0, 'Gifts', { color: 'pink' })}
      ${profileStatTile('🎖️', '…', 'Badges', { color: 'orange', id: 'profileBadgesTile', clickable: true })}
      ${profileStatTile('👣', '…', 'Views', { color: 'green', id: 'profileViewsTile', clickable: true })}
      ${days != null ? profileStatTile('📅', days, 'Days here', { color: 'indigo' }) : ''}
    </div>
    ${!u.country ? `
      <div class="list-row"><div class="list-row-body">
        <div class="list-row-title">Choose your country</div>
        <div class="list-row-subtitle">You can only pick this once, so choose carefully.</div>
        <div style="display:flex; gap:6px; margin-top:6px;">
          <select id="myCountrySelect" style="flex:1;">
            <option value="">Select a country…</option>
            ${COUNTRIES.map(([flag, name]) => `<option value="${escapeHtml(name)}">${flag} ${escapeHtml(name)}</option>`).join('')}
          </select>
          <button type="button" id="myCountrySetBtn">Save</button>
        </div>
      </div></div>` : ''}
    ${u.created_at ? `<div class="list-row"><div class="list-row-body"><div class="list-row-subtitle">Member since ${escapeHtml(formatAlertTime(u.created_at).exact)}</div></div></div>` : ''}
    <div id="profileGiftHistorySection"></div>
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
  box.querySelector('#editProfileBtn').addEventListener('click', async () => {
    const next = prompt('Update your bio (max 140 chars):', currentUser.bio || '');
    if (next === null) return;
    try {
      const { user } = await api('/auth/bio', { method: 'POST', body: JSON.stringify({ bio: next.slice(0, 140) }) });
      currentUser = user;
      updateUserBar();
      renderMyProfile(box);
    } catch (err) {
      toast(err.message);
    }
  });
  wireProfileHeroEditing(box);
  box.querySelector('#profileBadgesTile').addEventListener('click', openBadgesModal);
  box.querySelector('#profileViewsTile').addEventListener('click', openViewsModal);

  // Stat tiles that need a round trip — filled in once each loads, so the
  // hero/bio render instantly and these just pop in a moment later.
  const grid = box.querySelector('#profileStatGrid');
  const setTile = (label, value) => {
    const tiles = grid ? grid.querySelectorAll('.profile-stat-tile') : [];
    tiles.forEach((t) => {
      if (t.querySelector('.profile-stat-label').textContent === label) {
        t.querySelector('.profile-stat-value').textContent = value;
      }
    });
  };
  api('/achievements').then(({ totalUnlocked }) => setTile('Badges', totalUnlocked)).catch(() => setTile('Badges', '—'));
  api('/friends').then(({ friends }) => setTile('Friends', friends.length)).catch(() => setTile('Friends', '—'));
  api('/users/me/footprint').then(({ count }) => setTile('Views', count)).catch(() => setTile('Views', '—'));

  // A real "Gift History" section — the same ledger data My Balance's
  // Gifts filter already shows, just surfaced here too since it's part of
  // "what this profile has done", not fabricated.
  api('/coins/activity?category=gifts').then(({ activity }) => {
    const section = box.querySelector('#profileGiftHistorySection');
    if (!section) return;
    if (!activity.length) {
      section.innerHTML = '';
      return;
    }
    section.appendChild(sectionLabel('GIFT HISTORY'));
    activity.slice(0, 20).forEach((tx) => {
      const { relative, exact } = formatAlertTime(tx.created_at);
      const positive = tx.delta > 0;
      const row = document.createElement('div');
      row.className = 'notif-row';
      row.innerHTML = `
        <div class="notif-icon" style="background:${positive ? '#16a34a' : '#dc2626'}">🎁</div>
        <div class="notif-body">
          <div class="notif-title-line">${escapeHtml(tx.description)}</div>
          <div class="notif-relative">${escapeHtml(relative)} · ${escapeHtml(exact)}</div>
        </div>
        <div class="balance-tx-amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${tx.delta.toLocaleString()}</div>
      `;
      section.appendChild(row);
    });
  }).catch(() => {});
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

// Viewing someone else's profile only ever gets the narrower
// publicProfileCard shape (routes/users.js) — no coins, no friends list, no
// footprint, no total owned-badge count, since those are account-private.
// So the stat grid here is deliberately smaller than My Profile's: real
// data only, never a fake zero for a stat this view can't actually see.
async function renderUserProfile(box, username) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  let u;
  try {
    ({ user: u } = await api(`/users/${encodeURIComponent(username)}`));
  } catch (e) {
    box.innerHTML = '<div class="empty-note">User not found.</div>';
    return;
  }
  const days = daysSince(u.created_at);
  box.innerHTML = `
    ${profileHeroHtml(u, false)}
    <div class="profile-stat-grid">
      ${profileStatTile('🎁', u.gifts_sent_count || 0, 'Gifts', { color: 'pink' })}
      ${days != null ? profileStatTile('📅', days, 'Days here', { color: 'indigo' }) : ''}
    </div>
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

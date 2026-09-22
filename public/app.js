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

// The "managed by / welcome / currently in this room" banner is useful the
// moment you walk into a room, but once people are actively chatting it just
// pushes the conversation down and stays there forever if left alone. So it
// auto-collapses into a single tappable summary line after a few messages
// have gone by, and can be re-expanded (or re-collapsed) any time with a tap.
// Collapse state persists per room for the session; the message count that
// triggers it resets every time you (re-)enter a room.
const ROOM_BANNER_COLLAPSE_AFTER = 6;
const roomBannerCollapsed = new Map(); // roomId -> bool
const roomBannerMsgCount = new Map(); // roomId -> number of messages seen since entering

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

// For screens (Members, Leaderboards) that render a username from scratch:
// roleClass() already resolves the Staff-only-exception priority above, so
// this just applies whichever wins — the role badge/icon always shows
// regardless, since it's a separate permission indicator from the color.
function usernameHtml(u) {
  const cls = roleClass(u);
  if (cls) return `<span class="${cls}">${escapeHtml(u.username)}</span>${roleIcon(u)}`;
  if (u.username_color) return `<span style="color:${escapeHtml(u.username_color)}">${escapeHtml(u.username)}</span>${roleIcon(u)}`;
  return escapeHtml(u.username);
}

function updateUserBar() {
  $('#coinsDisplay').textContent = `🪙 ${currentUser.coins}`;
  $('#drawerAdmin').classList.toggle('hidden', !currentUser.is_staff);
  $('#drawerGiveCoins').classList.toggle('hidden', !(currentUser.is_staff || currentUser.is_mentor || currentUser.is_merchant));

  paintAvatar($('#profileAvatar'), currentUser.username);
  $('#profileUsername').textContent = currentUser.username;
  $('#profileUsername').className = roleClass(currentUser);
  $('#profileLevelBadge').textContent = `⚡ ${currentUser.level}`;
  $('#profileBio').textContent = currentUser.bio || 'No bio yet.';

  const into = currentUser.xpIntoLevel || 0;
  const need = currentUser.xpForNextLevel || 1;
  const pct = Math.max(2, Math.min(100, Math.round((into / need) * 100)));
  $('#xpBarFill').style.width = pct + '%';

  // Nav drawer profile card
  paintAvatar($('#drawerAvatar'), currentUser.username);
  $('#drawerUsername').textContent = currentUser.username;
  $('#drawerUsername').className = 'drawer-profile-name ' + roleClass(currentUser);
  $('#drawerLevel').textContent = currentUser.level;
  $('#drawerXp').textContent = currentUser.xp;
  $('#drawerCoins').textContent = currentUser.coins;
}

// ---------- NAVIGATION ----------
function showScreen(name) {
  $('#homeView').classList.toggle('hidden', name !== 'home');
  $('#roomsView').classList.toggle('hidden', name !== 'rooms');
  $('#chatScreen').classList.toggle('hidden', name !== 'chat');
  $('#navHomeBtn').classList.toggle('active', name === 'home');
  $('#navRoomsBtn').classList.toggle('active', name === 'rooms');
  closeDrawer();
  if (name === 'home') refreshHome();
  if (name === 'rooms') refreshRooms();
}

$('#navHomeBtn').addEventListener('click', () => showScreen('home'));
$('#navRoomsBtn').addEventListener('click', () => showScreen('rooms'));

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

$('#alertsBtn').addEventListener('click', openAlerts);
$('#emailsBtn').addEventListener('click', openEmails);
$('#friendsBtn').addEventListener('click', openFriends);

// ---------- SOCKET ----------
function connectSocket() {
  socket = io();

  socket.on('chat_message', (msg) => appendMessage(msg));
  socket.on('system_message', (text) => appendMessage({ type: 'system', content: text, username: '' }));
  // Personal notices (coins/gifts given directly to you) are never room events —
  // show as a toast only, never as a message inside whatever room happens to be open.
  socket.on('personal_notice', (text) => toast(text));
  socket.on('error_message', (msg) => toast('⚠️ ' + msg));
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
  socket.on('room_members', (members) => { lastRoomMembers = members; renderRoomMembers(members); renderRoomInfoBanner(); });
  socket.on('kicked', ({ roomId, by, reason }) => {
    if (reason === 'timeout') toast('⏳ You were removed from the room after 5 hours of inactivity');
    else if (reason === 'bump') toast(`↪️ You were bumped from the room by ${by} — you can rejoin in 5 minutes`);
    else toast(`⛔ You were kicked from the room by ${by} — you can rejoin in 10 minutes`);
    openRoomTabs = openRoomTabs.filter((r) => r.id !== roomId);
    roomMessageCache.delete(roomId); // removed from the room — the next entry starts blank again
    renderRoomTabs();
    if (roomId === currentRoomId) {
      currentRoomId = null;
      clearSavedRoom();
      showScreen('rooms');
    }
  });

  socket.on('invisible_state', ({ invisible }) => {
    isInvisible = invisible;
    toast(invisible ? '👻 You are now invisible in this room' : '👁️ You are visible again');
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
}

// ---------- HOME SCREEN ----------
async function refreshHome() {
  try {
    const { rooms } = await api('/rooms/recent');
    // Merge into allRoomsCache too — it's the shared lookup the chat screen's
    // owner/moderator banner and Room Info use, and a user can jump straight
    // into a room from this Home list without ever opening Room Browser
    // (which is otherwise the only place that populates it).
    rooms.forEach((room) => {
      const idx = allRoomsCache.findIndex((r) => r.id === room.id);
      if (idx === -1) allRoomsCache.push(room); else allRoomsCache[idx] = room;
    });
    const box = $('#homeRoomList');
    box.innerHTML = '';
    if (!rooms.length) {
      box.innerHTML = '<div class="empty-note">No rooms visited yet — head to Rooms to join one.</div>';
    } else {
      rooms.forEach((room) => box.appendChild(buildRoomRow(room)));
    }
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
          <span class="status-dot ${f.online ? '' : 'offline'}"></span>`;
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
  } catch (e) {}
  try {
    const { unread: emailsUnread } = await api('/messages');
    setBadge($('#emailsBadge'), emailsUnread);
    setBadge($('#drawerEmailsBadge'), emailsUnread);
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
}

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
$('#roomsCreateBtn').addEventListener('click', () => $('#roomForm').classList.toggle('hidden'));
$('#cancelCreateRoomBtn').addEventListener('click', () => $('#roomForm').classList.add('hidden'));

$('#roomForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#newRoomName').value.trim();
  if (!name) return;
  try {
    await api('/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    $('#newRoomName').value = '';
    $('#roomForm').classList.add('hidden');
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
  if (isInLegendaryRoom()) {
    socket.emit('legendary_get_state', {}, (state) => { if (state) { legendaryState = state; renderLegendaryPanel(); } });
  } else {
    renderLegendaryPanel(); // hides the panel when leaving the Legendary room
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
    const nameStyle = !cls && msg.username_color ? ` style="color:${escapeHtml(msg.username_color)}"` : '';
    const mediaHtml = msg.type === 'image'
      ? `<img class="chat-shared-image" src="${escapeHtml(msg.content)}" alt="shared picture" loading="lazy" />`
      : `<audio class="chat-voice-note" src="${escapeHtml(msg.content)}" controls></audio>`;
    div.innerHTML = `<div><span class="user ${cls}"${nameStyle}>${escapeHtml(msg.username)}${roleIcon(msg)}:</span></div>${mediaHtml}`;
  } else {
    const cls = roleClass(msg);
    // No role badge? Fall back to a purchased Color Shop color, same as the
    // Participants panel and Members/Leaderboard screens — a role color
    // always wins, but a plain user's chosen color still shows in chat.
    const nameStyle = !cls && msg.username_color ? ` style="color:${escapeHtml(msg.username_color)}"` : '';
    div.innerHTML = `<span class="user ${cls}"${nameStyle}>${escapeHtml(msg.username)}${roleIcon(msg)}:</span> ${escapeHtml(msg.content)}`;
  }
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

function isInLegendaryRoom() { return currentRoomName === LEGENDARY_ROOM_NAME; }

function renderLegendaryPanel() {
  const panel = $('#legendaryGamePanel');
  if (!isInLegendaryRoom()) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
  panel.classList.remove('hidden');

  const secondsLeft = legendaryState.phase === 'betting' ? Math.max(0, Math.ceil((legendaryState.endsAt - Date.now()) / 1000)) : 0;
  const selectedAnimalObj = LEGENDARY_ANIMALS.find((a) => a.key === legendarySelectedAnimal);

  panel.innerHTML = `
    <div class="legendary-header">
      <span class="legendary-title">🎲 Legendary Bot ${legendaryState.phase === 'betting' ? `<span class="legendary-countdown">${secondsLeft}s</span>` : `<span class="legendary-countdown idle">waiting for !start</span>`}</span>
      ${selectedAnimalObj ? `<span class="legendary-selected">✓ ${selectedAnimalObj.label}</span>` : ''}
    </div>
    <div class="legendary-animal-grid"></div>
    <div class="legendary-hint">Pick an amount below, then tap an animal to bid</div>
    <div class="legendary-amount-row"></div>
  `;

  const grid = panel.querySelector('.legendary-animal-grid');
  LEGENDARY_ANIMALS.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'legendary-animal-card' + (a.key === legendarySelectedAnimal ? ' selected' : '');
    card.innerHTML = `<div class="legendary-animal-emoji">${a.emoji}</div><div class="legendary-animal-label">${a.label}</div>`;
    card.addEventListener('click', () => {
      legendarySelectedAnimal = a.key;
      if (legendaryState.phase !== 'betting') { renderLegendaryPanel(); return toast('Betting is closed — wait for the next round'); }
      socket.emit('legendary_place_bet', { animal: a.key, amount: legendarySelectedAmount }, (ack) => {
        if (!ack || !ack.ok) toast((ack && ack.error) || 'Could not place that bet');
      });
      renderLegendaryPanel();
    });
    grid.appendChild(card);
  });

  const amountRow = panel.querySelector('.legendary-amount-row');
  LEGENDARY_BET_AMOUNTS.forEach((amt) => {
    const chip = document.createElement('button');
    chip.className = 'legendary-amount-chip' + (amt === legendarySelectedAmount ? ' selected' : '');
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

// ---------- EMOJI PICKER ----------
const EMOJI_PICKER_SET = ['😀','😂','😍','😎','🥳','😢','😡','👍','👎','🙏','🔥','💯','❤️','🎉','😅','🤔','👏','🙌','😴','🤩','😱','🥰','😭','🫡','✨','💪','🎁','🌹','☕','🚀'];
$('#emojiPickerBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#emojiPickerPopover');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  pop.innerHTML = '';
  EMOJI_PICKER_SET.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-picker-item';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      const input = $('#chatInput');
      input.value += emoji;
      input.focus();
    });
    pop.appendChild(btn);
  });
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
$('#actionSheetBtn').addEventListener('click', () => {
  $('#sheetInvisible').classList.toggle('hidden', !(currentUser.is_staff || currentUser.is_global_admin));
  $('#sheetInvisible').textContent = isInvisible ? '👁️ Go Visible' : '👻 Go Invisible';
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
  subScreenStack = [];
  roomSettingsActiveTab = 'settings';
  pushSubScreen('Room Settings', renderRoomSettings);
});
$('#sheetInvisible').addEventListener('click', () => {
  $('#actionSheetOverlay').classList.add('hidden');
  socket.emit('toggle_invisible', !isInvisible);
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
  openRoomTabs = openRoomTabs.filter((r) => r.id !== currentRoomId);
  currentRoomId = null;
  clearSavedRoom();
  renderRoomTabs();
  showScreen('rooms');
});

// ---------- PARTICIPANTS PANEL ----------
function openParticipants() {
  renderRoomMembers(lastRoomMembers);
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
    row.className = 'participant-row';
    const nameStyle = !roleClass(m) && m.username_color ? ` style="color:${escapeHtml(m.username_color)}"` : '';
    row.innerHTML = `
      <div class="avatar-circle small" style="background:${colorFor(m.username)}">${escapeHtml(m.username.charAt(0).toUpperCase())}</div>
      <span class="status-dot ${m.online ? '' : 'offline'}" title="${m.online ? 'Online' : 'Offline — still in the room'}"></span>
      <span class="${roleClass(m)}"${nameStyle}>${escapeHtml(m.username)}</span>
      <span class="level-badge">Lv.${m.level}</span>
      <span class="role-badge-icon">${roleIcon(m)}</span>
      ${m.invisible ? '<span class="role-badge-icon" title="Only visible to you">👻</span>' : ''}
    `;
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
          <span class="status-dot ${f.online ? '' : 'offline'}"></span>`;
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
$('#addFriendBtn').addEventListener('click', async () => {
  const name = $('#addFriendInput').value.trim();
  if (!name) return;
  try {
    await api('/friends/request', { method: 'POST', body: JSON.stringify({ username: name }) });
    $('#addFriendInput').value = '';
    toast('Friend request sent');
    renderFriendsPanel();
  } catch (err) {
    toast(err.message);
  }
});
$('#closeFriendsBtn').addEventListener('click', () => $('#friendsOverlay').classList.add('hidden'));
$('#friendsOverlay').addEventListener('click', (e) => { if (e.target === $('#friendsOverlay')) $('#friendsOverlay').classList.add('hidden'); });

// ---------- ADMIN PANEL ----------
// Staff search for a user by (partial) username instead of loading every
// account — with 1000+ registered users a full dump is both unusable and
// slow, so the table stays empty until a search is run.
$('#closeAdminBtn').addEventListener('click', () => $('#adminModal').classList.add('hidden'));

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
}

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
$('#closeGiveCoinsBtn').addEventListener('click', () => $('#giveCoinsModal').classList.add('hidden'));

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
    users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${usernameHtml(u)}</td>
        <td>${u.level}</td>
        <td>${u.coins}</td>
        <td>
          <div class="level-control">
            <input type="number" class="coins-amount-input" data-id="${u.id}" placeholder="Amount" min="1" max="100000" style="width:90px;" />
            <button type="button" class="give-coins-btn" data-id="${u.id}">Give</button>
            <button type="button" class="give-coins-preset-btn" data-id="${u.id}" data-amount="10000" title="Give 10000 coins in one tap">+10000</button>
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
  cards.forEach((c) => box.appendChild(listRow({ icon: c.icon, iconBg: c.bg, title: c.title, subtitle: c.subtitle, onClick: c.open })));
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

async function renderMembersGroups(box) {
  box.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const { groups } = await api('/members');
    box.innerHTML = '';
    let lastSection = null;
    groups.forEach((g) => {
      if (g.section !== lastSection) { box.appendChild(sectionLabel(g.section.toUpperCase())); lastSection = g.section; }
      const meta = MEMBER_GROUP_META[g.key] || { icon: '👤', bg: '#64748b' };
      box.appendChild(listRow({
        icon: meta.icon, iconBg: meta.bg, title: g.label, subtitle: `${g.count} member${g.count === 1 ? '' : 's'}`,
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
    catalog.forEach((c) => {
      const owned = currentUser.username_color === c.hex;
      const row = document.createElement('div');
      row.className = 'color-shop-row';
      row.innerHTML = `
        <div class="color-shop-swatch" style="background:${c.hex}"></div>
        <div class="list-row-body">
          <div class="list-row-title" style="color:${c.hex}">${escapeHtml(c.name)}</div>
          <div class="list-row-subtitle">${c.cost} 🪙</div>
        </div>
        <button class="color-buy-btn" ${owned ? 'disabled' : ''}>${owned ? 'Equipped' : 'Buy'}</button>
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
      box.appendChild(row);
    });
    const resetRow = document.createElement('button');
    resetRow.className = 'primary-btn';
    resetRow.style.marginTop = '12px';
    resetRow.textContent = 'Reset to default color';
    resetRow.addEventListener('click', async () => {
      const { user } = await api('/colors/reset', { method: 'POST' });
      currentUser = user;
      updateUserBar();
      renderColorShop(box);
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
function renderRoomInfoBanner() {
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

  const ownerName = room.owner_username || 'MiniPlatform';
  const memberNames = (lastRoomMembers || []).map((m) => m.username);
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
  // (see ROOM_BANNER_COLLAPSE_AFTER) so the full banner stops eating vertical
  // space above the conversation — it shrinks to one tappable summary line
  // instead of disappearing outright, and either state can be toggled by tap.
  const collapsed = !!roomBannerCollapsed.get(currentRoomId);

  if (collapsed) {
    banner.innerHTML = `
      <div class="room-banner-row room-banner-collapsed" id="roomBannerToggle" role="button" tabindex="0">
        <span class="room-banner-icon">👥</span>
        <span class="room-banner-text room-banner-sub" style="display:inline">${memberNames.length} in room · tap for room info</span>
        <span class="room-banner-chevron">▾</span>
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div class="room-banner-row">
        <span class="room-banner-icon">👥</span>
        <span class="room-banner-text">This room is managed by: <span class="room-banner-link">${escapeHtml(ownerName)}</span></span>
      </div>
      <div class="room-banner-row">
        <span class="room-banner-icon">🏷️</span>
        <span class="room-banner-text">${descHtml}</span>
      </div>
      <div class="room-banner-row room-banner-collapsed" id="roomBannerToggle" role="button" tabindex="0">
        <span class="room-banner-icon">👥</span>
        <span class="room-banner-text"><b>Currently in this room:</b> ${memberNames.length ? memberNames.map((n) => `<span class="room-banner-link">${escapeHtml(n)}</span>`).join(', ') : '<span class="room-banner-sub" style="display:inline">no one yet</span>'}</span>
        <span class="room-banner-chevron">▴</span>
      </div>
    `;
  }
  const toggle = $('#roomBannerToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      roomBannerCollapsed.set(currentRoomId, !collapsed);
      renderRoomInfoBanner();
    });
  }
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
  const isOwner = room.owner_username === currentUser.username;
  const isPrivileged = currentUser.is_staff || currentUser.is_global_admin;
  const canManageSettings = isPrivileged || isOwner; // description/lock level/ban/unban
  const canManageSilence = isPrivileged || isModerator;
  const canManageMod = isPrivileged || isOwner;

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

  // Ghost Mode — instant, no Save needed; any member can use it.
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
}

function renderRoomModeratorsTab(content, room, canManageMod, moderators) {
  content.appendChild(infoRow('👑', '#f59e0b', 'Owner', room.owner_username || 'MiniPlatform (official room, no owner)'));
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
        <div class="avatar-maker-preview" style="border-color:${currentUser.avatar_frame_color || '#3b82f6'}">
          <div class="avatar-maker-scene">${currentUser.avatar_scene || ''}</div>
          <div class="avatar-circle" style="background:${colorFor(currentUser.username)}">${escapeHtml(currentUser.username.charAt(0).toUpperCase())}</div>
          <div class="avatar-maker-pet">${currentUser.avatar_pet || ''}</div>
        </div>
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
  { cmd: '/coffee', desc: 'Offer everyone in the room a cup of coffee' },
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
function renderPostsScreen(type) {
  return async function (box) {
    box.innerHTML = '<div class="empty-note">Loading…</div>';
    const draw = async () => {
      try {
        const { posts } = await api(`/posts?type=${type}`);
        box.innerHTML = '';
        if (currentUser.is_staff) {
          const composer = document.createElement('div');
          composer.className = 'post-composer';
          composer.innerHTML = `
            <input type="text" id="postTitleInput" placeholder="Title" maxlength="120" />
            <textarea id="postContentInput" placeholder="Write something..." rows="3" maxlength="2000"></textarea>
            <button id="postSubmitBtn" class="primary-btn">Post</button>
          `;
          composer.querySelector('#postSubmitBtn').addEventListener('click', async () => {
            const title = composer.querySelector('#postTitleInput').value.trim();
            const content = composer.querySelector('#postContentInput').value.trim();
            if (!title || !content) return toast('Title and content are required');
            try {
              await api('/posts', { method: 'POST', body: JSON.stringify({ type, title, content }) });
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
          row.innerHTML = `
            <div class="notif-icon" style="background:${type === 'announcement' ? '#3b82f6' : '#8b5cf6'}">${type === 'announcement' ? '📣' : '📰'}</div>
            <div class="notif-body">
              <div class="notif-title-line">${escapeHtml(p.title)}</div>
              <div class="post-desc">${escapeHtml(p.content)}</div>
            </div>
            <div class="notif-time">
              <div class="notif-relative">${escapeHtml(relative)}</div>
              <div class="notif-exact">${escapeHtml(exact)}</div>
              ${currentUser.is_staff ? '<button class="post-delete-btn" title="Delete">🗑️</button>' : ''}
            </div>
          `;
          const delBtn = row.querySelector('.post-delete-btn');
          if (delBtn) delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await api(`/posts/${p.id}`, { method: 'DELETE' });
            draw();
          });
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

// ---------- MY PROFILE / MY ACCOUNT / SETTINGS / GAME LIST ----------
function renderMyProfile(box) {
  const u = currentUser;
  box.innerHTML = `
    <div class="avatar-maker-preview" style="border-color:${u.avatar_frame_color || '#3b82f6'}">
      <div class="avatar-maker-scene">${u.avatar_scene || ''}</div>
      <div class="avatar-circle" style="background:${colorFor(u.username)}">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
      <div class="avatar-maker-pet">${u.avatar_pet || ''}</div>
    </div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">${usernameHtml(u)}</div><div class="list-row-subtitle">Level ${u.level} · ${u.xp} XP</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">🪙 ${u.coins} coins</div></div></div>
    <div class="list-row"><div class="list-row-body"><div class="list-row-title">🎁 ${u.gifts_sent_count || 0} gifts sent</div></div></div>
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
}
function openDrawerMyProfile() { openSubScreenFromDrawer('My Profile', renderMyProfile); }

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
$('#drawerMyAccount').addEventListener('click', openDrawerMyAccount);
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

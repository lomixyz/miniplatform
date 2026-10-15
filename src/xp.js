// Shared xp/level mutation helpers — used by both the real-time socket layer
// (earning xp from chat/gifts/UNO) and the Admin Panel (staff setting a
// user's level directly). Both paths push a live 'xp_update' to any socket
// that user currently has open, so their UI updates without a page reload.
const db = require('./db');
const { levelFromXp, xpForLevel } = require('./level');

// Daily cap on EARNED xp (awardXp only — never applies to an admin's direct
// setXp/setLevel). Sudan has used a fixed UTC+2 offset with no DST since
// 2017, so computing "today" via the Africa/Khartoum IANA zone is always
// correct without any manual offset math.
// Daily xp-earn cap, scaled by the user's current level so late-game
// players (who need far more xp per level) aren't stuck behind the same
// ceiling as a brand-new account. Brackets below 1-119 are the user's own
// spec; the tiers above 119 extend the same curve (roughly +1,000-1,500
// every ~40-60 levels, tapering off since xpForLevel's own cost-per-level
// keeps climbing by +50 forever).
const DAILY_XP_CAP_BRACKETS = [
  { maxLevel: 20, cap: 1500 },
  { maxLevel: 41, cap: 5000 },
  { maxLevel: 78, cap: 7800 },
  { maxLevel: 119, cap: 9000 },
  { maxLevel: 160, cap: 10500 },
  { maxLevel: 220, cap: 12000 },
  { maxLevel: 300, cap: 13500 },
  { maxLevel: Infinity, cap: 15000 },
];
function dailyXpCapForLevel(level) {
  const found = DAILY_XP_CAP_BRACKETS.find((b) => level <= b.maxLevel);
  return found ? found.cap : DAILY_XP_CAP_BRACKETS[DAILY_XP_CAP_BRACKETS.length - 1].cap;
}
// Back-compat export for any caller that still wants a single flat number
// (e.g. a default before per-user data has loaded) — kept at the old 5000
// value, the cap for the most common early/mid levels.
const DAILY_XP_CAP = 5000;
function sudanDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Khartoum', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA formats as YYYY-MM-DD
}

// The next Sudan local midnight (start of the next Sudan calendar day),
// returned as a UTC instant — Khartoum is a fixed UTC+2 with no DST, so
// "tomorrow's Sudan midnight" is always today's Sudan date + 1 day, 00:00,
// shifted back 2 hours to express that same instant in UTC.
function nextSudanResetUtc(d = new Date()) {
  const [y, m, day] = sudanDateString(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1, 0, 0, 0) - 2 * 3600 * 1000);
}

// Read-only snapshot of a user's daily xp-earn progress, straight from a
// users row (needs xp_daily_date/xp_daily_earned selected) — used both to
// hand the client a live status and to recompute it fresh after any award.
function dailyXpStatus(row) {
  const today = sudanDateString();
  const earnedToday = row && row.xp_daily_date === today ? (row.xp_daily_earned || 0) : 0;
  const level = row ? levelFromXp(row.xp || 0).level : 1;
  const cap = dailyXpCapForLevel(level);
  return {
    cap,
    earnedToday,
    remainingToday: Math.max(0, cap - earnedToday),
    resetsAt: nextSudanResetUtc().toISOString(),
  };
}

function pushXpUpdate(io, userId, xp, level, xpIntoLevel, xpForNextLevel, dailyXp) {
  if (!io) return;
  for (const [, s] of io.sockets.sockets) {
    if (s.data.user && s.data.user.id === userId) {
      s.emit('xp_update', { xp, level, xpIntoLevel, xpForNextLevel, dailyXp });
    }
  }
}

// Persist a "Level Up!" notification (shown in the Notifications list, not
// just the live in-app toast) whenever a level gain actually crosses a
// threshold — never on every xp tick, and never on a level going down.
function notifyLevelUp(userId, newLevel) {
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)')
    .run(userId, 'level', `Level Up! You are now Level ${newLevel}`, `Keep chatting and playing to reach the next level! 🎉`);
}

function awardXp(io, userId, amount) {
  const before = db.prepare('SELECT xp, xp_daily_date, xp_daily_earned FROM users WHERE id = ?').get(userId);
  if (!before) return { xp: 0, level: 1, awarded: 0 };
  const levelBefore = levelFromXp(before.xp || 0).level;

  // Daily earn-cap (level-scaled, Sudan calendar day) — a new day quietly
  // resets the counter to 0 since we only ever compare against today's
  // stored date. Gated on the level BEFORE this award, since that's what
  // determines how much the user is allowed to earn right now; a level-up
  // mid-award doesn't retroactively raise this call's own ceiling.
  const today = sudanDateString();
  const earnedToday = before.xp_daily_date === today ? (before.xp_daily_earned || 0) : 0;
  const cap = dailyXpCapForLevel(levelBefore);
  const award = Math.max(0, Math.min(amount, cap - earnedToday));

  if (award > 0) {
    db.prepare('UPDATE users SET xp = xp + ?, xp_daily_date = ?, xp_daily_earned = ? WHERE id = ?')
      .run(award, today, earnedToday + award, userId);
  }
  const row = db.prepare('SELECT xp, xp_daily_date, xp_daily_earned FROM users WHERE id = ?').get(userId);
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(row.xp);
  if (level > levelBefore) notifyLevelUp(userId, level);
  if (award > 0) pushXpUpdate(io, userId, row.xp, level, xpIntoLevel, xpForNextLevel, dailyXpStatus(row));
  return { xp: row.xp, level, awarded: award, capped: award < amount };
}

function setXp(io, userId, xp) {
  xp = Math.max(0, xp | 0);
  const before = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  const levelBefore = before ? levelFromXp(before.xp || 0).level : 1;

  db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(xp, userId);
  const row = db.prepare('SELECT xp, xp_daily_date, xp_daily_earned FROM users WHERE id = ?').get(userId);
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(xp);
  if (level > levelBefore) notifyLevelUp(userId, level);
  pushXpUpdate(io, userId, xp, level, xpIntoLevel, xpForNextLevel, dailyXpStatus(row));
  return { xp, level };
}

function setLevel(io, userId, level) {
  return setXp(io, userId, xpForLevel(level));
}

module.exports = { awardXp, setXp, setLevel, dailyXpStatus, dailyXpCapForLevel, DAILY_XP_CAP };

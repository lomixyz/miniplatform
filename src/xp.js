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
const DAILY_XP_CAP = 5000;
function sudanDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Khartoum', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA formats as YYYY-MM-DD
}

function pushXpUpdate(io, userId, xp, level, xpIntoLevel, xpForNextLevel) {
  if (!io) return;
  for (const [, s] of io.sockets.sockets) {
    if (s.data.user && s.data.user.id === userId) {
      s.emit('xp_update', { xp, level, xpIntoLevel, xpForNextLevel });
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

  // Daily earn-cap (5000/day, Sudan calendar day) — a new day quietly resets
  // the counter to 0 since we only ever compare against today's stored date.
  const today = sudanDateString();
  const earnedToday = before.xp_daily_date === today ? (before.xp_daily_earned || 0) : 0;
  const award = Math.max(0, Math.min(amount, DAILY_XP_CAP - earnedToday));

  if (award > 0) {
    db.prepare('UPDATE users SET xp = xp + ?, xp_daily_date = ?, xp_daily_earned = ? WHERE id = ?')
      .run(award, today, earnedToday + award, userId);
  }
  const row = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(row.xp);
  if (level > levelBefore) notifyLevelUp(userId, level);
  if (award > 0) pushXpUpdate(io, userId, row.xp, level, xpIntoLevel, xpForNextLevel);
  return { xp: row.xp, level, awarded: award, capped: award < amount };
}

function setXp(io, userId, xp) {
  xp = Math.max(0, xp | 0);
  const before = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  const levelBefore = before ? levelFromXp(before.xp || 0).level : 1;

  db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(xp, userId);
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(xp);
  if (level > levelBefore) notifyLevelUp(userId, level);
  pushXpUpdate(io, userId, xp, level, xpIntoLevel, xpForNextLevel);
  return { xp, level };
}

function setLevel(io, userId, level) {
  return setXp(io, userId, xpForLevel(level));
}

module.exports = { awardXp, setXp, setLevel };

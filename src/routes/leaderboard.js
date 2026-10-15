const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// Three ranked lists, each backed by a real counter that updates live as
// people chat/spend/gift (see socket.js for where xp, total_spent, and
// gifts_sent_count get incremented) — not a snapshot or a fake demo list.
const BOARDS = {
  wins: { column: 'xp', label: 'Leader Board', subtitle: 'top players by XP across all rooms' },
  spend: { column: 'total_spent', label: 'Legendary Contest', subtitle: 'top players by total spend' },
  gifts: { column: 'gifts_sent_count', label: 'Gift Contest', subtitle: 'top gifters' },
};

// Time-period tabs. 'alltime' reads straight off the lifetime column on
// users (xp/total_spent/gifts_sent_count) — those totals predate the
// leaderboard_events log and can't be reconstructed from it. Every other
// period sums leaderboard_events rows logged since the cutoff (see
// db.logLeaderboardEvent — called alongside every xp award and every gift
// send, in xp.js/socket.js/routes/giftstore.js).
const PERIOD_LABELS = {
  alltime: 'All Time',
  today: 'Today',
  last_day: 'Last Day',
  last_week: 'Last Week',
  last_month: 'Last Month',
};

// The Sudan-day boundary mirrors src/xp.js's own daily-cap reset (Khartoum
// is a fixed UTC+2 with no DST, so this is always correct without manual
// offset math) — "Today" on the leaderboard means the same calendar day the
// Daily XP limit card means. Returned as a SQLite-comparable UTC string
// ('YYYY-MM-DD HH:MM:SS', matching datetime('now')'s own format) rather than
// an ISO string (which uses 'T'/'Z' and wouldn't sort/compare the same way
// against TEXT columns stamped by datetime('now')).
function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function sudanTodayStartUtc(now = new Date()) {
  const sudanDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Khartoum', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [y, m, d] = sudanDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 2 * 3600 * 1000);
}
function periodCutoff(period) {
  const now = new Date();
  switch (period) {
    case 'today': return toSqliteUtc(sudanTodayStartUtc(now));
    case 'last_day': return toSqliteUtc(new Date(now.getTime() - 24 * 3600 * 1000));
    case 'last_week': return toSqliteUtc(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
    case 'last_month': return toSqliteUtc(new Date(now.getTime() - 30 * 24 * 3600 * 1000));
    default: return null; // alltime
  }
}

router.get('/:board', requireLogin, (req, res) => {
  const board = BOARDS[req.params.board];
  if (!board) return res.status(404).json({ error: 'Unknown leaderboard' });
  const period = PERIOD_LABELS[req.query.period] ? req.query.period : 'alltime';

  let entries;
  if (period === 'alltime') {
    const rows = db.prepare(`SELECT * FROM users WHERE ${board.column} > 0 ORDER BY ${board.column} DESC LIMIT 50`).all();
    entries = rows.map((r) => ({ ...publicUser(r), score: r[board.column] }));
  } else {
    const cutoff = periodCutoff(period);
    const agg = db.prepare(`
      SELECT user_id, SUM(amount) AS score FROM leaderboard_events
      WHERE board = ? AND created_at >= ? GROUP BY user_id ORDER BY score DESC LIMIT 50
    `).all(req.params.board, cutoff);
    entries = agg
      .map((a) => {
        const row = db.prepare('SELECT * FROM users WHERE id = ?').get(a.user_id);
        return row ? { ...publicUser(row), score: a.score } : null;
      })
      .filter(Boolean);
  }

  res.json({
    label: board.label,
    subtitle: `${PERIOD_LABELS[period]} — ${board.subtitle}`,
    period,
    periods: PERIOD_LABELS,
    entries,
  });
});

module.exports = router;

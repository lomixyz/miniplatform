const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// Three ranked lists, each backed by a real counter that updates live as
// people chat/spend/gift (see socket.js for where xp, total_spent, and
// gifts_sent_count get incremented) — not a snapshot or a fake demo list.
//
// Note on "contests": Legendary Contest and Gift Contest are framed as
// ongoing/live rankings by lifetime total, not a time-boxed event with its
// own start/end date and a reset — that's a bigger feature (contest periods,
// prize payouts) this build doesn't include. They're real and live, just not
// periodic yet.
const BOARDS = {
  wins: { column: 'xp', label: 'Leader Board', subtitle: 'Top players by XP across all rooms' },
  spend: { column: 'total_spent', label: 'Legendary Contest', subtitle: 'Live ranking — top players by total spend' },
  gifts: { column: 'gifts_sent_count', label: 'Gift Contest', subtitle: 'Live ranking — top gifters' },
};

router.get('/:board', requireLogin, (req, res) => {
  const board = BOARDS[req.params.board];
  if (!board) return res.status(404).json({ error: 'Unknown leaderboard' });

  const rows = db.prepare(`SELECT * FROM users WHERE ${board.column} > 0 ORDER BY ${board.column} DESC LIMIT 50`).all();
  res.json({
    label: board.label,
    subtitle: board.subtitle,
    entries: rows.map((r) => ({ ...publicUser(r), score: r[board.column] })),
  });
});

module.exports = router;

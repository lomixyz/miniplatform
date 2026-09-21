const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// General-purpose username search, open to any logged-in user (used by Gift Store's
// recipient picker). Deliberately separate from /api/admin/users (staff-only) and
// /api/coins/search (staff/mentor/merchant-only) — this one is safe for everyone since
// it only returns public profile fields, capped like the other search endpoints.
router.get('/search', requireLogin, (req, res) => {
  const q = String((req.query && req.query.q) || '').trim();
  if (!q) return res.json({ users: [] });
  const rows = db.prepare('SELECT * FROM users WHERE username LIKE ? COLLATE NOCASE ORDER BY username LIMIT 20')
    .all(`%${q}%`);
  res.json({ users: rows.map(publicUser) });
});

module.exports = router;

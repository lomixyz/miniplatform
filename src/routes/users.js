const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');
const { levelFromXp } = require('../level');
const presence = require('../presence');

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

// Shape a raw user row into the "profile card" fields everyone is allowed to
// see about someone else — deliberately narrower than publicUser() (no
// email, no coin balance/spend, nothing financial) since this is exposed to
// any logged-in user, not just the account owner.
function publicProfileCard(row) {
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(row.xp || 0);
  return {
    id: row.id,
    username: row.username,
    is_staff: !!row.is_staff,
    is_global_admin: !!row.is_global_admin,
    is_mentor: !!row.is_mentor,
    is_merchant: !!row.is_merchant,
    is_exec_board: !!row.is_exec_board,
    is_country_rep: !!row.is_country_rep,
    is_elite: !!row.is_elite,
    level,
    xpIntoLevel,
    xpForNextLevel,
    bio: row.bio || '',
    uno_wins: row.uno_wins || 0,
    gifts_sent_count: row.gifts_sent_count || 0,
    username_color: row.username_color || null,
    avatar_frame_color: row.avatar_frame_color || null,
    avatar_pet: row.avatar_pet || null,
    avatar_scene: row.avatar_scene || null,
    country: row.country || null,
    created_at: row.created_at || null,
    status: presence.effectiveStatus(row.id, row.status),
  };
}

// This MUST come before GET /:username — otherwise Express would try to
// look up a user literally named "me".
router.get('/me/footprint', requireLogin, (req, res) => {
  const meId = req.session.user.id;
  const rows = db.prepare(`
    SELECT pv.visited_at, u.id, u.username, u.xp, u.country, u.status, u.username_color,
           u.is_staff, u.is_global_admin, u.is_mentor, u.is_merchant, u.is_exec_board, u.is_country_rep, u.is_elite
    FROM profile_visits pv
    JOIN users u ON u.id = pv.visitor_id
    WHERE pv.visited_id = ?
    ORDER BY pv.visited_at DESC
  `).all(meId);
  const visitors = rows.map((r) => ({
    username: r.username,
    level: levelFromXp(r.xp || 0).level,
    country: r.country || null,
    status: presence.effectiveStatus(r.id, r.status),
    username_color: r.username_color || null,
    is_staff: !!r.is_staff,
    is_global_admin: !!r.is_global_admin,
    is_mentor: !!r.is_mentor,
    is_merchant: !!r.is_merchant,
    is_exec_board: !!r.is_exec_board,
    is_country_rep: !!r.is_country_rep,
    is_elite: !!r.is_elite,
    visited_at: r.visited_at,
  }));
  res.json({ count: visitors.length, visitors });
});

// A user's public profile card. Viewing someone ELSE's profile leaves a
// "footprint" — an upserted (visitor, visited) row so it shows up on their
// My Profile → footprint list. Viewing your own profile through this route
// (shouldn't normally happen — the client uses local currentUser for that)
// never counts as a self-visit.
router.get('/:username', requireLogin, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!row) return res.status(404).json({ error: 'No such user' });

  const viewerId = req.session.user.id;
  if (viewerId !== row.id) {
    db.prepare(`
      INSERT INTO profile_visits (visitor_id, visited_id, visited_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(visitor_id, visited_id) DO UPDATE SET visited_at = datetime('now')
    `).run(viewerId, row.id);
  }

  res.json({ user: publicProfileCard(row) });
});

module.exports = router;

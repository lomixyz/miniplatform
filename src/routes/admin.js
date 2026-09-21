const express = require('express');
const db = require('../db');
const { requireFlag, publicUser, FLAG_MAP } = require('../auth');
const { setLevel } = require('../xp');

// Every role column Staff can toggle from the Admin Panel — kept as one list
// (derived from the same FLAG_MAP requireFlag() uses) so adding a role later
// means touching one place, not every route that loops over roles.
const ROLE_COLUMNS = Object.values(FLAG_MAP);

const router = express.Router();

// The Admin Panel (user search + all role management below) is Staff-only.
// Global Administrator is a separate, room-moderation role (kicking members —
// see the kick_user socket event) and deliberately does NOT get panel access.
//
// Listing every user was fine with a handful of test accounts, but doesn't
// scale — with 1000+ registered users it's an unusable wall of rows and a
// slow query. Staff now search by (partial) username instead, capped to a
// small page of results; nothing is returned until a query is typed.
router.get('/users', requireFlag('staff'), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], query: '' });
  const rows = db.prepare('SELECT * FROM users WHERE username LIKE ? ORDER BY username COLLATE NOCASE LIMIT 20')
    .all(`%${q}%`);
  res.json({ users: rows.map(publicUser), query: q });
});

// Staff can promote a normal user to Global Administrator.
// This only ever ADDS the global_admin flag — it never touches is_staff, and it
// never removes anything, so an account can end up with both flags (staff AND
// global_admin) at once, which is allowed by design.
router.post('/users/:id/promote-to-admin', requireFlag('staff'), (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.is_global_admin) {
    return res.status(400).json({ error: 'User is already a Global Administrator' });
  }

  db.prepare('UPDATE users SET is_global_admin = 1 WHERE id = ?').run(targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({ user: publicUser(updated) });
});

// Staff can set any of the seven role flags directly (is_staff,
// is_global_admin, is_mentor, is_merchant, is_exec_board, is_country_rep,
// is_elite), independently of each other, so a single account can hold any
// combination — only the flags present in the request body are touched.
//
// The 'admin' and 'miniplatform' accounts are the exception: their Staff
// flag is permanently locked on. They're how the very first role gets
// granted to anyone else, so it can never be unchecked — attempting to turn
// it off is silently ignored rather than erroring, since every other flag on
// that request still applies. (Kept in sync with PROTECTED_ACCOUNTS in db.js.)
const PROTECTED_ACCOUNTS = ['admin', 'miniplatform'];
router.post('/users/:id/set-flags', requireFlag('staff'), (req, res) => {
  const targetId = Number(req.params.id);
  const body = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const isProtectedAdmin = PROTECTED_ACCOUNTS.includes(target.username);
  const next = {};
  for (const col of ROLE_COLUMNS) {
    if (col === 'is_staff' && isProtectedAdmin) { next[col] = 1; continue; }
    next[col] = body[col] === undefined ? target[col] : (body[col] ? 1 : 0);
  }

  const setClause = ROLE_COLUMNS.map((col) => `${col} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...ROLE_COLUMNS.map((c) => next[c]), targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({ user: publicUser(updated), staffLocked: isProtectedAdmin });
});

// Staff can set any user's level directly (e.g. as a reward, or to fix an
// account up). This sets their xp to the minimum needed to BE that level
// (no partial progress into the next one), and pushes a live update to their
// browser immediately if they're currently connected.
router.post('/users/:id/set-level', requireFlag('staff'), (req, res) => {
  const targetId = Number(req.params.id);
  const level = Number(req.body && req.body.level);
  if (!Number.isFinite(level) || level < 1 || level > 9999) {
    return res.status(400).json({ error: 'Level must be a whole number of 1 or more' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const io = req.app.get('io');
  setLevel(io, targetId, Math.round(level));

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({ user: publicUser(updated) });
});

// A normal user can pick their own country only once (see POST /auth/country).
// Staff is exempt from that lock and can set or change ANY user's country at
// any time, including re-opening/correcting one that's already set.
router.post('/users/:id/set-country', requireFlag('staff'), (req, res) => {
  const targetId = Number(req.params.id);
  const country = String((req.body && req.body.country) || '').trim().slice(0, 80);
  if (!country) return res.status(400).json({ error: 'Country is required' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET country = ? WHERE id = ?').run(country, targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(targetId);

  res.json({ user: publicUser(updated) });
});

module.exports = router;

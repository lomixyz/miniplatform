const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireFlag, publicUser, FLAG_MAP } = require('../auth');
const { setLevel } = require('../xp');

// Same character rule as public signup (routes/auth.js) — only the minimum
// length differs (3 here vs. 6 there), since this endpoint is Staff-only.
const USERNAME_CHARS_RE = /^[A-Za-z0-9_.-]+$/;
const MIN_USERNAME_LEN_STAFF = 3;

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

// Staff-only: create a new account directly from the Admin Panel. This is
// the ONLY way to get a short (3-5 letter) User ID — public /auth/register
// always enforces the 6+ minimum, since the "requester is Staff" check
// there needs a Staff session already attached, which the logged-out
// Register screen never has. Deliberately does NOT touch req.session —
// unlike /auth/register, creating a user here must never log the Staff
// member themselves out of their own account.
router.post('/users/create', requireFlag('staff'), (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const gender = body.gender === 'female' ? 'female' : body.gender === 'male' ? 'male' : null;
  const country = String(body.country || '').trim().slice(0, 80);

  if (!username || username.length < MIN_USERNAME_LEN_STAFF) {
    return res.status(400).json({ error: `User ID must be at least ${MIN_USERNAME_LEN_STAFF} characters` });
  }
  if (!USERNAME_CHARS_RE.test(username)) {
    return res.status(400).json({ error: 'User ID can only contain letters, numbers, and _ - .' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid Email ID is required' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Secret Code must be at least 4 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
  if (existingEmail) return res.status(409).json({ error: 'That Email ID is already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, gender, country, is_staff, is_global_admin, coins, xp)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0)
  `).run(username, email, hash, gender, country || null, 5000);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  db.seedDefaultGiftFavorites(row.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)')
    .run(row.id, 'system', 'Welcome to MiniPlatform! 🎉', `Hey ${row.username}, explore rooms, make friends, and start chatting.`);

  res.json({ user: publicUser(row) });
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
// The 'miniplatform' account is the exception: its Staff flag is permanently
// locked on. It's how the very first role gets granted to anyone else, so it
// can never be unchecked — attempting to turn it off is silently ignored
// rather than erroring, since every other flag on that request still
// applies. (Kept in sync with STAFF_ENFORCED_ACCOUNTS in db.js.) 'admin' used
// to be locked the same way, but was demoted to a plain user on request and
// is now a perfectly ordinary account here too — Staff can freely toggle any
// of its flags, same as 'boss-3llam' or anyone else.
const PROTECTED_ACCOUNTS = ['miniplatform'];
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

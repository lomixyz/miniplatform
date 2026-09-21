const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { publicUser, requireLogin } = require('../auth');

const router = express.Router();

// Registration screen: User ID, Email ID, Secret Code (+Confirm), Gender,
// Country, and an optional Referrer User ID. There's no mail server behind
// this build, so email is just stored on the account (used later for the
// in-app "Forgot Code" recovery below) — no verification email is sent, and
// no separate "activate account" step exists; an account is live the moment
// it's created.
router.post('/register', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  const gender = body.gender === 'female' ? 'female' : body.gender === 'male' ? 'male' : null;
  const country = String(body.country || '').trim().slice(0, 80);
  const referrerUsername = String(body.referrerUsername || '').trim();
  const agreedTerms = !!body.agreedTerms;

  if (!username || username.length < 3) return res.status(400).json({ error: 'User ID must be at least 3 characters' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid Email ID is required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Secret Code must be at least 4 characters' });
  if (password !== confirmPassword) return res.status(400).json({ error: "Secret Code and Confirm Code don't match" });
  if (!gender) return res.status(400).json({ error: 'Please choose a gender' });
  if (!country) return res.status(400).json({ error: 'Please choose a country' });
  if (!agreedTerms) return res.status(400).json({ error: 'You must agree to the Terms of Use (EULA) to continue' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  const existingEmail = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
  if (existingEmail) return res.status(409).json({ error: 'That Email ID is already registered' });

  let referrerId = null;
  if (referrerUsername) {
    const referrer = db.prepare('SELECT id FROM users WHERE username = ?').get(referrerUsername);
    if (!referrer) return res.status(400).json({ error: 'Referrer User ID not found' });
    referrerId = referrer.id;
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, gender, country, referrer_user_id, is_staff, is_global_admin, coins, xp)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0)
  `).run(username, email, hash, gender, country, referrerId, 5000);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const user = publicUser(row);
  req.session.user = user;
  db.seedDefaultGiftFavorites(user.id);

  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)')
    .run(user.id, 'system', 'Welcome to MiniPlatform! 🎉', `Hey ${user.username}, explore rooms, make friends, and start chatting.`);

  res.json({ user });
});

router.post('/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = publicUser(row);
  req.session.user = user;

  // "Remember me" keeps the session cookie around for 30 days instead of the
  // 1-day default, so an unchecked login doesn't linger on a shared device.
  req.session.cookie.maxAge = remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 24;

  // A fresh login always starts with a clean slate, for every account
  // including Staff/Global Admin — no room's chat replays what was posted
  // before this sign-in (membership itself is untouched; only the visible
  // history is reset). Mirrors what /auth/logout does.
  db.prepare("UPDATE room_memberships SET history_cleared_at = datetime('now') WHERE user_id = ?").run(user.id);

  res.json({ user });
});

// "Forgot Code" — there's no email server to send a reset code through, so
// this is a direct in-app reset: prove you own the account by supplying the
// Username AND the Email ID on file for it, then set a new Secret Code right
// there. Same "fixed password" protection as /change-password applies.
router.post('/forgot-password', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const newPassword = String(body.newPassword || '');
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New Secret Code must be at least 4 characters' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !row.email || row.email.toLowerCase() !== email.toLowerCase()) {
    return res.status(401).json({ error: "Those details don't match an account on file" });
  }
  if (row.username === 'admin' || row.username === 'miniplatform') {
    return res.status(403).json({ error: "This account's password is fixed and can't be changed here" });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), row.id);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  // Logging out doesn't drop room membership (a persistent thing, per the
  // "stay in the room until you leave/get removed/go idle" design) — but the
  // NEXT time this person is back in any of those rooms, their chat view
  // should start fresh rather than replaying everything posted while they
  // were logged out. GET /rooms/:id/messages reads this per-room.
  const userId = req.session.user && req.session.user.id;
  if (userId) {
    db.prepare("UPDATE room_memberships SET history_cleared_at = datetime('now') WHERE user_id = ?").run(userId);
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  // refresh coins/xp/roles in case they changed
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!row) { req.session.destroy(() => {}); return res.json({ user: null }); }
  const user = publicUser(row);
  req.session.user = user;
  res.json({ user });
});

// My Account → change password.
router.post('/change-password', requireLogin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!row || !bcrypt.compareSync(currentPassword || '', row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (row.username === 'admin' || row.username === 'miniplatform') {
    return res.status(403).json({ error: "This account's password is fixed and can't be changed here" });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), row.id);
  res.json({ ok: true });
});

// My Profile → set my own country. Allowed exactly once per account — after
// that this account's country is locked and only Staff can change it (see
// POST /admin/users/:id/set-country in admin.js). Staff/Global Admin accounts
// go through the same one-time rule here for their OWN profile; the "Staff
// can change anyone's" override lives in the admin-only route instead.
router.post('/country', requireLogin, (req, res) => {
  const country = String((req.body && req.body.country) || '').trim().slice(0, 80);
  if (!country) return res.status(400).json({ error: 'Country is required' });
  const row = db.prepare('SELECT country FROM users WHERE id = ?').get(req.session.user.id);
  if (row && row.country) {
    return res.status(403).json({ error: 'Your country is already set and can only be changed by Staff' });
  }
  db.prepare('UPDATE users SET country = ? WHERE id = ?').run(country, req.session.user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const user = publicUser(updated);
  req.session.user = user;
  res.json({ user });
});

router.post('/bio', requireLogin, (req, res) => {
  const bio = String((req.body && req.body.bio) || '').slice(0, 140);
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.session.user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const user = publicUser(row);
  req.session.user = user;
  res.json({ user });
});

module.exports = router;

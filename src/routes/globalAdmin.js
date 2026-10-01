// "Become a Global Administrator" self-service application (Explore ->
// Become a Global Administrator) — same request/review flow as
// routes/merchant.js, with one difference: approving doesn't just flip
// is_global_admin, it also credits the new Global Admin 1,000,000 coins in
// the same step, as a one-time welcome grant for the role.
const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser } = require('../auth');

const router = express.Router();

const GLOBAL_ADMIN_WELCOME_COINS = 1_000_000;

router.get('/status', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_global_admin FROM users WHERE id = ?').get(me);
  const application = db.prepare(
    'SELECT id, message, status, created_at, reviewed_at FROM globaladmin_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(me);
  res.json({ isGlobalAdmin: !!(user && user.is_global_admin), application: application || null });
});

router.post('/apply', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_global_admin FROM users WHERE id = ?').get(me);
  if (user && user.is_global_admin) return res.status(400).json({ error: 'You are already a Global Administrator' });
  const pending = db.prepare("SELECT 1 FROM globaladmin_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending application' });
  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  db.prepare('INSERT INTO globaladmin_applications (user_id, message) VALUES (?, ?)').run(me, message);
  res.json({ ok: true });
});

// Staff-only queue of pending applications (mirrors Merchant Applications).
router.get('/pending', requireFlag('staff'), (req, res) => {
  const rows = db.prepare(`
    SELECT ga.id, ga.message, ga.created_at, u.id AS user_id, u.username
    FROM globaladmin_applications ga JOIN users u ON u.id = ga.user_id
    WHERE ga.status = 'pending' ORDER BY ga.id ASC
  `).all();
  res.json({ applications: rows });
});

router.post('/:id/approve', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM globaladmin_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });

  db.prepare('UPDATE users SET is_global_admin = 1, coins = coins + ? WHERE id = ?').run(GLOBAL_ADMIN_WELCOME_COINS, app_.user_id);
  db.logCoinTx(app_.user_id, GLOBAL_ADMIN_WELCOME_COINS, 'other', 'Global Administrator welcome grant');
  db.prepare("UPDATE globaladmin_applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'coins', 'Global Administrator application approved',
    `${req.session.user.username} approved your Global Administrator application — you're now a Global Administrator and received ${GLOBAL_ADMIN_WELCOME_COINS.toLocaleString()} coins!`
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(app_.user_id);
  const emitToUser = req.app.get('emitToUser');
  if (emitToUser) emitToUser(app_.user_id, 'coins_update', { coins: updated.coins });
  const refreshUserPresence = req.app.get('refreshUserPresence');
  if (refreshUserPresence) refreshUserPresence(app_.user_id);
  res.json({ ok: true, user: publicUser(updated) });
});

router.post('/:id/reject', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM globaladmin_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  db.prepare("UPDATE globaladmin_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system', 'Global Administrator application declined',
    `${req.session.user.username} declined your Global Administrator application.`
  );
  res.json({ ok: true });
});

module.exports = router;

// "Become a Merchant" self-service application (Explore -> Become a
// Merchant) — a plain user submits a short message, Staff/Global Admin
// approve or reject it. Approving just sets is_merchant = 1, the same
// effect as flipping the Merchant checkbox in the Admin Panel today; this
// route only adds a request/review step in front of that existing flag.
const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser } = require('../auth');

const router = express.Router();

// The current user's own application status (or none) — drives the
// Explore card's "Apply" vs "Pending review" vs "Already a Merchant" state.
router.get('/status', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_merchant FROM users WHERE id = ?').get(me);
  const application = db.prepare(
    'SELECT id, message, status, created_at, reviewed_at FROM merchant_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(me);
  res.json({ isMerchant: !!(user && user.is_merchant), application: application || null });
});

router.post('/apply', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_merchant FROM users WHERE id = ?').get(me);
  if (user && user.is_merchant) return res.status(400).json({ error: 'You are already a Merchant' });
  const pending = db.prepare("SELECT 1 FROM merchant_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending application' });
  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  db.prepare('INSERT INTO merchant_applications (user_id, message) VALUES (?, ?)').run(me, message);
  res.json({ ok: true });
});

// Staff-only queue of pending applications (mirrors Gift Store Admin's
// staff-only-listing pattern elsewhere in the app).
router.get('/pending', requireFlag('staff'), (req, res) => {
  const rows = db.prepare(`
    SELECT ma.id, ma.message, ma.created_at, u.id AS user_id, u.username
    FROM merchant_applications ma JOIN users u ON u.id = ma.user_id
    WHERE ma.status = 'pending' ORDER BY ma.id ASC
  `).all();
  res.json({ applications: rows });
});

router.post('/:id/approve', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM merchant_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  db.prepare('UPDATE users SET is_merchant = 1 WHERE id = ?').run(app_.user_id);
  db.prepare("UPDATE merchant_applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system', 'Merchant application approved',
    `${req.session.user.username} approved your Merchant application — you're now a Merchant!`
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(app_.user_id);
  const refreshUserPresence = req.app.get('refreshUserPresence');
  if (refreshUserPresence) refreshUserPresence(app_.user_id);
  res.json({ ok: true, user: publicUser(updated) });
});

router.post('/:id/reject', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM merchant_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  db.prepare("UPDATE merchant_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system', 'Merchant application declined',
    `${req.session.user.username} declined your Merchant application.`
  );
  res.json({ ok: true });
});

module.exports = router;

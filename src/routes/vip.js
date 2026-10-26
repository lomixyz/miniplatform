// VIP Subscription (Explore -> VIP Subscription) — a rainbow-animated
// username color, capped at VIP_RAINBOW_MAX_SLOTS concurrent holders at
// once. Same apply -> Staff-approve shape as "Become a Merchant"
// (routes/merchant.js): a user applies, Staff reviews the queue and
// approves/rejects, approval only succeeds if a slot is actually free right
// now (checked at approval time, not at apply time, since slots free up
// over time as grants expire). The rainbow color itself overrides every
// other username color — see usernameStyleAttr() in public/app.js.
const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser } = require('../auth');

const router = express.Router();

const VIP_RAINBOW_MAX_SLOTS = 5;
const VIP_RAINBOW_DAYS = 30;

function activeRainbowCount() {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE is_vip_rainbow = 1 AND (vip_rainbow_expires_at IS NULL OR vip_rainbow_expires_at > datetime('now'))"
  ).get().n;
}

// The current user's own status (slots used/total, their own grant, their
// latest application) — drives the VIP Subscription page's Apply / Pending
// review / Already VIP / "Applications are closed" (slots full) states.
router.get('/status', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_vip_rainbow, vip_rainbow_expires_at FROM users WHERE id = ?').get(me);
  const isVip = !!(user && user.is_vip_rainbow && (!user.vip_rainbow_expires_at || new Date(user.vip_rainbow_expires_at) > new Date()));
  const application = db.prepare(
    'SELECT id, message, status, created_at, reviewed_at FROM vip_rainbow_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(me);
  res.json({
    slotsUsed: activeRainbowCount(),
    slotsTotal: VIP_RAINBOW_MAX_SLOTS,
    isVip,
    expiresAt: isVip ? user.vip_rainbow_expires_at : null,
    application: application || null,
  });
});

router.post('/apply', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_vip_rainbow, vip_rainbow_expires_at FROM users WHERE id = ?').get(me);
  const isVip = !!(user && user.is_vip_rainbow && (!user.vip_rainbow_expires_at || new Date(user.vip_rainbow_expires_at) > new Date()));
  if (isVip) return res.status(400).json({ error: 'You already have the VIP rainbow name' });
  const pending = db.prepare("SELECT 1 FROM vip_rainbow_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending application' });

  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  db.prepare('INSERT INTO vip_rainbow_applications (user_id, message) VALUES (?, ?)').run(me, message);
  const staffIds = db.prepare('SELECT id FROM users WHERE is_staff = 1').all();
  for (const s of staffIds) {
    db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
      s.id, 'system', 'New VIP Subscription application',
      `${req.session.user.username} applied for the VIP rainbow name — review it from Explore -> VIP Subscription.`
    );
  }
  res.json({ ok: true });
});

router.get('/pending', requireFlag('staff'), (req, res) => {
  const rows = db.prepare(`
    SELECT va.id, va.message, va.created_at, u.id AS user_id, u.username
    FROM vip_rainbow_applications va JOIN users u ON u.id = va.user_id
    WHERE va.status = 'pending'
    ORDER BY va.id ASC
  `).all();
  res.json({ applications: rows, slotsUsed: activeRainbowCount(), slotsTotal: VIP_RAINBOW_MAX_SLOTS });
});

router.post('/:id/approve', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM vip_rainbow_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  if (activeRainbowCount() >= VIP_RAINBOW_MAX_SLOTS) {
    return res.status(400).json({ error: `All ${VIP_RAINBOW_MAX_SLOTS} VIP slots are currently taken — wait for one to free up.` });
  }

  const expiresAt = new Date(Date.now() + VIP_RAINBOW_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET is_vip_rainbow = 1, vip_rainbow_expires_at = ? WHERE id = ?').run(expiresAt, app_.user_id);
  db.prepare("UPDATE vip_rainbow_applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system', 'VIP Subscription approved',
    `${req.session.user.username} approved your VIP Subscription — you have the rainbow name for ${VIP_RAINBOW_DAYS} days!`
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(app_.user_id);
  const refreshUserPresence = req.app.get('refreshUserPresence');
  if (refreshUserPresence) refreshUserPresence(app_.user_id);
  res.json({ ok: true, user: publicUser(updated) });
});

router.post('/:id/reject', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM vip_rainbow_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });

  db.prepare("UPDATE vip_rainbow_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system', 'VIP Subscription declined',
    `${req.session.user.username} declined your VIP Subscription application.`
  );
  res.json({ ok: true });
});

module.exports = router;

// VIP Subscription (Explore -> VIP Subscription) — a rainbow-animated
// username color, capped at VIP_RAINBOW_MAX_SLOTS concurrent holders at
// once. Apply -> Staff approves/rejects (same shape as Merchant/Global
// Admin — see routes/merchant.js, routes/globalAdmin.js), NOT an instant
// self-serve buy: coins are only taken once Staff actually approves, never
// just for applying. Staff still sets the coin price
// (app_settings.vip_rainbow_price, editable from this same screen) — that
// part is unchanged, it's only the "does Staff have to approve" bit that
// went back to requiring review. The rainbow color itself overrides every
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

function currentPrice() {
  const row = db.prepare('SELECT vip_rainbow_price FROM app_settings WHERE id = 1').get();
  return (row && row.vip_rainbow_price) || 300000;
}

// Drives the VIP Subscription page's Apply / Pending / Already VIP / "Slots
// full" states.
router.get('/status', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_vip_rainbow, vip_rainbow_expires_at, coins FROM users WHERE id = ?').get(me);
  const isVip = !!(user && user.is_vip_rainbow && (!user.vip_rainbow_expires_at || new Date(user.vip_rainbow_expires_at) > new Date()));
  const application = db.prepare(
    'SELECT id, price, status, created_at, reviewed_at FROM vip_rainbow_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(me);
  res.json({
    slotsUsed: activeRainbowCount(),
    slotsTotal: VIP_RAINBOW_MAX_SLOTS,
    isVip,
    expiresAt: isVip ? user.vip_rainbow_expires_at : null,
    price: currentPrice(),
    days: VIP_RAINBOW_DAYS,
    coins: user ? user.coins : 0,
    application: application || null,
  });
});

// Staff-only — who currently holds one of the VIP_RAINBOW_MAX_SLOTS slots,
// so the page can show the list instead of leaving it a mystery, plus a
// Reset button per holder (see POST /:id/reset below). Clears out anyone
// whose expiry has already passed first, same condition activeRainbowCount()
// uses, so this always matches what "Places Left" shows.
router.get('/holders', requireFlag('staff'), (req, res) => {
  const rows = db.prepare(
    "SELECT id, username, vip_rainbow_expires_at FROM users WHERE is_vip_rainbow = 1 AND (vip_rainbow_expires_at IS NULL OR vip_rainbow_expires_at > datetime('now')) ORDER BY vip_rainbow_expires_at ASC"
  ).all();
  res.json({
    holders: rows.map((r) => ({ id: r.id, username: r.username, expiresAt: r.vip_rainbow_expires_at })),
  });
});

// Staff-only — sets the coin price everyone sees/pays from here on (existing
// VIP holders, and anyone with an application already pending at the old
// price, are unaffected either way — see the `price` column locking it in
// at apply time below).
router.post('/price', requireFlag('staff'), (req, res) => {
  const price = Math.round(Number(req.body && req.body.price));
  if (!Number.isFinite(price) || price < 1 || price > 50_000_000) {
    return res.status(400).json({ error: 'Enter a valid price' });
  }
  db.prepare('INSERT OR IGNORE INTO app_settings (id) VALUES (1)').run();
  db.prepare('UPDATE app_settings SET vip_rainbow_price = ? WHERE id = 1').run(price);
  res.json({ ok: true, price });
});

// Applying only checks eligibility and locks in today's price — it never
// touches coins. Coins are only taken from the applicant once Staff actually
// approves (see POST /:id/approve below), so a rejected or still-pending
// application never costs anything.
router.post('/apply', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_vip_rainbow, vip_rainbow_expires_at, coins FROM users WHERE id = ?').get(me);
  const isVip = !!(user && user.is_vip_rainbow && (!user.vip_rainbow_expires_at || new Date(user.vip_rainbow_expires_at) > new Date()));
  if (isVip) return res.status(400).json({ error: 'You already have the VIP rainbow name' });
  const pending = db.prepare("SELECT 1 FROM vip_rainbow_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending application' });
  if (activeRainbowCount() >= VIP_RAINBOW_MAX_SLOTS) {
    return res.status(400).json({ error: `All ${VIP_RAINBOW_MAX_SLOTS} VIP slots are currently taken — wait for one to free up.` });
  }
  const price = currentPrice();
  if (user.coins < price) return res.status(400).json({ error: 'Not enough coins' });

  db.prepare('INSERT INTO vip_rainbow_applications (user_id, price) VALUES (?, ?)').run(me, price);
  res.json({ ok: true });
});

// Staff-only queue of pending applications (mirrors Merchant/Global Admin
// Applications).
router.get('/pending', requireFlag('staff'), (req, res) => {
  const rows = db.prepare(`
    SELECT va.id, va.price, va.created_at, u.id AS user_id, u.username, u.coins
    FROM vip_rainbow_applications va JOIN users u ON u.id = va.user_id
    WHERE va.status = 'pending' ORDER BY va.id ASC
  `).all();
  res.json({ applications: rows });
});

// Coins are deducted HERE, not at apply time — and re-checked fresh (slot
// availability + the applicant still having enough coins), since both can
// have changed in the time between applying and Staff reviewing it.
router.post('/:id/approve', requireFlag('staff'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM vip_rainbow_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });

  const user = db.prepare('SELECT is_vip_rainbow, vip_rainbow_expires_at, coins FROM users WHERE id = ?').get(app_.user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const isVip = !!(user.is_vip_rainbow && (!user.vip_rainbow_expires_at || new Date(user.vip_rainbow_expires_at) > new Date()));
  if (isVip) return res.status(400).json({ error: 'This user already has the VIP rainbow name' });
  if (activeRainbowCount() >= VIP_RAINBOW_MAX_SLOTS) {
    return res.status(400).json({ error: `All ${VIP_RAINBOW_MAX_SLOTS} VIP slots are currently taken — reset or wait for one to free up first.` });
  }
  if (user.coins < app_.price) {
    return res.status(400).json({ error: `This user no longer has enough coins (needs ${app_.price.toLocaleString()}) — reject instead, or wait for them to earn more and reapply.` });
  }

  const expiresAt = new Date(Date.now() + VIP_RAINBOW_DAYS * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET coins = coins - ?, is_vip_rainbow = 1, vip_rainbow_expires_at = ? WHERE id = ?')
    .run(app_.price, expiresAt, app_.user_id);
  db.logCoinTx(app_.user_id, -app_.price, 'other', 'VIP Subscription — rainbow name (30 days)');
  db.prepare("UPDATE vip_rainbow_applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'coins', 'VIP Subscription approved',
    `${req.session.user.username} approved your VIP Subscription — your rainbow name is active for ${VIP_RAINBOW_DAYS} days (${app_.price.toLocaleString()} coins charged).`
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(app_.user_id);
  const emitToUser = req.app.get('emitToUser');
  if (emitToUser) emitToUser(app_.user_id, 'coins_update', { coins: updated.coins });
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
    `${req.session.user.username} declined your VIP Subscription application — no coins were charged.`
  );
  res.json({ ok: true });
});

// Staff-only — immediately revokes a holder's VIP rainbow name and frees up
// their slot (e.g. abuse, a mistaken approval, making room for someone
// else). No coin refund — this is a moderation action, not a cancellation;
// Staff can always grant coins back separately via Give Coins if warranted.
router.post('/:id/reset', requireFlag('staff'), (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET is_vip_rainbow = 0, vip_rainbow_expires_at = NULL WHERE id = ?').run(targetId);
  const refreshUserPresence = req.app.get('refreshUserPresence');
  if (refreshUserPresence) refreshUserPresence(targetId);
  res.json({ ok: true, username: target.username });
});

module.exports = router;

// Badge Store (Explore -> Badge Store to buy, Badge Panel to equip/unequip)
// — a purely cosmetic one-time purchase per badge, showcased on the buyer's
// profile card. Same buy-with-coins pattern as routes/colors.js.
const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// Full catalog, each tagged with whether the current user already owns it.
router.get('/', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const catalog = db.prepare('SELECT * FROM badges_catalog ORDER BY cost ASC').all();
  const owned = new Set(db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(userId).map((r) => r.badge_id));
  const user = db.prepare('SELECT equipped_badge_id FROM users WHERE id = ?').get(userId);
  res.json({
    catalog: catalog.map((b) => ({ ...b, owned: owned.has(b.id) })),
    equippedBadgeId: user ? user.equipped_badge_id || null : null,
  });
});

router.post('/:id/buy', requireLogin, (req, res) => {
  const badge = db.prepare('SELECT * FROM badges_catalog WHERE id = ?').get(Number(req.params.id));
  if (!badge) return res.status(404).json({ error: 'No such badge' });

  const userId = req.session.user.id;
  const already = db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badge.id);
  if (already) return res.status(400).json({ error: 'You already own this badge' });

  const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  if (!row || row.coins < badge.cost) {
    return res.status(400).json({ error: `Not enough coins — ${badge.name} costs ${badge.cost}` });
  }

  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(badge.cost, userId);
  db.prepare('INSERT INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(userId, badge.id);
  db.logCoinTx(userId, -badge.cost, 'other', `Bought ${badge.name} badge`);
  res.json({ ok: true });
});

// body: { badgeId: <owned badge id> | null } — null unequips.
router.post('/equip', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const badgeId = req.body && req.body.badgeId != null ? Number(req.body.badgeId) : null;
  if (badgeId != null) {
    const owned = db.prepare('SELECT 1 FROM user_badges WHERE user_id = ? AND badge_id = ?').get(userId, badgeId);
    if (!owned) return res.status(400).json({ error: "You don't own that badge" });
  }
  db.prepare('UPDATE users SET equipped_badge_id = ? WHERE id = ?').run(badgeId, userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);
  res.json({ user: publicUser(updated) });
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');
const { EFFECTS, EFFECTS_BY_KEY } = require('../effectsCatalog');

const router = express.Router();

// ---------------------------------------------------------------------
// Effect Shop (full-screen redesign) — direct Buy/Extend buttons instead of
// the old chat-only "/purchase <effect>" + "/purchase confirm" flow. The
// chat commands themselves (socket.js handlePurchaseCommand) are untouched
// and keep working exactly as before; this is just a second, friendlier way
// to reach the same user_effects table.
// ---------------------------------------------------------------------

function effectCatalogForUser(userId) {
  const owned = new Map(
    db.prepare("SELECT effect_key, expires_at FROM user_effects WHERE user_id = ? AND expires_at > datetime('now')")
      .all(userId).map((r) => [r.effect_key, r.expires_at])
  );
  return EFFECTS.map((e) => ({
    key: e.key, emoji: e.emoji, label: e.label, price: e.price, days: e.days,
    owned: owned.has(e.key), expiresAt: owned.get(e.key) || null,
  }));
}

// GET /api/effects — the whole Effect Shop screen in one call: the full
// catalog (with per-user ownership/expiry) and the user's owned-effects list.
router.get('/', requireLogin, (req, res) => {
  const catalog = effectCatalogForUser(req.session.user.id);
  res.json({ catalog, myEffects: catalog.filter((e) => e.owned) });
});

// Buy (or extend) an effect — deducts coins, inserts/extends the
// user_effects row by the effect's `days`. No 60-second confirm step here
// (that's a chat-command-only safeguard against a mistyped command); a
// direct button press is already an explicit, unambiguous action.
router.post('/:key/buy', requireLogin, (req, res) => {
  const entry = EFFECTS_BY_KEY.get(req.params.key);
  if (!entry) return res.status(404).json({ error: 'No such effect' });

  const userId = req.session.user.id;
  const result = db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?')
    .run(entry.price, userId, entry.price);
  if (result.changes === 0) {
    const balance = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId).coins;
    return res.status(400).json({ error: `Not enough coins — ${entry.emoji} /${entry.key} costs ${entry.price.toLocaleString()} (you have ${balance.toLocaleString()}).` });
  }
  db.logCoinTx(userId, -entry.price, 'other', `Purchased effect: /${entry.key} (Effect Shop)`);

  db.prepare(`
    INSERT INTO user_effects (user_id, effect_key, purchased_at, expires_at)
    VALUES (?, ?, datetime('now'), datetime('now', '+' || ? || ' days'))
    ON CONFLICT(user_id, effect_key) DO UPDATE SET
      expires_at = datetime('now', '+' || ? || ' days'),
      purchased_at = datetime('now')
  `).run(userId, entry.key, entry.days, entry.days);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const catalog = effectCatalogForUser(userId);
  res.json({ user: publicUser(updated), catalog, myEffects: catalog.filter((e) => e.owned) });
});

module.exports = router;

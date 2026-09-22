const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser, colorLockedUntil } = require('../auth');

const router = express.Router();

// Catalog now lives in the color_catalog table (see db.js) so Staff can
// change a color's price without a code change — buying a color still
// equips it immediately rather than tracking a separate inventory (see
// routes/colors.js history). A custom color only shows up in chat/
// participant lists for accounts holding none of the role badges — a
// role's color always communicates permission level first, so it can't be
// hidden under a purchased color.
router.get('/', requireLogin, (req, res) => {
  const catalog = db.prepare('SELECT * FROM color_catalog ORDER BY cost ASC').all();
  res.json({ catalog });
});

// Staff-only: change a color's price. Renamed/re-hexed colors aren't
// supported here since nothing asked for that — just the price, which is
// the part that actually needs tuning over time.
router.post('/:id/price', requireFlag('staff'), (req, res) => {
  const item = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'No such color' });
  const cost = Math.round(Number(req.body && req.body.cost));
  if (!Number.isFinite(cost) || cost < 1 || cost > 1_000_000) {
    return res.status(400).json({ error: 'Cost must be a whole number between 1 and 1,000,000' });
  }
  db.prepare('UPDATE color_catalog SET cost = ? WHERE id = ?').run(cost, item.id);
  const updated = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(item.id);
  res.json({ item: updated });
});

router.post('/:id/buy', requireLogin, (req, res) => {
  const item = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'No such color' });

  const userId = req.session.user.id;
  const row = db.prepare('SELECT coins, username_color, username_color_bought_at FROM users WHERE id = ?').get(userId);
  if (!row) return res.status(404).json({ error: 'User not found' });

  // A purchased color is locked in for COLOR_LOCK_DAYS from purchase —
  // buying a different one before then would just be another way to swap
  // it out early, so it's blocked the same as an explicit reset.
  const lockedUntil = colorLockedUntil(row.username_color_bought_at);
  if (lockedUntil && row.username_color !== item.hex) {
    const daysLeft = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return res.status(400).json({ error: `Your current color is locked in for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} before you can switch.` });
  }

  if (row.coins < item.cost) {
    return res.status(400).json({ error: `Not enough coins — ${item.name} costs ${item.cost}` });
  }

  db.prepare("UPDATE users SET coins = coins - ?, username_color = ?, username_color_bought_at = datetime('now') WHERE id = ?")
    .run(item.cost, item.hex, userId);
  db.logCoinTx(userId, -item.cost, 'other', `Bought ${item.name} username color`);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // Reflect the new color immediately for anyone else currently viewing this
  // user's room (Participants panel) — future chat messages already pick up
  // the fresh color server-side, this covers the live member list too.
  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

// Free — go back to the default role/level-based color. Blocked while a
// purchased color is still within its COLOR_LOCK_DAYS lock, same reasoning
// as switching to a different paid color above.
router.post('/reset', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const row = db.prepare('SELECT username_color, username_color_bought_at FROM users WHERE id = ?').get(userId);
  const lockedUntil = row && colorLockedUntil(row.username_color_bought_at);
  if (lockedUntil) {
    const daysLeft = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return res.status(400).json({ error: `Your current color is locked in for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} before you can reset it.` });
  }

  db.prepare('UPDATE users SET username_color = NULL, username_color_bought_at = NULL WHERE id = ?').run(userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

module.exports = router;

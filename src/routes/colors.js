const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// Fixed catalog — no separate ownership/inventory table in this build, so
// buying a color spends coins and equips it immediately (re-buying the same
// one later costs coins again rather than being free to re-equip). A custom
// color only shows up in chat/participant lists for accounts holding none of
// the role badges — a role's color always communicates permission level
// first, so it can't be hidden under a purchased color.
const CATALOG = [
  { id: 'sunset', name: 'Sunset Orange', hex: '#f97316', cost: 200 },
  { id: 'ocean', name: 'Ocean Teal', hex: '#14b8a6', cost: 200 },
  { id: 'violet', name: 'Royal Violet', hex: '#8b5cf6', cost: 300 },
  { id: 'rose', name: 'Rose Pink', hex: '#f43f5e', cost: 300 },
  { id: 'lime', name: 'Electric Lime', hex: '#84cc16', cost: 400 },
  { id: 'gold', name: 'Champion Gold', hex: '#eab308', cost: 500 },
  { id: 'ice', name: 'Ice Blue', hex: '#38bdf8', cost: 500 },
  { id: 'chrome', name: 'Chrome Silver', hex: '#cbd5e1', cost: 750 },
];

router.get('/', requireLogin, (req, res) => {
  res.json({ catalog: CATALOG });
});

router.post('/:id/buy', requireLogin, (req, res) => {
  const item = CATALOG.find((c) => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'No such color' });

  const userId = req.session.user.id;
  const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  if (!row || row.coins < item.cost) {
    return res.status(400).json({ error: `Not enough coins — ${item.name} costs ${item.cost}` });
  }

  db.prepare('UPDATE users SET coins = coins - ?, username_color = ? WHERE id = ?').run(item.cost, item.hex, userId);
  db.logCoinTx(userId, -item.cost, 'other', `Bought ${item.name} username color`);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // Reflect the new color immediately for anyone else currently viewing this
  // user's room (Participants panel) — future chat messages already pick up
  // the fresh color server-side, this covers the live member list too.
  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

// Free — go back to the default role/level-based color.
router.post('/reset', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  db.prepare('UPDATE users SET username_color = NULL WHERE id = ?').run(userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

module.exports = router;

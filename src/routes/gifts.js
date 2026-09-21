const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const gifts = db.prepare('SELECT * FROM gifts_catalog ORDER BY cost').all();
  res.json({ gifts });
});

const MAX_FAVORITES = 10;

// A user's own quick-send gift bar (shown in the chat room), capped at 10 —
// picked from the full catalog via the "+" button in that bar, which opens
// this list to favorite/unfavorite. Kept separate from the read-only /
// catalog above so the client can tell "everything that exists" from
// "what's actually offered in the room's gift bar" for this user.
router.get('/favorites', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const gifts = db.prepare(`
    SELECT g.* FROM gift_favorites f
    JOIN gifts_catalog g ON g.id = f.gift_id
    WHERE f.user_id = ?
    ORDER BY f.added_at
  `).all(me);
  res.json({ gifts });
});

router.post('/favorites', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const giftId = Number((req.body || {}).giftId);
  const gift = db.prepare('SELECT id FROM gifts_catalog WHERE id = ?').get(giftId);
  if (!gift) return res.status(404).json({ error: 'No such gift' });

  const count = db.prepare('SELECT COUNT(*) c FROM gift_favorites WHERE user_id = ?').get(me).c;
  const already = db.prepare('SELECT 1 FROM gift_favorites WHERE user_id = ? AND gift_id = ?').get(me, giftId);
  if (!already && count >= MAX_FAVORITES) {
    return res.status(400).json({ error: `You can only favorite up to ${MAX_FAVORITES} gifts — remove one first` });
  }
  db.prepare('INSERT OR IGNORE INTO gift_favorites (user_id, gift_id) VALUES (?, ?)').run(me, giftId);
  res.json({ ok: true });
});

router.delete('/favorites/:giftId', requireLogin, (req, res) => {
  const me = req.session.user.id;
  db.prepare('DELETE FROM gift_favorites WHERE user_id = ? AND gift_id = ?').run(me, Number(req.params.giftId));
  res.json({ ok: true });
});

module.exports = router;

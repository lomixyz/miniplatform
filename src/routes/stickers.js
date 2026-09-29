// Sticker Store (Explore -> Sticker Store) — packs of emoji "stickers"
// bought once with coins; an owned pack's stickers then appear in the chat
// emoji picker's Stickers tab (see #emojiPickerPopover in app.js).
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', require('../auth').requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const packs = db.prepare('SELECT * FROM sticker_packs ORDER BY cost ASC').all();
  const owned = new Set(db.prepare('SELECT pack_id FROM user_sticker_packs WHERE user_id = ?').all(userId).map((r) => r.pack_id));
  res.json({
    packs: packs.map((p) => ({ ...p, stickers: JSON.parse(p.stickers), owned: owned.has(p.id) })),
  });
});

router.post('/:id/buy', require('../auth').requireLogin, (req, res) => {
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(Number(req.params.id));
  if (!pack) return res.status(404).json({ error: 'No such sticker pack' });

  const userId = req.session.user.id;
  const already = db.prepare('SELECT 1 FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?').get(userId, pack.id);
  if (already) return res.status(400).json({ error: 'You already own this pack' });

  const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  if (!row || row.coins < pack.cost) {
    return res.status(400).json({ error: `Not enough coins — ${pack.name} costs ${pack.cost}` });
  }

  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(pack.cost, userId);
  db.prepare('INSERT INTO user_sticker_packs (user_id, pack_id) VALUES (?, ?)').run(userId, pack.id);
  db.logCoinTx(userId, -pack.cost, 'other', `Bought ${pack.name} sticker pack`);
  res.json({ ok: true });
});

module.exports = router;

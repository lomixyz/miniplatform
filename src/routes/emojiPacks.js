// Emoji Store (Admin Panel -> Emoji Store) — free-for-everyone emoji packs
// that Staff curate, distinct from the paid Sticker Store (routes/stickers.js):
// no coins, no per-user ownership. Every logged-in user can see every pack;
// only Staff can create/edit/delete them. Surfaces as extra tabs in the chat
// emoji picker (see #emojiPickerPopover in app.js) alongside the built-in
// default emoji tab and the owned-Sticker-Store tab.
const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag } = require('../auth');

const router = express.Router();

const MAX_PACK_NAME = 40;
const MAX_EMOJI_PER_PACK = 200;
const MAX_PACKS = 100;

function shapePack(row) {
  return { id: row.id, name: row.name, icon: row.icon, emoji: JSON.parse(row.emoji) };
}

// A single emoji added with no target pack lands here — created on first
// use so the picker never needs a separate "loose emoji" concept.
function ensureCustomEmojiPack() {
  let row = db.prepare("SELECT * FROM emoji_packs WHERE name = 'Custom'").get();
  if (!row) {
    const info = db.prepare('INSERT INTO emoji_packs (name, icon, emoji) VALUES (?, ?, ?)').run('Custom', '🧩', '[]');
    row = db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

// Open to any logged-in user — read-only list, no per-user ownership to filter.
router.get('/', requireLogin, (req, res) => {
  const packs = db.prepare('SELECT * FROM emoji_packs ORDER BY id').all();
  res.json({ packs: packs.map(shapePack) });
});

router.post('/', requireFlag('staff'), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, MAX_PACK_NAME);
  const icon = String((req.body && req.body.icon) || '').trim().slice(0, 8);
  const firstEmoji = String((req.body && req.body.emoji) || '').trim().slice(0, 8);
  if (!name) return res.status(400).json({ error: 'Pack name is required' });
  if (!icon) return res.status(400).json({ error: 'Pick a tab icon for the pack (a single emoji)' });
  const count = db.prepare('SELECT COUNT(*) c FROM emoji_packs').get().c;
  if (count >= MAX_PACKS) return res.status(400).json({ error: `You already have ${MAX_PACKS} packs — delete one first` });

  const emoji = firstEmoji ? [firstEmoji] : [];
  const info = db.prepare('INSERT INTO emoji_packs (name, icon, emoji) VALUES (?, ?, ?)').run(name, icon, JSON.stringify(emoji));
  const row = db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(info.lastInsertRowid);
  res.json({ pack: shapePack(row) });
});

router.delete('/:id', requireFlag('staff'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'No such pack' });
  db.prepare('DELETE FROM emoji_packs WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Add a single emoji, either to an existing pack (packId given) or, with no
// packId, to the auto-managed "Custom" pack — this is the "add single
// emoji" path, separate from creating a whole named pack above.
router.post('/emoji', requireFlag('staff'), (req, res) => {
  const emoji = String((req.body && req.body.emoji) || '').trim();
  if (!emoji) return res.status(400).json({ error: 'No emoji given' });
  if ([...emoji].length > 8) return res.status(400).json({ error: 'That doesn\'t look like a single emoji' });

  const packId = req.body && req.body.packId ? Number(req.body.packId) : null;
  const row = packId ? db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(packId) : ensureCustomEmojiPack();
  if (!row) return res.status(404).json({ error: 'No such pack' });

  const list = JSON.parse(row.emoji);
  if (list.length >= MAX_EMOJI_PER_PACK) return res.status(400).json({ error: `${row.name} is full (${MAX_EMOJI_PER_PACK} max)` });
  if (list.includes(emoji)) return res.status(400).json({ error: `${row.name} already has that emoji` });
  list.push(emoji);
  db.prepare('UPDATE emoji_packs SET emoji = ? WHERE id = ?').run(JSON.stringify(list), row.id);
  res.json({ pack: shapePack(db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(row.id)) });
});

router.delete('/:id/emoji', requireFlag('staff'), (req, res) => {
  const id = Number(req.params.id);
  const emoji = String((req.body && req.body.emoji) || '').trim();
  const row = db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'No such pack' });
  const list = JSON.parse(row.emoji).filter((e) => e !== emoji);
  db.prepare('UPDATE emoji_packs SET emoji = ? WHERE id = ?').run(JSON.stringify(list), row.id);
  res.json({ pack: shapePack(db.prepare('SELECT * FROM emoji_packs WHERE id = ?').get(row.id)) });
});

module.exports = router;

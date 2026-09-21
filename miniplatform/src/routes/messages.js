const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

// List conversation threads: one row per other user, with their last message and unread count.
router.get('/', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const partners = db.prepare(`
    SELECT DISTINCT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS other_id
    FROM private_messages WHERE from_user_id = ? OR to_user_id = ?
  `).all(me, me, me);

  const threads = partners.map(({ other_id }) => {
    const other = db.prepare('SELECT id, username FROM users WHERE id = ?').get(other_id);
    const last = db.prepare(`
      SELECT * FROM private_messages
      WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
      ORDER BY id DESC LIMIT 1
    `).get(me, other_id, other_id, me);
    const unread = db.prepare('SELECT COUNT(*) c FROM private_messages WHERE from_user_id = ? AND to_user_id = ? AND is_read = 0').get(other_id, me).c;
    return { user: other, lastMessage: last, unread };
  }).sort((a, b) => (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0));

  const totalUnread = threads.reduce((sum, t) => sum + t.unread, 0);
  res.json({ threads, unread: totalUnread });
});

router.get('/:username', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const other = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const messages = db.prepare(`
    SELECT * FROM private_messages
    WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
    ORDER BY id ASC LIMIT 100
  `).all(me, other.id, other.id, me);

  db.prepare('UPDATE private_messages SET is_read = 1 WHERE from_user_id = ? AND to_user_id = ?').run(other.id, me);

  res.json({ user: other, messages: messages.map((m) => ({ ...m, is_read: !!m.is_read })) });
});

router.post('/:username', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const other = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (other.id === me) return res.status(400).json({ error: "You can't message yourself" });

  const content = String((req.body && req.body.content) || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Message cannot be empty' });

  const info = db.prepare('INSERT INTO private_messages (from_user_id, to_user_id, content) VALUES (?, ?, ?)').run(me, other.id, content);
  const row = db.prepare('SELECT * FROM private_messages WHERE id = ?').get(info.lastInsertRowid);
  const shaped = { ...row, is_read: !!row.is_read };

  // Live-push to any open sockets for both sides so a private chat updates
  // instantly without either side needing to reopen the Emails panel.
  const io = req.app.get('io');
  if (io) {
    const me_ = req.session.user;
    for (const [, s] of io.sockets.sockets) {
      if (s.data.user && (s.data.user.id === other.id || s.data.user.id === me)) {
        s.emit('private_message', { ...shaped, fromUsername: me_.username, toUsername: other.username });
      }
    }
  }

  res.json({ message: shaped });
});

module.exports = router;

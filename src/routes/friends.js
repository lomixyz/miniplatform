const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');
const presence = require('../presence');

const router = express.Router();

function pairRow(userId, otherId) {
  return db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(userId, otherId, otherId, userId);
}

// Accepted friends (with online status) + incoming/outgoing pending requests.
router.get('/', requireLogin, (req, res) => {
  const me = req.session.user.id;

  const accepted = db.prepare(`
    SELECT u.*, f.id AS friendship_id FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END)
    WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
    ORDER BY u.username
  `).all(me, me, me);

  const incoming = db.prepare(`
    SELECT u.*, f.id AS friendship_id FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
  `).all(me);

  const outgoing = db.prepare(`
    SELECT u.*, f.id AS friendship_id FROM friendships f
    JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
  `).all(me);

  res.json({
    friends: accepted.map((u) => ({ ...publicUser(u), friendship_id: u.friendship_id, online: presence.isOnline(u.id), status: presence.effectiveStatus(u.id, u.status) })),
    incoming: incoming.map((u) => ({ ...publicUser(u), friendship_id: u.friendship_id })),
    outgoing: outgoing.map((u) => ({ ...publicUser(u), friendship_id: u.friendship_id })),
  });
});

router.post('/request', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const username = String((req.body && req.body.username) || '').trim();
  const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!target) return res.status(404).json({ error: `No user named "${username}"` });
  if (target.id === me) return res.status(400).json({ error: "You can't friend yourself" });

  const existing = pairRow(me, target.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
    return res.status(400).json({ error: 'A friend request already exists between you two' });
  }

  db.prepare('INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)').run(me, target.id, 'pending');
  res.json({ ok: true });
});

router.post('/:friendshipId/accept', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(Number(req.params.friendshipId));
  if (!row || row.addressee_id !== me) return res.status(404).json({ error: 'Request not found' });
  db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.post('/:friendshipId/decline', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(Number(req.params.friendshipId));
  if (!row || (row.addressee_id !== me && row.requester_id !== me)) return res.status(404).json({ error: 'Request not found' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

router.delete('/:friendshipId', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(Number(req.params.friendshipId));
  if (!row || (row.addressee_id !== me && row.requester_id !== me)) return res.status(404).json({ error: 'Friendship not found' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;

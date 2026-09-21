const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag } = require('../auth');

const router = express.Router();

// Announcements and Blog are the same mechanism (a Staff-authored post) with
// a different label/feed — matches the Explore hub having both as separate
// cards, backed by one 'posts' table with a type column.
router.get('/', requireLogin, (req, res) => {
  const type = req.query.type === 'blog' ? 'blog' : 'announcement';
  const posts = db.prepare('SELECT * FROM posts WHERE type = ? ORDER BY id DESC LIMIT 50').all(type);
  res.json({ posts });
});

router.post('/', requireFlag('staff'), (req, res) => {
  const type = req.body && req.body.type === 'blog' ? 'blog' : 'announcement';
  const title = String((req.body && req.body.title) || '').trim().slice(0, 140);
  const content = String((req.body && req.body.content) || '').trim().slice(0, 4000);
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  const info = db.prepare('INSERT INTO posts (type, title, content, created_by) VALUES (?, ?, ?, ?)')
    .run(type, title, content, req.session.user.username);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post });
});

router.delete('/:id', requireFlag('staff'), (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;

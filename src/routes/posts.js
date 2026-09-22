const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

const REACTION_KINDS = new Set(['like', 'dislike', 'favorite']);

// Attaches { like_count, dislike_count, favorite_count, my_reactions: [...] }
// to each post — cheap enough at the 50-row page size this list is capped to.
function withReactions(posts, userId) {
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM post_reactions WHERE post_id = ? AND kind = ?");
  const mineStmt = db.prepare('SELECT kind FROM post_reactions WHERE post_id = ? AND user_id = ?');
  return posts.map((p) => ({
    ...p,
    like_count: countStmt.get(p.id, 'like').n,
    dislike_count: countStmt.get(p.id, 'dislike').n,
    favorite_count: countStmt.get(p.id, 'favorite').n,
    my_reactions: mineStmt.all(p.id, userId).map((r) => r.kind),
  }));
}

// Announcements and Blog share one 'posts' table (a type column tells them
// apart) but have different authorship rules: Announcements are an official
// Staff-only channel, while the Blog is open to every user — anyone can
// post, and can take down their own post; Staff can still remove any post
// in either feed. Blog posts can also carry a picture and take reactions
// (favorite/like/dislike); Announcements don't use either, but the columns
// are harmless to leave empty for them.
router.get('/', requireLogin, (req, res) => {
  const type = req.query.type === 'blog' ? 'blog' : 'announcement';
  const posts = db.prepare('SELECT * FROM posts WHERE type = ? ORDER BY id DESC LIMIT 50').all(type);
  res.json({ posts: withReactions(posts, req.session.user.id) });
});

router.post('/', requireLogin, (req, res) => {
  const type = req.body && req.body.type === 'blog' ? 'blog' : 'announcement';
  if (type === 'announcement' && !req.session.user.is_staff) {
    return res.status(403).json({ error: 'Only Staff can post an Announcement' });
  }
  const title = String((req.body && req.body.title) || '').trim().slice(0, 140);
  const content = String((req.body && req.body.content) || '').trim().slice(0, 4000);
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  let image = req.body && req.body.image ? String(req.body.image) : null;
  if (image) {
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(image)) {
      return res.status(400).json({ error: 'Invalid image' });
    }
    if (image.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large' });
    }
  }

  const info = db.prepare('INSERT INTO posts (type, title, content, image, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(type, title, content, image, req.session.user.username);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: withReactions([post], req.session.user.id)[0] });
});

// Staff can remove any post in either feed; a Blog post can also be removed
// by whoever wrote it (Announcements stay Staff-only to delete too, same as
// to create).
router.delete('/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const isOwnBlogPost = post.type === 'blog' && post.created_by === req.session.user.username;
  if (!req.session.user.is_staff && !isOwnBlogPost) {
    return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
  }

  db.prepare('DELETE FROM post_reactions WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Toggle a reaction: sending the same kind again removes it; like/dislike
// are mutually exclusive (adding one clears the other); favorite is
// independent of both.
router.post('/:id/react', requireLogin, (req, res) => {
  const postId = Number(req.params.id);
  const userId = req.session.user.id;
  const kind = req.body && req.body.kind;
  if (!REACTION_KINDS.has(kind)) return res.status(400).json({ error: 'Invalid reaction' });

  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const existing = db.prepare('SELECT id FROM post_reactions WHERE post_id = ? AND user_id = ? AND kind = ?').get(postId, userId, kind);
  if (existing) {
    db.prepare('DELETE FROM post_reactions WHERE id = ?').run(existing.id);
  } else {
    if (kind === 'like' || kind === 'dislike') {
      const opposite = kind === 'like' ? 'dislike' : 'like';
      db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND kind = ?').run(postId, userId, opposite);
    }
    db.prepare('INSERT INTO post_reactions (post_id, user_id, kind) VALUES (?, ?, ?)').run(postId, userId, kind);
  }

  const fresh = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  res.json({ post: withReactions([fresh], userId)[0] });
});

module.exports = router;

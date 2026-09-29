const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

const REACTION_KINDS = new Set(['like', 'dislike', 'favorite']);
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 6;

// Attaches { like_count, dislike_count, favorite_count, my_reactions: [...] }
// to each post — cheap enough at the 50-row page size this list is capped to.
// Also expands a Poll post's poll_options (stored as a raw JSON string) into
// a `poll` object with live per-option vote counts and the caller's own
// vote, and drops the raw column from the response either way.
function withReactions(posts, userId) {
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM post_reactions WHERE post_id = ? AND kind = ?");
  const mineStmt = db.prepare('SELECT kind FROM post_reactions WHERE post_id = ? AND user_id = ?');
  const voteCountStmt = db.prepare('SELECT option_index, COUNT(*) AS n FROM post_poll_votes WHERE post_id = ? GROUP BY option_index');
  const myVoteStmt = db.prepare('SELECT option_index FROM post_poll_votes WHERE post_id = ? AND user_id = ?');
  return posts.map((p) => {
    const { poll_options, ...rest } = p;
    const shaped = {
      ...rest,
      like_count: countStmt.get(p.id, 'like').n,
      dislike_count: countStmt.get(p.id, 'dislike').n,
      favorite_count: countStmt.get(p.id, 'favorite').n,
      my_reactions: mineStmt.all(p.id, userId).map((r) => r.kind),
    };
    if (poll_options) {
      let options = [];
      try { options = JSON.parse(poll_options); } catch { options = []; }
      const counts = options.map(() => 0);
      for (const row of voteCountStmt.all(p.id)) {
        if (row.option_index >= 0 && row.option_index < counts.length) counts[row.option_index] = row.n;
      }
      const totalVotes = counts.reduce((a, b) => a + b, 0);
      const mine = myVoteStmt.get(p.id, userId);
      shaped.poll = {
        options,
        votes: counts,
        totalVotes,
        myVote: mine ? mine.option_index : null,
      };
    }
    return shaped;
  });
}

// Announcements and Blog share one 'posts' table (a type column tells them
// apart) but have different authorship rules: Announcements are an official
// Staff-only channel, while the Blog is open to every user — anyone can
// post, and can take down their own post; Staff can still remove any post
// in either feed. Blog posts can also carry a picture and take reactions
// (favorite/like/dislike); Announcements don't use either, but the columns
// are harmless to leave empty for them.
// type=all (used by the Home screen's Feed card) merges both into one
// chronological feed — a real social feed shows everything, not just one
// channel; type=blog / type=announcement (used by the dedicated Explore ->
// Blog / Announcements screens) still filter to just the one.
router.get('/', requireLogin, (req, res) => {
  let posts;
  if (req.query.type === 'all') {
    posts = db.prepare("SELECT * FROM posts WHERE type IN ('announcement','blog') ORDER BY id DESC LIMIT 50").all();
  } else {
    const type = req.query.type === 'blog' ? 'blog' : 'announcement';
    posts = db.prepare('SELECT * FROM posts WHERE type = ? ORDER BY id DESC LIMIT 50').all(type);
  }
  res.json({ posts: withReactions(posts, req.session.user.id) });
});

router.post('/', requireLogin, (req, res) => {
  const type = req.body && req.body.type === 'blog' ? 'blog' : 'announcement';
  if (type === 'announcement' && !req.session.user.is_staff) {
    return res.status(403).json({ error: 'Only Staff can post an Announcement' });
  }
  const content = String((req.body && req.body.content) || '').trim().slice(0, 4000);
  if (!content) return res.status(400).json({ error: 'Content is required' });
  // The simplified "What's on your mind?" composer (Home Feed) sends content
  // only, no separate title — auto-derive one from the content so the
  // existing `title NOT NULL` schema and every other screen that shows a
  // post's title (Announcements/Blog under Explore) keep working unchanged.
  let title = String((req.body && req.body.title) || '').trim().slice(0, 140);
  if (!title) title = content.length > 60 ? `${content.slice(0, 57)}...` : content;

  let image = req.body && req.body.image ? String(req.body.image) : null;
  if (image) {
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(image)) {
      return res.status(400).json({ error: 'Invalid image' });
    }
    if (image.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large' });
    }
  }

  // Poll (Home Feed's "📊 Poll" composer button): `content` is the question
  // (already validated above), pollOptions is the list of choices. A poll is
  // a Blog post like any other (same authorship, deletion and reaction
  // rules) that additionally carries poll_options — see withReactions above
  // for how it's expanded back into live results.
  let pollOptionsJson = null;
  if (req.body && Array.isArray(req.body.pollOptions)) {
    const options = req.body.pollOptions
      .map((o) => String(o || '').trim().slice(0, 80))
      .filter(Boolean);
    if (options.length) {
      if (type !== 'blog') return res.status(400).json({ error: 'Only Blog posts can be a Poll' });
      if (options.length < POLL_MIN_OPTIONS) return res.status(400).json({ error: `A poll needs at least ${POLL_MIN_OPTIONS} options` });
      if (options.length > POLL_MAX_OPTIONS) return res.status(400).json({ error: `A poll can have at most ${POLL_MAX_OPTIONS} options` });
      pollOptionsJson = JSON.stringify(options);
    }
  }

  const info = db.prepare('INSERT INTO posts (type, title, content, image, created_by, poll_options) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, title, content, image, req.session.user.username, pollOptionsJson);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ post: withReactions([post], req.session.user.id)[0] });
});

// Vote (or change your vote) on a poll post. One row per (post, user) —
// voting again with a different option just overwrites it via ON CONFLICT.
router.post('/:id/vote', requireLogin, (req, res) => {
  const postId = Number(req.params.id);
  const userId = req.session.user.id;
  const optionIndex = Number(req.body && req.body.optionIndex);

  const post = db.prepare('SELECT id, poll_options FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!post.poll_options) return res.status(400).json({ error: 'This post is not a poll' });
  let options = [];
  try { options = JSON.parse(post.poll_options); } catch { options = []; }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
    return res.status(400).json({ error: 'Invalid poll option' });
  }

  db.prepare(`
    INSERT INTO post_poll_votes (post_id, user_id, option_index) VALUES (?, ?, ?)
    ON CONFLICT(post_id, user_id) DO UPDATE SET option_index = excluded.option_index, voted_at = datetime('now')
  `).run(postId, userId, optionIndex);

  const fresh = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  res.json({ post: withReactions([fresh], userId)[0] });
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
  db.prepare('DELETE FROM post_poll_votes WHERE post_id = ?').run(id);
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

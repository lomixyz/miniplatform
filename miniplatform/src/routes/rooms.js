const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const presence = require('../presence');

const router = express.Router();

function shapeRoom(row, me) {
  const isFavorite = !!db.prepare('SELECT 1 FROM room_favorites WHERE user_id = ? AND room_id = ?').get(me, row.id);
  // Owner (created_by — null for the built-in official rooms, which have no
  // user owner) and moderators (room_moderators — a room can have several,
  // set via /mod — see socket.js), surfaced so the client's Room Info screen
  // can show both without a separate round trip.
  const owner = row.created_by ? db.prepare('SELECT username FROM users WHERE id = ?').get(row.created_by) : null;
  const moderators = db.prepare(`
    SELECT u.username FROM room_moderators rm JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? ORDER BY u.username COLLATE NOCASE
  `).all(row.id).map((r) => r.username);
  const myMembership = db.prepare('SELECT ghost_mode FROM room_memberships WHERE user_id = ? AND room_id = ?').get(me, row.id);
  return {
    id: row.id,
    name: row.name,
    is_official: !!row.is_official,
    capacity: row.capacity,
    memberCount: presence.getRoomCount(row.id),
    isFavorite,
    created_at: row.created_at,
    owner_username: owner ? owner.username : null,
    moderator_usernames: moderators,
    description: row.description || '',
    lock_level: row.lock_level || 0,
    my_ghost_mode: !!(myMembership && myMembership.ghost_mode),
  };
}

// All rooms, each tagged with a live member count and this user's favorite state.
router.get('/', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id').all();
  res.json({ rooms: rooms.map((r) => shapeRoom(r, me)) });
});

// Rooms this user has actually visited, most-recent first — for the Home
// screen's "Current Chat Rooms" and the browser's "Recent Rooms" section.
router.get('/recent', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const rows = db.prepare(`
    SELECT r.* FROM room_visits v
    JOIN rooms r ON r.id = v.room_id
    WHERE v.user_id = ?
    ORDER BY v.visited_at DESC
    LIMIT 8
  `).all(me);
  res.json({ rooms: rows.map((r) => shapeRoom(r, me)) });
});

// User-created rooms are always chat rooms — this build has no games.
router.post('/', requireLogin, (req, res) => {
  const { name } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Room name too short' });
  try {
    const info = db.prepare("INSERT INTO rooms (name, created_by, is_official, capacity, room_type) VALUES (?, ?, 0, 50, 'chat')").run(name.trim(), req.session.user.id);
    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
    res.json({ room: shapeRoom(row, req.session.user.id) });
  } catch (e) {
    res.status(409).json({ error: 'Room name already exists' });
  }
});

router.post('/:id/favorite', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const roomId = Number(req.params.id);
  const { favorite } = req.body || {};
  if (favorite) {
    db.prepare('INSERT OR IGNORE INTO room_favorites (user_id, room_id) VALUES (?, ?)').run(me, roomId);
  } else {
    db.prepare('DELETE FROM room_favorites WHERE user_id = ? AND room_id = ?').run(me, roomId);
  }
  res.json({ ok: true, favorite: !!favorite });
});

router.get('/:id/messages', requireLogin, (req, res) => {
  const roomId = Number(req.params.id);
  const me = req.session.user.id;

  // No chat is visible to ANYONE — including Staff and Global Admin, no
  // exceptions — until they've actually entered this specific room (i.e.
  // they're a currently-active member via room_memberships, established by
  // the join_room socket event). Being logged in, or having been a member
  // before and since left, isn't enough; this is checked fresh every call.
  const membership = db.prepare('SELECT active, history_cleared_at FROM room_memberships WHERE user_id = ? AND room_id = ?').get(me, roomId);
  if (!membership || !membership.active) {
    return res.status(403).json({ error: 'Enter this room first to see its chat.' });
  }

  // If this user has explicitly left, logged out, or been removed from this
  // room since they last saw it, only show messages posted after that point
  // — their chat view comes back clean instead of replaying old history.
  // Someone who just refreshed/reconnected (never touched this column)
  // still sees everything, same as before.
  const clearedAt = membership.history_cleared_at;

  const messages = clearedAt
    ? db.prepare(`
        SELECT m.*, COALESCE(u.is_staff, 0) AS is_staff, COALESCE(u.is_global_admin, 0) AS is_global_admin
        FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ? AND m.created_at > ?
        ORDER BY m.id DESC LIMIT 50
      `).all(roomId, clearedAt).reverse()
    : db.prepare(`
        SELECT m.*, COALESCE(u.is_staff, 0) AS is_staff, COALESCE(u.is_global_admin, 0) AS is_global_admin
        FROM messages m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.room_id = ?
        ORDER BY m.id DESC LIMIT 50
      `).all(roomId).reverse();

  res.json({ messages: messages.map(m => ({ ...m, is_staff: !!m.is_staff, is_global_admin: !!m.is_global_admin })) });
});

module.exports = router;

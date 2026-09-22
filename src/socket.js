const fs = require('fs');
const path = require('path');
const db = require('./db');
const { levelFromXp, XP_REWARDS } = require('./level');
const xpStore = require('./xp');
const presence = require('./presence');
const voucher = require('./voucher');
const chatbots = require('./chatbots');
const roomSilence = require('./roomSilence');
const { ROLEPLAY_COMMANDS, BENGALI_COMMANDS } = require('./roleplayCommands');

// Voice notes and shared pictures (see canSendMedia below) are written to
// disk under public/uploads and served back out by express.static (already
// mounted on the public/ folder in server.js) — no separate static route
// needed. One flat folder; filenames are random so nobody can guess or
// collide with another upload.
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MEDIA_MAX_BYTES = 6 * 1024 * 1024; // 6MB — comfortably under the 8MB socket.io payload cap
const MEDIA_EXT = { image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }, voice: { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' } };

// In-memory state: which room each socket is currently FOCUSED on (i.e.
// receiving live messages for). "Focused" on a room is separate from being a
// MEMBER of it — membership lives in the room_memberships table and
// survives disconnects/refreshes/switching to another room; only an
// explicit leave, a kick/ban, or 5 hours of inactivity removes someone from
// a room's participant list.

// A member stays listed until they leave manually, get kicked, or go idle.
const ROOM_IDLE_TIMEOUT_MS = 5 * 60 * 60 * 1000; // 5 hours

// A disconnect+reconnect within this window (page refresh, a brief network
// blip) is treated as still-present rather than "came back after being
// away" — see wasReachableBefore / announcedEntryThisConnection below.
const RECONNECT_GRACE_MS = 10_000;

// "/gift all" or "/gift all <gift name>" — a shower to everyone currently in the room.
const GIFT_ALL_COMMAND = /^\/gift\s+all(?:\s+(.+))?\s*$/i;
// "/gift <username> <gift name>" — a targeted gift sent via chat command.
const GIFT_TO_COMMAND = /^\/gift\s+(\S+)\s+(.+)$/i;
// "/pick <code>" — claim an active room voucher.
const PICK_COMMAND = /^\/pick\s+(\S+)\s*$/i;
// "/kick <username>" / "/bump <username>" — Staff or Global Admin room moderation.
const KICK_COMMAND = /^\/kick\s+(\S+)\s*$/i;
const BUMP_COMMAND = /^\/bump\s+(\S+)\s*$/i;
// "/silence <seconds>" / "/unsilence" — Staff or Global Admin only; see canBypassSilence.
const SILENCE_COMMAND = /^\/silence\s+(\d+)\s*$/i;
const UNSILENCE_COMMAND = /^\/unsilence\s*$/i;
// "/mod <username>" / "/unmod" — the room owner (or Staff/Global Admin) only.
const MOD_COMMAND = /^\/mod\s+(\S+)\s*$/i;
const UNMOD_COMMAND = /^\/unmod\s+(\S+)\s*$/i;
// "/ban <username>" / "/unban <username>" — same permission tier and effect
// as the Room Settings Banned tab, just reachable from chat.
const BAN_COMMAND = /^\/ban\s+(\S+)\s*$/i;
const UNBAN_COMMAND = /^\/unban\s+(\S+)\s*$/i;
// A silence never lasts longer than this, whatever's typed after /silence —
// a sane ceiling against a fat-fingered "/silence 999999999".
const MAX_SILENCE_SECONDS = 24 * 60 * 60;

// Roleplay/emote commands ("/hug", "/dance", "/8ball", ...) — matches "/word"
// optionally followed by an argument (a target username, a free-text
// argument for /act, etc). Only acts if the word is a known command; an
// unknown "/word" still falls through to the "Unrecognized command" error.
const ROLEPLAY_COMMAND = /^\/([a-z0-9_]+)(?:\s+(.+))?\s*$/i;
const ROLEPLAY_MAP = new Map();
for (const [cmd, selfTpl, targetTpl] of ROLEPLAY_COMMANDS) {
  ROLEPLAY_MAP.set(cmd, { selfTpl, targetTpl, isFreeform: cmd === 'act' });
}
for (const [cmd, selfTpl] of BENGALI_COMMANDS) {
  ROLEPLAY_MAP.set(cmd, { selfTpl, targetTpl: null, isFreeform: false });
}
// Commands with real custom logic rather than a canned text template — kept
// out of ROLEPLAY_MAP and handled explicitly in the "Special" block below.
const SPECIAL_COMMANDS = new Set(['8ball', 'coffee', 'cupid', 'findmymatch', 'flame', 'whackit']);
const EIGHT_BALL_ANSWERS = [
  'Yes, definitely!', 'It is certain.', 'Without a doubt.', 'You may rely on it.',
  'Most likely.', 'Signs point to yes.', 'Ask again later.', 'Cannot predict now.',
  'Better not tell you now.', 'Concentrate and ask again.', "Don't count on it.",
  'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.',
];
const FLAME_LINES = [
  '{target} is so slow, their WiFi has a WiFi. 🔥',
  "{target} brought a spoon to a gunfight and still missed. 🔥",
  '{target} has never won an argument in their life. 🔥',
  "{target}'s comebacks are still loading... 🔥",
  '{target} called, they said the roast was free. 🔥',
];

function attachSocket(io, sessionMiddleware) {
  // Share express-session with socket.io
  io.engine.use(sessionMiddleware);

  // Always read xp/level and role flags fresh from the DB rather than trusting
  // the socket's cached session user — that cache is only as fresh as the last
  // login/me call, and roles/levels can change while a socket stays connected.
  function currentLevel(userId) {
    const row = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
    return row ? levelFromXp(row.xp || 0).level : 1;
  }

  function freshRoleFlags(userId) {
    const row = db.prepare(`
      SELECT is_staff, is_global_admin, is_mentor, is_merchant, is_exec_board, is_country_rep, is_elite, username_color
      FROM users WHERE id = ?
    `).get(userId);
    return row
      ? {
          is_staff: !!row.is_staff, is_global_admin: !!row.is_global_admin, is_mentor: !!row.is_mentor, is_merchant: !!row.is_merchant,
          is_exec_board: !!row.is_exec_board, is_country_rep: !!row.is_country_rep, is_elite: !!row.is_elite,
          username_color: row.username_color || null,
        }
      : { is_staff: false, is_global_admin: false, is_mentor: false, is_merchant: false, is_exec_board: false, is_country_rep: false, is_elite: false, username_color: null };
  }

  // Small inline badge shown after a bracketed level in system/gift text,
  // mirroring the role-icon-next-to-name look from the reference screenshots.
  // Priority when an account holds more than one role: Staff outranks
  // Executive Board, Global Admin, Country Rep, Elite, Mentor, and Merchant
  // (matches roleClass()/roleIcon() in app.js).
  function roleBadge(flags) {
    if (flags.is_staff) return ' 👑';
    if (flags.is_exec_board) return ' 🎖️';
    if (flags.is_global_admin) return ' 🛡️';
    if (flags.is_country_rep) return ' 🌐';
    if (flags.is_elite) return ' 🏅';
    if (flags.is_mentor) return ' 🧭';
    if (flags.is_merchant) return ' 💼';
    return '';
  }

  function roomName(roomId) {
    const row = db.prepare('SELECT name FROM rooms WHERE id = ?').get(roomId);
    return row ? row.name : 'Room';
  }

  // ---- Persistent room membership (survives refresh/disconnect) ----
  // Marks a user as an active member of a room. Returns { isNew: true } only
  // when they weren't already an active member — that's the signal for
  // whether to post a "has joined" message (a reconnect/refresh/re-focus on
  // a room you're already in should NOT re-announce you).
  function ensureMembership(userId, roomId) {
    const existing = db.prepare('SELECT active FROM room_memberships WHERE user_id = ? AND room_id = ?').get(userId, roomId);
    const wasActive = !!(existing && existing.active);
    db.prepare(`
      INSERT INTO room_memberships (user_id, room_id, active, joined_at, last_activity_at)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, room_id) DO UPDATE SET active = 1, last_activity_at = datetime('now')
    `).run(userId, roomId);
    return { isNew: !wasActive };
  }

  // Any action a member takes in a room (chat, gift, pick, ...)
  // resets their 5-hour idle clock. No-op if they aren't an active member.
  function touchActivity(userId, roomId) {
    db.prepare(`UPDATE room_memberships SET last_activity_at = datetime('now') WHERE user_id = ? AND room_id = ? AND active = 1`)
      .run(userId, roomId);
  }

  // Explicit removal — a manual "Leave Room", a kick, a bump, or the idle
  // sweep. Also stamps history_cleared_at, so if/when this user comes back
  // to this room their chat view starts fresh instead of replaying
  // everything posted while they were gone (GET /rooms/:id/messages reads
  // this). Returns true only if they were actually an active member.
  function leaveMembership(userId, roomId) {
    const info = db.prepare(`
      UPDATE room_memberships SET active = 0, history_cleared_at = datetime('now')
      WHERE user_id = ? AND room_id = ? AND active = 1
    `).run(userId, roomId);
    return info.changes > 0;
  }

  // Whether this user is a currently-active member of this room, straight
  // from the persistent membership table — used to gate chat so a bumped or
  // kicked user can't keep posting just because their socket is still
  // sitting focused on the room (e.g. a stale tab, or a "kicked" event that
  // hadn't reached their client yet).
  function isActiveMember(userId, roomId) {
    const row = db.prepare('SELECT active FROM room_memberships WHERE user_id = ? AND room_id = ?').get(userId, roomId);
    return !!(row && row.active);
  }

  // Stamps the moment this user genuinely (re-)entered this room — see the
  // last_entered_at column comment in db.js. Only called for a real entry
  // (brand new join, rejoin after leaving, or coming back after being fully
  // away), never for a plain refresh or a tab switch to a room already
  // active — those must keep showing exactly what was on screen before.
  function markEntered(userId, roomId) {
    db.prepare('UPDATE room_memberships SET last_entered_at = datetime(\'now\') WHERE user_id = ? AND room_id = ?').run(userId, roomId);
  }

  // Everything posted in this room since the user's last genuine entry — a
  // fresh entry means last_entered_at was just stamped to "now" (see
  // markEntered above), so this correctly returns nothing for it; a
  // mid-session refresh/reconnect leaves last_entered_at untouched, so this
  // returns exactly what would still be on screen if the page hadn't reloaded.
  function historySinceEntry(userId, roomId) {
    const membership = db.prepare('SELECT last_entered_at FROM room_memberships WHERE user_id = ? AND room_id = ?').get(userId, roomId);
    if (!membership || !membership.last_entered_at) return [];
    const rows = db.prepare(`
      SELECT m.id, m.user_id, m.username, m.content, m.type, m.created_at,
             COALESCE(u.is_staff, 0) AS is_staff, COALESCE(u.is_global_admin, 0) AS is_global_admin,
             COALESCE(u.is_mentor, 0) AS is_mentor, COALESCE(u.is_merchant, 0) AS is_merchant,
             COALESCE(u.is_exec_board, 0) AS is_exec_board, COALESCE(u.is_country_rep, 0) AS is_country_rep,
             COALESCE(u.is_elite, 0) AS is_elite, u.username_color
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ? AND m.created_at > ?
      ORDER BY m.id ASC LIMIT 300
    `).all(roomId, membership.last_entered_at);
    const moderatorIds = new Set(getRoomModerators(roomId).map((m) => m.id));
    return rows.map((r) => ({
      ...r,
      is_staff: !!r.is_staff, is_global_admin: !!r.is_global_admin, is_mentor: !!r.is_mentor,
      is_merchant: !!r.is_merchant, is_exec_board: !!r.is_exec_board, is_country_rep: !!r.is_country_rep,
      is_elite: !!r.is_elite, is_moderator: r.user_id != null && moderatorIds.has(r.user_id), username_color: r.username_color || null,
    }));
  }

  // A room can have any number of moderators (room_moderators table) — see
  // /mod, /unmod below. Checked fresh against the DB every time, same as
  // every other permission check in this file.
  function isRoomModerator(userId, roomId) {
    if (userId == null) return false;
    return !!db.prepare('SELECT 1 FROM room_moderators WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  }

  // Voice notes and picture sharing are reserved for trusted roles — Staff,
  // Global Admin, a room's own owner and moderators, plus the platform-wide
  // Mentor/Merchant flags — everyone else can only send plain text (and the
  // existing gift/voucher commands). Checked both here (server-side, the
  // real gate) and client-side (public/app.js hides the icons), same tier
  // Room Settings already uses for "who can manage this room".
  function canSendMedia(userId, roomId) {
    const flags = freshRoleFlags(userId);
    if (flags.is_staff || flags.is_global_admin || flags.is_mentor || flags.is_merchant) return true;
    const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId);
    if (room && room.created_by === userId) return true;
    return isRoomModerator(userId, roomId);
  }

  function getRoomModerators(roomId) {
    return db.prepare(`
      SELECT u.id, u.username FROM room_moderators rm JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ? ORDER BY u.username COLLATE NOCASE
    `).all(roomId);
  }

  // Who's allowed to talk through a room silence: Staff and Global Admin
  // (whoever imposed it, or any other Staff/Global Admin), the room's owner
  // (created_by), and any of the room's moderators — everyone else is a
  // "normal user" for silence purposes and is fully blocked from typing.
  function canBypassSilence(userId, roomId) {
    const flags = freshRoleFlags(userId);
    if (flags.is_staff || flags.is_global_admin) return true;
    const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId);
    if (room && room.created_by === userId) return true;
    return isRoomModerator(userId, roomId);
  }

  // Puts (or re-puts) a room under silence for `seconds`, auto-lifting it on
  // its own when the timer runs out — same as if someone had typed
  // /unsilence, just without an actor to credit. Re-silencing an
  // already-silenced room simply resets the clock (see roomSilence.setSilence).
  function silenceRoomFor(roomId, seconds, byUsername) {
    const until = Date.now() + seconds * 1000;
    const timer = setTimeout(() => unsilenceRoomFor(roomId, null), seconds * 1000);
    timer.unref?.();
    roomSilence.setSilence(roomId, { until, by: byUsername, timer });
    io.to(`room:${roomId}`).emit('room_silenced', { roomId, until, by: byUsername, seconds });
    io.to(`room:${roomId}`).emit('system_message', `🔇 ${roomName(roomId)} has been silenced by ${byUsername} for ${seconds}s — only Staff, Global Admin, the room owner, and its moderators can talk until it lifts.`);
  }

  function unsilenceRoomFor(roomId, byUsername) {
    roomSilence.clearSilence(roomId);
    io.to(`room:${roomId}`).emit('room_unsilenced', { roomId });
    io.to(`room:${roomId}`).emit('system_message', byUsername
      ? `🔊 ${roomName(roomId)}'s silence was lifted by ${byUsername}.`
      : `🔊 ${roomName(roomId)}'s silence has expired — chat is open again.`);
  }

  // ---- Rejoin cooldowns (kick = 10 minutes, bump = 5 minutes) ----
  // Blocks one user from rejoining one specific room for a while. Checked in
  // join_room before membership is (re-)established; harmless once expired.
  function blockFromRoom(userId, roomId, minutes, reason) {
    db.prepare(`
      INSERT INTO room_blocks (user_id, room_id, reason, blocked_until)
      VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))
      ON CONFLICT(user_id, room_id) DO UPDATE SET reason = excluded.reason, blocked_until = excluded.blocked_until
    `).run(userId, roomId, reason, minutes);
  }

  // Returns { blocked: false } or { blocked: true, reason, secondsLeft }.
  function checkRoomBlock(userId, roomId) {
    const row = db.prepare('SELECT reason, blocked_until FROM room_blocks WHERE user_id = ? AND room_id = ?').get(userId, roomId);
    if (!row) return { blocked: false };
    const secondsLeft = db.prepare("SELECT CAST((julianday(?) - julianday(datetime('now'))) * 86400 AS INTEGER) AS s").get(row.blocked_until).s;
    if (secondsLeft <= 0) return { blocked: false };
    return { blocked: true, reason: row.reason, secondsLeft };
  }

  function activeMemberRows(roomId) {
    return db.prepare(`
      SELECT rm.user_id AS id, rm.ghost_mode, u.username, u.xp, u.is_staff, u.is_global_admin, u.is_mentor, u.is_merchant,
             u.is_exec_board, u.is_country_rep, u.is_elite, u.username_color
      FROM room_memberships rm JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ? AND rm.active = 1
    `).all(roomId);
  }

  // Staff/Global Admin can go "invisible" (see toggle_invisible below) — this
  // tracks it per user (not per socket) since membership is now decoupled
  // from any one connection, and resets once their last socket disconnects.
  const invisibleByUser = new Map();

  // Award xp to a user, persist it, and push the new xp/level to every socket
  // that user currently has open (they may be connected from more than one tab).
  // (Shared with the Admin Panel's "set level" control in src/xp.js.)
  function awardXp(userId, amount) {
    return xpStore.awardXp(io, userId, amount);
  }

  // Persist a "X sent you a gift!" notification (shown in the Notifications
  // list, not just the live room chat/toast) for whoever receives a gift,
  // whether from a direct send or a room-wide shower.
  function notifyGiftReceived(recipientId, senderUsername, gift, roomId) {
    db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
      recipientId, 'gift', `${senderUsername} sent you a gift!`,
      `${senderUsername} sent you a ${gift.name} ${gift.emoji} in ${roomName(roomId)}!`
    );
  }

  function postMessage(roomId, { userId, username, type, content }) {
    const info = db.prepare('INSERT INTO messages (room_id, user_id, username, type, content) VALUES (?, ?, ?, ?, ?)')
      .run(roomId, userId, username, type, content);
    io.to(`room:${roomId}`).emit('chat_message', {
      id: info.lastInsertRowid, username, content, type, created_at: new Date().toISOString(),
      ...freshRoleFlags(userId),
      is_moderator: isRoomModerator(userId, roomId),
    });
  }

  // Broadcast the persistent member list of a room (from room_memberships,
  // NOT from who's currently connected) — a refresh, a brief disconnect, or
  // switching focus to another room does not drop anyone from this list.
  // Also updates the shared presence module so REST endpoints (room browser,
  // home screen) can show "X/Y in room" counts without touching socket internals.
  //
  // Staff / Global Administrators can go "invisible" in a room (see the
  // toggle_invisible event below) — an invisible member is left out of the
  // list sent to everyone else, but still appears (tagged `invisible: true`)
  // in the copy sent back to their own socket, so their own participants
  // panel confirms the stealth is active.
  function broadcastRoomMembers(roomId) {
    const rows = activeMemberRows(roomId);
    const moderatorIds = new Set(getRoomModerators(roomId).map((m) => m.id));
    const members = rows.map((r) => ({
      id: r.id,
      username: r.username,
      level: levelFromXp(r.xp || 0).level,
      is_staff: !!r.is_staff,
      is_global_admin: !!r.is_global_admin,
      is_mentor: !!r.is_mentor,
      is_merchant: !!r.is_merchant,
      is_exec_board: !!r.is_exec_board,
      is_country_rep: !!r.is_country_rep,
      is_elite: !!r.is_elite,
      is_moderator: moderatorIds.has(r.id),
      username_color: r.username_color || null,
      invisible: !!invisibleByUser.get(r.id) || !!r.ghost_mode,
      ghost_mode: !!r.ghost_mode,
      online: presence.isOnline(r.id),
    }));
    presence.setRoomCount(roomId, members.length);

    for (const [, s] of io.sockets.sockets) {
      if (s.data.roomId === roomId && s.data.user) {
        const visibleToThisSocket = members.filter((m) => !m.invisible || m.id === s.data.user.id);
        s.emit('room_members', visibleToThisSocket);
      }
    }
  }

  function activeRoomIds() {
    const ids = new Set();
    for (const [, s] of io.sockets.sockets) {
      if (s.data.roomId && s.data.user) ids.add(s.data.roomId);
    }
    return Array.from(ids);
  }

  // Periodic voucher drops in whatever rooms currently have people in them —
  // every 30 minutes (was 5).
  voucher.startAutoSpawn({
    getActiveRoomIds: activeRoomIds,
    intervalMs: 30 * 60_000,
    onSpawn: (roomId, v) => {
      const text = `Hurray! A small gift for you. You have 40 seconds to pick the voucher [code] ${v.code}. Type /pick ${v.code} to get the voucher. (Amount ${v.amount} Coins).`;
      postMessage(roomId, { userId: null, username: roomName(roomId), type: 'voucher', content: text });
    },
    onExpire: (roomId) => {
      postMessage(roomId, { userId: null, username: roomName(roomId), type: 'system', content: 'The voucher has expired. Better luck next time!' });
    },
  });

  // Ambient chatter from the is_bot-flagged member pool — see chatbots.js.
  // Keeps every room feeling lived-in with casual, room-appropriate small
  // talk even when no real person currently has it open.
  chatbots.startAutoChat({ postMessage });

  // Sweep for members who've gone quiet for 5 hours straight and remove
  // them — the only other way (besides a manual leave or a kick) that
  // someone drops off a room's participant list. Checked periodically
  // rather than per-second since 5 hours is a long window.
  function sweepIdleMembers() {
    const idleHours = ROOM_IDLE_TIMEOUT_MS / 3_600_000;
    const stale = db.prepare(`
      SELECT rm.user_id, rm.room_id, u.username FROM room_memberships rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.active = 1 AND rm.last_activity_at < datetime('now', '-' || ? || ' hours')
    `).all(idleHours);

    for (const { user_id, room_id, username } of stale) {
      if (!leaveMembership(user_id, room_id)) continue;

      for (const [, s] of io.sockets.sockets) {
        if (s.data.user && s.data.user.id === user_id && s.data.roomId === room_id) {
          s.leave(`room:${room_id}`);
          s.data.roomId = null;
          s.emit('kicked', { roomId: room_id, reason: 'timeout' });
        }
      }

      const name = roomName(room_id);
      io.to(`room:${room_id}`).emit('system_message', `${name}: ${username} left (inactive for 5 hours)`);
      broadcastRoomMembers(room_id);
    }
  }
  const idleSweepTimer = setInterval(sweepIdleMembers, 15 * 60_000); // check every 15 minutes
  idleSweepTimer.unref?.();

  // Ambient room presence: on top of the ambient chatter in chatbots.js, the
  // is_bot pool now also drifts in and out of rooms entirely on its own —
  // the exact same "has entered"/"has left" system messages, member-count
  // and Participants-panel updates, and online dot a real person joining or
  // leaving would produce — so a room looks like people are actually coming
  // and going, not a static seeded list that only ever talks. Never touches
  // a real (non-bot) account, and never fights an idle-timeout/kick/bump —
  // it only ever picks among a bot's own currently-active/inactive rooms.
  const BOT_ROOM_ACTIVITY_MIN_GAP_MS = 8_000;
  const BOT_ROOM_ACTIVITY_MAX_GAP_MS = 25_000;

  function simulateOneBotRoomMove() {
    const bots = db.prepare('SELECT id, username FROM users WHERE is_bot = 1').all();
    if (!bots.length) return;
    const bot = bots[Math.floor(Math.random() * bots.length)];

    const rooms = db.prepare('SELECT id, name FROM rooms').all();
    if (!rooms.length) return;

    const activeRoomIds = db.prepare('SELECT room_id FROM room_memberships WHERE user_id = ? AND active = 1')
      .all(bot.id).map((r) => r.room_id);

    // A bot with nothing open always joins somewhere (rooms must never slowly
    // drain to empty); one already in every room can only leave; otherwise
    // it's a coin flip, leaning slightly toward joining for the same reason.
    const canLeave = activeRoomIds.length > 0;
    const canJoin = activeRoomIds.length < rooms.length;
    const action = !canLeave ? 'join' : !canJoin ? 'leave' : (Math.random() < 0.55 ? 'join' : 'leave');

    const level = currentLevel(bot.id);
    const badge = roleBadge(freshRoleFlags(bot.id));

    if (action === 'leave') {
      const roomId = activeRoomIds[Math.floor(Math.random() * activeRoomIds.length)];
      if (!leaveMembership(bot.id, roomId)) return;
      io.to(`room:${roomId}`).emit('system_message', `${roomName(roomId)}: ${bot.username} [${level}]${badge} has left`);
      broadcastRoomMembers(roomId);
      const stillSomewhere = db.prepare('SELECT 1 FROM room_memberships WHERE user_id = ? AND active = 1').get(bot.id);
      if (!stillSomewhere) presence.markOffline(bot.id);
    } else {
      const candidates = rooms.filter((r) => !activeRoomIds.includes(r.id));
      if (!candidates.length) return;
      const room = candidates[Math.floor(Math.random() * candidates.length)];
      ensureMembership(bot.id, room.id);
      markEntered(bot.id, room.id);
      presence.markOnline(bot.id);
      io.to(`room:${room.id}`).emit('system_message', `${room.name}: ${bot.username} [${level}]${badge} has entered`);
      broadcastRoomMembers(room.id);
    }
  }

  function startBotRoomActivity() {
    function tick() {
      try { simulateOneBotRoomMove(); } catch (e) { /* never let a bad tick kill the loop */ }
      const next = BOT_ROOM_ACTIVITY_MIN_GAP_MS + Math.random() * (BOT_ROOM_ACTIVITY_MAX_GAP_MS - BOT_ROOM_ACTIVITY_MIN_GAP_MS);
      const t = setTimeout(tick, next);
      t.unref?.();
    }
    const t = setTimeout(tick, 10_000);
    t.unref?.();
  }
  startBotRoomActivity();

  // Ambient bot gift showers: on top of chatting and drifting between rooms,
  // the bot pool now occasionally showers a room it's actually in with a
  // gift too — the same visible gift-shower message + animation a real
  // /gift all would produce, paid for out of the sending bot's own coin
  // balance. Keeps this simulation-only (no live socket): it can't reuse
  // the per-connection triggerGiftShower closure below, so it re-implements
  // the same economy directly against room_memberships/gifts_catalog.
  // Cheap gifts only, so one shower never drains a bot dry; a periodic
  // top-up (further down) refills any bot that does run low anyway.
  const BOT_GIFT_SHOWER_MIN_GAP_MS = 8_000;
  const BOT_GIFT_SHOWER_MAX_GAP_MS = 20_000;
  const BOT_GIFT_SHOWER_MAX_COST = 100;
  const BOT_GIFT_SHOWER_MAX_RECIPIENTS = 8;

  function simulateOneBotGiftShower() {
    const rooms = db.prepare('SELECT id, name FROM rooms').all();
    if (!rooms.length) return;
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    if (roomSilence.isSilenced(room.id)) return;

    const members = db.prepare(`
      SELECT u.id, u.username, u.coins FROM room_memberships rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ? AND rm.active = 1 AND u.is_bot = 1
    `).all(room.id);
    if (members.length < 2) return;

    const sender = members[Math.floor(Math.random() * members.length)];
    // Cap recipients to a handful rather than literally every bot in the
    // room — a big official room can have 100+ bot members, and showering
    // every single one would routinely blow past a bot's coin balance and
    // silently no-op. A capped, shuffled subset keeps showers affordable
    // (and thus actually happening) no matter how crowded the room is.
    const shuffled = members.filter((m) => m.id !== sender.id).sort(() => Math.random() - 0.5);
    const recipients = shuffled.slice(0, BOT_GIFT_SHOWER_MAX_RECIPIENTS);
    const gifts = db.prepare('SELECT * FROM gifts_catalog WHERE cost <= ?').all(BOT_GIFT_SHOWER_MAX_COST);
    if (!gifts.length) return;
    const gift = gifts[Math.floor(Math.random() * gifts.length)];

    const totalCost = gift.cost * recipients.length;
    if (sender.coins < totalCost) return; // topped up periodically below — just skip this tick

    db.prepare('UPDATE users SET coins = coins - ?, total_spent = total_spent + ?, gifts_sent_count = gifts_sent_count + ? WHERE id = ?')
      .run(totalCost, totalCost, recipients.length, sender.id);
    for (const r of recipients) {
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(gift.cost, r.id);
      awardXp(r.id, XP_REWARDS.GIFT_RECEIVED);
    }

    const level = currentLevel(sender.id);
    const names = recipients.map((r) => r.username);
    const shown = names.slice(0, 4).join(', ');
    const rest = names.length > 4 ? ` and ${names.length - 4} others` : '';
    const text = `<<🎁*GIFT SHOWER* ${sender.username} [${level}] gives a ${gift.name} ${gift.emoji} to ${shown}${rest}! Hurray!>>`;
    postMessage(room.id, { userId: sender.id, username: sender.username, type: 'gift', content: text });
    io.to(`room:${room.id}`).emit('gift_shower', { username: sender.username, level, giftName: gift.name, emojis: Array.from({ length: 12 }, () => gift.emoji) });
    awardXp(sender.id, XP_REWARDS.GIFT_SHOWER);
  }

  function startBotGiftShowers() {
    function tick() {
      try { simulateOneBotGiftShower(); } catch (e) { /* never let a bad tick kill the loop */ }
      const next = BOT_GIFT_SHOWER_MIN_GAP_MS + Math.random() * (BOT_GIFT_SHOWER_MAX_GAP_MS - BOT_GIFT_SHOWER_MIN_GAP_MS);
      const t = setTimeout(tick, next);
      t.unref?.();
    }
    const t = setTimeout(tick, 30_000);
    t.unref?.();
  }
  startBotGiftShowers();

  // Keeps every bot able to keep gifting indefinitely — tops any bot back up
  // to 5000 coins once it's run low, so the ambient gift showers above never
  // just stop happening because the pool quietly went broke.
  const botTopUpTimer = setInterval(() => {
    db.prepare('UPDATE users SET coins = 5000 WHERE is_bot = 1 AND coins < 1000').run();
  }, 20 * 60_000);
  botTopUpTimer.unref?.();

  // ---------------------------------------------------------------------
  // Legendary Bot — a dice-betting minigame confined to the dedicated
  // "Legendary Bot Official" room (seeded in db.js). Players bet coins on
  // one of six animals; each round Legendary Bot rolls 6 dice (each lands
  // on one of the six animals) and pays out based on how many of the 6
  // matched the animal a player bet on. Entirely server-authoritative —
  // coins are deducted the instant a bet is placed (so nobody can bet more
  // than they have across several quick clicks) and the round timer runs
  // independent of any one player's connection, same pattern as the ambient
  // bot gift showers above.
  const LEGENDARY_ANIMALS = [
    { key: 'lion', label: 'Lion', emoji: '🦁' },
    { key: 'tiger', label: 'Tiger', emoji: '🐯' },
    { key: 'fox', label: 'Fox', emoji: '🦊' },
    { key: 'wolf', label: 'Wolf', emoji: '🐺' },
    { key: 'bear', label: 'Bear', emoji: '🐻' },
    { key: 'panda', label: 'Panda', emoji: '🐼' },
  ];
  const LEGENDARY_ANIMAL_BY_KEY = new Map(LEGENDARY_ANIMALS.map((a) => [a.key, a]));
  const LEGENDARY_BET_AMOUNTS = [500, 1000, 2000, 5000, 10000, 15000, 20000];
  // Indexed by how many of the 6 dice matched the animal bet on — 0 matches
  // forfeits the bet entirely; a full sweep (6 of 6) is the jackpot.
  const LEGENDARY_PAYOUT_TABLE = [0, 1, 2, 3, 4.5, 8, 15];
  const LEGENDARY_BETTING_MS = 45_000;
  const LEGENDARY_RESULT_PAUSE_MS = 2_500; // "calculating..." / "rolling dice..." beats
  const LEGENDARY_NEXT_ROUND_DELAY_MS = 20_000; // auto-restarts if nobody types !start

  let legendaryRoomId = null;
  let legendaryPhase = 'idle'; // 'idle' | 'betting' | 'resolving'
  let legendaryEndsAt = 0;
  let legendaryBets = new Map(); // userId -> { username, byAnimal: Map<animalKey, amount> }
  let legendaryAnimalTotals = new Map(); // animalKey -> total coins bet across everyone
  let legendaryTimer = null;

  function getLegendaryRoomId() {
    if (legendaryRoomId == null) {
      const row = db.prepare('SELECT id FROM rooms WHERE name = ?').get('Legendary Bot Official');
      legendaryRoomId = row ? row.id : -1;
    }
    return legendaryRoomId;
  }

  function emitToUser(userId, event, payload) {
    for (const [, s] of io.sockets.sockets) {
      if (s.data.user && s.data.user.id === userId) s.emit(event, payload);
    }
  }

  function legendaryBotMessage(text) {
    postMessage(getLegendaryRoomId(), { userId: null, username: 'Legendary Bot', type: 'legendary', content: text });
  }

  function broadcastLegendaryState() {
    const totals = {};
    for (const [k, v] of legendaryAnimalTotals) totals[k] = v;
    io.to(`room:${getLegendaryRoomId()}`).emit('legendary_state', {
      phase: legendaryPhase, endsAt: legendaryEndsAt, animalTotals: totals,
    });
  }

  function startLegendaryBettingRound() {
    const roomId = getLegendaryRoomId();
    if (roomId < 0) return; // room not seeded yet (very old DB mid-migration) — skip quietly
    if (legendaryTimer) clearTimeout(legendaryTimer);
    legendaryPhase = 'betting';
    legendaryBets = new Map();
    legendaryAnimalTotals = new Map(LEGENDARY_ANIMALS.map((a) => [a.key, 0]));
    legendaryEndsAt = Date.now() + LEGENDARY_BETTING_MS;
    legendaryBotMessage(`🎲 Round in progress — ${Math.round(LEGENDARY_BETTING_MS / 1000)}s left to bid!`);
    broadcastLegendaryState();
    legendaryTimer = setTimeout(resolveLegendaryRound, LEGENDARY_BETTING_MS);
    legendaryTimer.unref?.();
  }

  function resolveLegendaryRound() {
    const roomId = getLegendaryRoomId();
    legendaryPhase = 'resolving';
    broadcastLegendaryState();
    legendaryBotMessage('Legendary Bot is calculating result... Please wait!');

    legendaryTimer = setTimeout(() => {
      // Roll 6 dice, each landing on one of the 6 animals.
      const rolls = Array.from({ length: 6 }, () => LEGENDARY_ANIMALS[Math.floor(Math.random() * LEGENDARY_ANIMALS.length)]);
      const matchCounts = new Map(LEGENDARY_ANIMALS.map((a) => [a.key, 0]));
      for (const r of rolls) matchCounts.set(r.key, matchCounts.get(r.key) + 1);

      const diceLine = rolls.map((r) => r.emoji).join(' ');
      const tallyLines = LEGENDARY_ANIMALS
        .filter((a) => matchCounts.get(a.key) > 0)
        .map((a) => `- ${a.emoji} ${a.label}: ${matchCounts.get(a.key)}x`)
        .join('\n');
      legendaryBotMessage(`Rolling Dice...\n${diceLine}\n\n${tallyLines}`);

      // Pay out every bettor based on how many dice matched what they bet on.
      let anyWinner = false;
      for (const [userId, entry] of legendaryBets) {
        for (const [animalKey, amount] of entry.byAnimal) {
          const matches = matchCounts.get(animalKey) || 0;
          const multiplier = LEGENDARY_PAYOUT_TABLE[matches] || 0;
          if (multiplier <= 0) continue;
          const winnings = Math.round(amount * multiplier);
          db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(winnings, userId);
          emitToUser(userId, 'coins_update', { coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(userId).coins });
          const animal = LEGENDARY_ANIMAL_BY_KEY.get(animalKey);
          legendaryBotMessage(`- ${entry.username} has won ${winnings} coins for placing ${amount} coins on ${animal.label} ${animal.emoji}`);
          anyWinner = true;
        }
      }
      if (!anyWinner && legendaryBets.size > 0) {
        legendaryBotMessage('No winners this round — better luck next time!');
      }
      legendaryBotMessage('Game over. Type !start to start a new round.');

      legendaryPhase = 'idle';
      legendaryBets = new Map();
      legendaryAnimalTotals = new Map();
      broadcastLegendaryState();

      legendaryTimer = setTimeout(() => {
        if (legendaryPhase === 'idle') startLegendaryBettingRound();
      }, LEGENDARY_NEXT_ROUND_DELAY_MS);
      legendaryTimer.unref?.();
    }, LEGENDARY_RESULT_PAUSE_MS);
    legendaryTimer.unref?.();
  }

  function tryStartLegendaryRound() {
    if (legendaryPhase !== 'idle') return false;
    if (legendaryTimer) clearTimeout(legendaryTimer);
    startLegendaryBettingRound();
    return true;
  }

  function placeLegendaryBet(user, animalKey, amount) {
    const roomId = getLegendaryRoomId();
    if (legendaryPhase !== 'betting') return { ok: false, error: 'Betting is closed right now — wait for the next round.' };
    if (!LEGENDARY_ANIMAL_BY_KEY.has(animalKey)) return { ok: false, error: 'Unknown animal' };
    amount = Number(amount);
    if (!LEGENDARY_BET_AMOUNTS.includes(amount)) return { ok: false, error: 'Invalid bet amount' };
    if (!isActiveMember(user.id, roomId)) return { ok: false, error: 'Join the Legendary Bot Official room first.' };

    // Deduct atomically, checking the balance in the same statement so a
    // burst of quick clicks can never overdraw a player's coins.
    const result = db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?').run(amount, user.id, amount);
    if (result.changes === 0) return { ok: false, error: "You don't have enough coins for that bet." };
    emitToUser(user.id, 'coins_update', { coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(user.id).coins });

    if (!legendaryBets.has(user.id)) legendaryBets.set(user.id, { username: user.username, byAnimal: new Map() });
    const entry = legendaryBets.get(user.id);
    entry.byAnimal.set(animalKey, (entry.byAnimal.get(animalKey) || 0) + amount);
    legendaryAnimalTotals.set(animalKey, (legendaryAnimalTotals.get(animalKey) || 0) + amount);

    const animal = LEGENDARY_ANIMAL_BY_KEY.get(animalKey);
    legendaryBotMessage(`${user.username} placed ${amount} coins on ${animal.label} ${animal.emoji}\nBets: ${animal.label} ${animal.emoji} ${legendaryAnimalTotals.get(animalKey)}`);
    broadcastLegendaryState();
    return { ok: true };
  }

  // Kick off the very first round shortly after boot so the room isn't
  // sitting empty waiting for someone to type !start.
  setTimeout(() => { if (getLegendaryRoomId() >= 0) tryStartLegendaryRound(); }, 15_000).unref?.();

  // ---------- Generic "last player standing" bot games (LowCard, Cricket) ----------
  // Both games share the same shape: "!start" opens a join window ("!j" to
  // join, an entry fee escrowed from each joiner into the pot), then repeated
  // rounds where every remaining player types "!d" once; a game-specific
  // draw() decides whether that player survives the round. Play continues
  // until one player remains, who takes the whole pot. Entirely
  // server-authoritative and confined to each game's own dedicated room
  // (seeded in db.js), same pattern as the Legendary Bot dice game above.
  function createEliminationGame({ roomName, botName, entryFee, joinMs, roundMs, draw, decideSurvivors }) {
    let roomId = null;
    let phase = 'idle'; // 'idle' | 'joining' | 'drawing'
    let round = 0;
    let players = new Map(); // userId -> username
    let draws = new Map(); // userId -> { survives, label }
    let pot = 0;
    let timer = null;

    function getRoomId() {
      if (roomId == null) {
        const row = db.prepare('SELECT id FROM rooms WHERE name = ?').get(roomName);
        roomId = row ? row.id : -1;
      }
      return roomId;
    }
    function botMessage(text) {
      postMessage(getRoomId(), { userId: null, username: botName, type: 'game_bot', content: text });
    }
    function creditCoins(userId, amount) {
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, userId);
      emitToUser(userId, 'coins_update', { coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(userId).coins });
    }
    function refundAllPlayers() {
      for (const userId of players.keys()) creditCoins(userId, entryFee);
    }
    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
    function endGame() {
      clearTimer();
      phase = 'idle'; round = 0; players = new Map(); draws = new Map(); pot = 0;
    }

    function tryStart() {
      const rid = getRoomId();
      if (rid < 0) return false; // room not seeded yet (very old DB mid-migration)
      if (phase !== 'idle') return false;
      clearTimer();
      phase = 'joining'; players = new Map(); draws = new Map(); pot = 0; round = 0;
      botMessage(`🎮 New game started! Type !j to join (Entry: ${entryFee} coins) — ${Math.round(joinMs / 1000)} seconds.`);
      timer = setTimeout(afterJoinWindow, joinMs);
      timer.unref?.();
      return true;
    }

    function join(user) {
      const rid = getRoomId();
      if (phase !== 'joining') return;
      if (players.has(user.id)) return;
      if (!isActiveMember(user.id, rid)) return;
      const result = db.prepare('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?').run(entryFee, user.id, entryFee);
      if (result.changes === 0) {
        emitToUser(user.id, 'error_message', `You need ${entryFee} coins to join.`);
        return;
      }
      emitToUser(user.id, 'coins_update', { coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(user.id).coins });
      pot += entryFee;
      players.set(user.id, user.username);
      botMessage(`${user.username} joined! (${players.size} player${players.size === 1 ? '' : 's'} in, pot: ${pot} coins)`);
    }

    function afterJoinWindow() {
      if (players.size < 2) {
        botMessage(players.size === 0 ? 'No one joined — game cancelled.' : 'Not enough players joined (need at least 2) — game cancelled, entry fees refunded.');
        refundAllPlayers();
        endGame();
        return;
      }
      startRound();
    }

    function startRound() {
      round += 1;
      phase = 'drawing';
      draws = new Map();
      botMessage(`Round #${round}. Players !d to draw [${Math.round(roundMs / 1000)} seconds]`);
      timer = setTimeout(resolveRound, roundMs);
      timer.unref?.();
    }

    function takeDraw(user) {
      const rid = getRoomId();
      if (phase !== 'drawing') return;
      if (!players.has(user.id)) return;
      if (draws.has(user.id)) return;
      if (!isActiveMember(user.id, rid)) return;
      const result = draw(user.username);
      draws.set(user.id, result);
      botMessage(result.label);
    }

    // Default: a draw survives on its own merit (result.survives) — right
    // for Cricket (each ball is independently "out" or not). LowCard passes
    // its own decideSurvivors that compares every draw against the round's
    // lowest card instead.
    function defaultDecideSurvivors() {
      const survivorIds = new Set();
      for (const [userId] of players) {
        const d = draws.get(userId);
        if (d && d.survives) survivorIds.add(userId);
      }
      return survivorIds;
    }

    function resolveRound() {
      if (draws.size === 0) {
        botMessage('No one drew this round — trying again!');
        return startRound();
      }
      const survivorIds = (decideSurvivors || defaultDecideSurvivors)(players, draws);
      const eliminatedNames = [...players.entries()].filter(([uid]) => !survivorIds.has(uid)).map(([, name]) => name);
      if (eliminatedNames.length) botMessage(`Eliminated this round: ${eliminatedNames.join(', ')}`);

      const survivors = new Map([...players].filter(([uid]) => survivorIds.has(uid)));

      if (survivors.size === 0) {
        // Everyone still in was eliminated together (a full tie/sweep) — split the pot evenly rather than losing it.
        const names = [...players.values()];
        const share = Math.floor(pot / players.size);
        for (const userId of players.keys()) creditCoins(userId, share);
        botMessage(`Everyone was eliminated at once — the pot (${pot} coins) is split evenly between ${names.join(', ')} (${share} each)!`);
        endGame();
        return;
      }
      if (survivors.size === 1) {
        const [[winnerId, winnerName]] = survivors;
        creditCoins(winnerId, pot);
        botMessage(`🏆 ${winnerName} wins the pot of ${pot} coins! Type !start to play again.`);
        endGame();
        return;
      }
      players = survivors;
      timer = setTimeout(startRound, 2_000);
      timer.unref?.();
    }

    // Kick off the very first round shortly after boot, same as Legendary Bot.
    setTimeout(() => { if (getRoomId() >= 0) tryStart(); }, 15_000).unref?.();

    return { getRoomId, tryStart, join, takeDraw };
  }

  // LowCard — draw a card each round; whoever drew the lowest card (or
  // didn't draw at all) is eliminated. Ties at the lowest value are all
  // eliminated together.
  function drawLowcard(username) {
    const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
    const SUITS = ['♠', '♥', '♦', '♣'];
    const value = 2 + Math.floor(Math.random() * 13); // 2–14
    const rankLabel = RANK_LABELS[value] || String(value);
    const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    return { value, label: `${username}: ${rankLabel}${suit}` };
  }
  function lowcardDecideSurvivors(players, draws) {
    let minVal = Infinity;
    for (const d of draws.values()) if (d.value < minVal) minVal = d.value;
    const survivorIds = new Set();
    for (const [userId] of players) {
      const d = draws.get(userId);
      if (d && d.value > minVal) survivorIds.add(userId);
    }
    return survivorIds;
  }
  const lowcardGame = createEliminationGame({
    roomName: 'Official LowCard Room', botName: 'LowCard Bot', entryFee: 50, joinMs: 20_000, roundMs: 15_000,
    draw: drawLowcard, decideSurvivors: lowcardDecideSurvivors,
  });

  // Cricket — "bat" each round; a ball can score runs (you stay in) or get
  // you OUT (eliminated). Roughly cricket-realistic scoring odds.
  const CRICKET_OUTCOMES = [
    { runs: 0, weight: 3, label: 'Dot ball.' },
    { runs: 1, weight: 4, label: 'takes a single: 1' },
    { runs: 2, weight: 3, label: 'runs a two: 2' },
    { runs: 3, weight: 1, label: 'runs a three: 3' },
    { runs: 4, weight: 3, label: 'hits a boundary: 4 Four!' },
    { runs: 6, weight: 2, label: 'sends it out of the park: 6 Six!' },
    { runs: -1, weight: 2, label: 'is OUT! 🏏' },
  ];
  const CRICKET_WEIGHT_TOTAL = CRICKET_OUTCOMES.reduce((sum, o) => sum + o.weight, 0);
  function drawCricket(username) {
    let roll = Math.random() * CRICKET_WEIGHT_TOTAL;
    let picked = CRICKET_OUTCOMES[CRICKET_OUTCOMES.length - 1];
    for (const o of CRICKET_OUTCOMES) {
      if (roll < o.weight) { picked = o; break; }
      roll -= o.weight;
    }
    const out = picked.runs < 0;
    return { survives: !out, label: `${username} ${picked.label}` };
  }
  const cricketGame = createEliminationGame({
    roomName: 'Official Cricket Room', botName: 'Cricket Bot', entryFee: 50, joinMs: 20_000, roundMs: 15_000,
    draw: drawCricket,
  });

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const user = session && session.user;
    if (!user) {
      socket.emit('error_message', 'Not authenticated');
      socket.disconnect();
      return;
    }

    socket.data.user = user;
    // Was this user already reachable (another open tab/device, or they
    // disconnected only moments ago — a refresh or brief network blip) right
    // before THIS connection? Captured before markOnline() flips it to true,
    // so join_room below can tell "just came back after being away" apart
    // from "just switching tabs" or "page refresh" — see RECONNECT_GRACE_MS.
    const wasReachableBefore = presence.wasOnlineRecently(user.id, RECONNECT_GRACE_MS);
    presence.markOnline(user.id);
    let announcedEntryThisConnection = false;

    // A thrown exception inside a socket event handler (a bad DB write, a
    // race, anything) used to disappear silently — the client would just see
    // nothing happen, with the real cause visible only in the server's own
    // console (if that). Wrap every handler below so a failure is logged
    // server-side AND reported to the user as an error_message instead of
    // vanishing.
    function on(event, handler) {
      socket.on(event, (...args) => {
        try {
          handler(...args);
        } catch (err) {
          console.error(`[socket:${event}] error for ${user.username}:`, err);
          socket.emit('error_message', `Something went wrong running that (${err.message || err}). Please try again.`);
        }
      });
    }

    // `ack`, if the client passed one, lets the client know membership is
    // actually established before it asks the REST API for chat history —
    // GET /rooms/:id/messages requires active membership (see rooms.js), so
    // without this handshake there'd be a race between the socket join and
    // the REST call on a fresh join, and the history fetch could 403.
    on('join_room', (roomId, ack) => {
      roomId = Number(roomId);
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) {
        socket.emit('error_message', 'Room not found');
        if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' });
        return;
      }

      const block = checkRoomBlock(user.id, roomId);
      if (block.blocked) {
        const error = block.reason === 'ban'
          ? `You are banned from ${room.name}`
          : `You were ${block.reason === 'kick' ? 'kicked' : 'bumped'} from ${room.name} — try again in ${Math.ceil(block.secondsLeft / 60)} minute${Math.ceil(block.secondsLeft / 60) === 1 ? '' : 's'}`;
        socket.emit('error_message', error);
        if (typeof ack === 'function') ack({ ok: false, error });
        return;
      }

      // Room Settings' Lock Level — a minimum level required to enter,
      // 0 = open to everyone. Staff, Global Admin, the room's owner, and its
      // moderators always bypass it (same exemption pattern as silence).
      if (room.lock_level > 0) {
        const myLevel = currentLevel(user.id);
        const flags = freshRoleFlags(user.id);
        const exempt = flags.is_staff || flags.is_global_admin || room.created_by === user.id || isRoomModerator(user.id, roomId);
        if (!exempt && myLevel < room.lock_level) {
          const error = `${room.name} requires level ${room.lock_level}+ to enter — you're level ${myLevel}`;
          socket.emit('error_message', error);
          if (typeof ack === 'function') ack({ ok: false, error });
          return;
        }
      }

      // Switch which room this socket receives LIVE messages for. This does
      // NOT touch the user's persistent membership in whatever room they were
      // previously focused on — a refresh, a reconnect, or switching to view
      // another room must never look like "leaving" to everyone else. Only an
      // explicit leave_room, a kick, or 5 hours of inactivity does that.
      for (const r of socket.rooms) {
        if (r !== socket.id) socket.leave(r);
      }
      socket.join(`room:${roomId}`);
      socket.data.roomId = roomId;

      const level = currentLevel(user.id);
      const badge = roleBadge(freshRoleFlags(user.id));

      const { isNew } = ensureMembership(user.id, roomId);

      db.prepare('INSERT INTO room_visits (user_id, room_id, visited_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(user_id, room_id) DO UPDATE SET visited_at = datetime(\'now\')')
        .run(user.id, roomId);

      // Announce when: (a) this is genuinely the first time they've ever
      // become an active member of this room (or they'd explicitly left/been
      // removed and are rejoining), OR (b) they just came back after being
      // fully offline (closed the app/tab, came back later) — even though
      // their persistent membership never lapsed, from everyone else's
      // perspective they were gone and are now visibly back. Only the FIRST
      // join_room call on a given connection gets the "just came back" credit
      // (announcedEntryThisConnection), so switching between room tabs you're
      // already an active member of, or refreshing the page, stays silent.
      const cameBackAfterBeingAway = !wasReachableBefore && !announcedEntryThisConnection;
      const genuineEntry = isNew || cameBackAfterBeingAway;
      if (genuineEntry) {
        io.to(`room:${roomId}`).emit('system_message', `${room.name}: ${user.username} [${level}]${badge} has entered`);
        // A genuine entry (first time ever, rejoining after leaving/being
        // kicked/bumped/timed out, or coming back after being fully away)
        // resets the chat-visibility clock — same moment the room is told
        // "has entered", nothing posted before now is handed back below.
        markEntered(user.id, roomId);
      }
      announcedEntryThisConnection = true;
      broadcastRoomMembers(roomId);

      // Whatever's happened in the room since the last genuine entry — blank
      // for a fresh entry (see markEntered just above), but exactly what was
      // on screen before a plain page refresh or reconnect, so reloading the
      // page never looks like leaving the room.
      const history = historySinceEntry(user.id, roomId);

      const activeVoucher = voucher.getActiveVoucher(roomId);
      if (activeVoucher) {
        const remaining = Math.max(0, Math.round((activeVoucher.expiresAt - Date.now()) / 1000));
        socket.emit('system_message', `A voucher is active in this room! Type /pick <code> within ${remaining}s to try (you'll need the code from chat).`);
      }

      // Let a client joining (or refreshing into) a room mid-silence disable
      // its chat input right away, instead of waiting for a room_silenced
      // broadcast that already happened before they connected.
      const silence = roomSilence.getSilence(roomId);

      if (typeof ack === 'function') ack({ ok: true, history, silencedUntil: silence ? silence.until : null });
    });

    // Explicit "Leave Room" — the ONLY user-triggered way (besides a kick or
    // the 5-hour idle timeout) that removes someone from the participant list.
    on('leave_room', ({ roomId }) => {
      roomId = Number(roomId);
      const wasActive = leaveMembership(user.id, roomId);

      if (socket.data.roomId === roomId) {
        socket.leave(`room:${roomId}`);
        socket.data.roomId = null;
      }

      if (wasActive) {
        const level = currentLevel(user.id);
        const badge = roleBadge(freshRoleFlags(user.id));
        const name = roomName(roomId);
        io.to(`room:${roomId}`).emit('system_message', `${name}: ${user.username} [${level}]${badge} has left`);
        broadcastRoomMembers(roomId);
      }
    });

    on('chat_message', ({ roomId, text }) => {
      roomId = Number(roomId);
      if (!text || !text.trim()) return;

      // A bumped/kicked user must not be able to keep chatting in that room
      // just because their socket is still (or gets re-)focused on it — this
      // is the real, server-side gate, independent of whatever the client
      // shows. Being blocked from rejoining implies not being an active
      // member either, so this also covers the rejoin-cooldown window.
      if (!isActiveMember(user.id, roomId)) {
        return socket.emit('error_message', "You're not currently in this room — open it from Room Browser to rejoin before chatting.");
      }

      // A silenced room blocks EVERYTHING from a normal user — not just plain
      // chat, but every command too (/gift, /pick, and so on) — only Staff,
      // Global Admin, the room's owner, and its moderator can still type at
      // all while it's in effect.
      const silence = roomSilence.getSilence(roomId);
      if (silence && !canBypassSilence(user.id, roomId)) {
        const remaining = Math.max(0, Math.ceil((silence.until - Date.now()) / 1000));
        return socket.emit('error_message', `🔇 This room is silenced — you can't type at this moment (${remaining}s left).`);
      }

      const clean = text.trim().slice(0, 500);
      touchActivity(user.id, roomId);

      // "!start" — anyone in the Legendary Bot Official room can kick off a
      // new betting round once the current one has finished (a no-op while
      // one is already running, same as the reference bot's behavior).
      if (roomId === getLegendaryRoomId() && /^!start$/i.test(clean)) {
        if (!tryStartLegendaryRound()) socket.emit('error_message', 'A round is already in progress.');
        return;
      }

      // LowCard / Cricket — "!start" opens a join window, "!j" joins it
      // (escrowing the entry fee), "!d" draws/bats once the round is live.
      // Each game is confined to its own dedicated room; typing these
      // elsewhere just falls through to a normal chat message below.
      for (const game of [lowcardGame, cricketGame]) {
        if (roomId !== game.getRoomId()) continue;
        if (/^!start$/i.test(clean)) {
          if (!game.tryStart()) socket.emit('error_message', 'A game is already in progress.');
          return;
        }
        if (/^!j$/i.test(clean)) { game.join(user); return; }
        if (/^!d$/i.test(clean)) { game.takeDraw(user); return; }
      }

      // "/silence <seconds>" / "/unsilence" — Staff or Global Admin only.
      const silenceMatch = clean.match(SILENCE_COMMAND);
      if (silenceMatch) {
        return trySilenceRoom(roomId, silenceMatch[1]);
      }
      if (UNSILENCE_COMMAND.test(clean)) {
        return tryUnsilenceRoom(roomId);
      }

      // "/mod <username>" / "/unmod <username>" — the room owner (or Staff/Global Admin);
      // a room can have several moderators, added/removed one at a time.
      const modMatch = clean.match(MOD_COMMAND);
      if (modMatch) {
        return trySetModerator(roomId, modMatch[1]);
      }
      const unmodMatch = clean.match(UNMOD_COMMAND);
      if (unmodMatch) {
        return tryRemoveModerator(roomId, unmodMatch[1]);
      }

      // "/pick <code>" — claim an active room voucher.
      const pickMatch = clean.match(PICK_COMMAND);
      if (pickMatch) {
        return handlePick(roomId, pickMatch[1]);
      }

      // "/kick <username>" / "/bump <username>" — same permission + effect as
      // the Participants panel buttons, just reachable from chat.
      const kickMatch = clean.match(KICK_COMMAND);
      if (kickMatch) {
        return handleRemovalCommand(roomId, kickMatch[1], 'kick');
      }
      const bumpMatch = clean.match(BUMP_COMMAND);
      if (bumpMatch) {
        return handleRemovalCommand(roomId, bumpMatch[1], 'bump');
      }

      // "/ban <username>" / "/unban <username>" — same permission tier and
      // effect as Room Settings' Banned tab, just reachable from chat.
      const banMatch = clean.match(BAN_COMMAND);
      if (banMatch) {
        return handleRemovalCommand(roomId, banMatch[1], 'ban');
      }
      const unbanMatch = clean.match(UNBAN_COMMAND);
      if (unbanMatch) {
        return handleUnbanCommand(roomId, unbanMatch[1]);
      }

      // "/gift all" or "/gift all <gift name>" — shower to everyone currently in the room.
      const allMatch = clean.match(GIFT_ALL_COMMAND);
      if (allMatch) {
        return triggerGiftShower(roomId, allMatch[1] ? allMatch[1].trim() : null);
      }

      // "/gift <username> <gift name>" — targeted gift sent via chat command.
      const toMatch = clean.match(GIFT_TO_COMMAND);
      if (toMatch && toMatch[1].toLowerCase() !== 'all') {
        return handleGiftCommand(roomId, toMatch[1], toMatch[2].trim());
      }

      // Roleplay/emote commands ("/hug", "/dance", ...) and the "Special"
      // tier ("/8ball", "/cupid", ...) — see roleplayCommands.js.
      const rpMatch = clean.match(ROLEPLAY_COMMAND);
      if (rpMatch) {
        const cmd = rpMatch[1].toLowerCase();
        const arg = rpMatch[2] ? rpMatch[2].trim() : '';
        if (SPECIAL_COMMANDS.has(cmd)) {
          return handleSpecialCommand(roomId, cmd, arg);
        }
        if (ROLEPLAY_MAP.has(cmd)) {
          return handleRoleplayCommand(roomId, cmd, arg);
        }
      }

      // A message that starts with "/" but doesn't match any known command
      // used to silently get posted to the room as plain text, which looked
      // exactly like "nothing happened" for a typo'd or unrecognized command.
      // Reject it with a clear error instead, so a mismatch is obvious.
      if (/^\//.test(clean)) {
        console.log(`[chat] unrecognized command from ${user.username} in room ${roomId}: ${JSON.stringify(clean)}`);
        return socket.emit('error_message', `Unrecognized command: "${clean.split(/\s+/)[0]}". Try /kick <username>, /bump <username>, /ban <username>, /unban <username>, /pick <code>, /gift <username> <gift>, /gift all, /silence <seconds>, /unsilence, /mod <username>, /unmod <username>, or an emote like /hug <username> — see the Command List in Explore for the full set.`);
      }

      postMessage(roomId, { userId: user.id, username: user.username, type: 'text', content: clean });
      awardXp(user.id, XP_REWARDS.CHAT_MESSAGE);
    });

    // A shared picture or voice note — gated to trusted roles (see
    // canSendMedia above). `data` arrives as a raw binary buffer (socket.io
    // passes Buffers/ArrayBuffers through natively); `kind` is 'image' or
    // 'voice', `mime` picks the file extension from MEDIA_EXT.
    on('send_media_message', ({ roomId, kind, mime, data }, ack) => {
      roomId = Number(roomId);
      const fail = (error) => { if (typeof ack === 'function') ack({ ok: false, error }); else socket.emit('error_message', error); };

      if (kind !== 'image' && kind !== 'voice') return fail('Unknown media type');
      if (!isActiveMember(user.id, roomId)) return fail("You're not currently in this room — open it from Room Browser to rejoin.");
      const silence = roomSilence.getSilence(roomId);
      if (silence && !canBypassSilence(user.id, roomId)) return fail('🔇 This room is silenced right now.');
      if (!canSendMedia(user.id, roomId)) {
        return fail(kind === 'image' ? 'Only Staff, Admin, this room\'s owner/moderators, Mentor, or Merchant can share pictures here.' : 'Only Staff, Admin, this room\'s owner/moderators, Mentor, or Merchant can send voice notes here.');
      }
      const ext = MEDIA_EXT[kind] && MEDIA_EXT[kind][mime];
      if (!ext) return fail('Unsupported file type');
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!buf.length) return fail('Empty file');
      if (buf.length > MEDIA_MAX_BYTES) return fail(`File too large — max ${Math.floor(MEDIA_MAX_BYTES / 1024 / 1024)}MB`);

      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
      touchActivity(user.id, roomId);
      postMessage(roomId, { userId: user.id, username: user.username, type: kind, content: `/uploads/${filename}` });
      awardXp(user.id, XP_REWARDS.CHAT_MESSAGE);
      if (typeof ack === 'function') ack({ ok: true });
    });

    function handleRemovalCommand(roomId, usernameArg, mode) {
      const target = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(usernameArg);
      if (!target) return socket.emit('error_message', `No user named "${usernameArg}"`);
      performRemoval(roomId, target.id, mode);
    }

    function handleUnbanCommand(roomId, usernameArg) {
      const target = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(usernameArg);
      if (!target) return socket.emit('error_message', `No user named "${usernameArg}"`);
      performUnban(roomId, target.id);
    }

    // "username [level]" — matches the bracket format used everywhere else
    // (join/leave, kick/bump/ban system messages, gift messages).
    function nameWithLevel(userId, username) {
      return `${username} [${currentLevel(userId)}]`;
    }

    // Roleplay/emote commands — posts a canned third-person action line to
    // the room, optionally naming a target. "/act <text>" is the one
    // freeform command (selfTpl has a literal {arg} placeholder).
    function handleRoleplayCommand(roomId, cmd, arg) {
      const entry = ROLEPLAY_MAP.get(cmd);
      const me = nameWithLevel(user.id, user.username);

      if (entry.isFreeform) {
        if (!arg) return socket.emit('error_message', `Usage: /${cmd} <action text>`);
        const text = entry.selfTpl.replace('{user}', me).replace('{arg}', arg.slice(0, 200));
        return postMessage(roomId, { userId: user.id, username: user.username, type: 'text', content: text });
      }

      if (arg && entry.targetTpl) {
        const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(arg);
        if (!target) return socket.emit('error_message', `No user named "${arg}"`);
        const them = target.id === user.id ? me : nameWithLevel(target.id, target.username);
        const text = entry.targetTpl.replace('{user}', me).replace('{target}', them);
        return postMessage(roomId, { userId: user.id, username: user.username, type: 'text', content: text });
      }

      if (!entry.selfTpl) return socket.emit('error_message', `Usage: /${cmd} <username>`);
      const text = entry.selfTpl.replace('{user}', me);
      return postMessage(roomId, { userId: user.id, username: user.username, type: 'text', content: text });
    }

    // "Special" tier commands with real behavior, not just a canned line.
    function handleSpecialCommand(roomId, cmd, arg) {
      const me = nameWithLevel(user.id, user.username);
      const post = (content) => postMessage(roomId, { userId: user.id, username: user.username, type: 'text', content });

      if (cmd === '8ball') {
        if (!arg) return socket.emit('error_message', 'Usage: /8ball <question>');
        const answer = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
        return post(`🎱 ${me} asks the Magic 8-Ball: "${arg}" — ${answer}`);
      }

      if (cmd === 'coffee') {
        return post(`☕ ${me} brews a round of coffee for the room!`);
      }

      if (cmd === 'cupid') {
        const names = arg.split(/\s+/).filter(Boolean);
        if (!names.length) return socket.emit('error_message', 'Usage: /cupid <username> [<username2>]');
        const findUser = (uname) => db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(uname);
        const a = names[0] === user.username ? { id: user.id, username: user.username } : findUser(names[0]);
        if (!a) return socket.emit('error_message', `No user named "${names[0]}"`);
        const b = names[1] ? findUser(names[1]) : { id: user.id, username: user.username };
        if (names[1] && !b) return socket.emit('error_message', `No user named "${names[1]}"`);
        const pct = 40 + Math.floor(Math.random() * 61); // 40–100%
        return post(`💘 Cupid strikes! ${nameWithLevel(a.id, a.username)} + ${nameWithLevel(b.id, b.username)} = ${pct}% match!`);
      }

      if (cmd === 'findmymatch') {
        const room = db.prepare('SELECT is_official FROM rooms WHERE id = ?').get(roomId);
        if (!room || !room.is_official) {
          return socket.emit('error_message', '/findmymatch only works in official rooms.');
        }
        const others = activeMemberRows(roomId).filter((r) => r.id !== user.id && !r.is_bot);
        if (!others.length) return socket.emit('error_message', 'No one else is here to match with right now.');
        const pick = others[Math.floor(Math.random() * others.length)];
        const pct = 40 + Math.floor(Math.random() * 61);
        return post(`💘 ${me} used /findmymatch and got paired with ${nameWithLevel(pick.id, pick.username)} — ${pct}% match!`);
      }

      if (cmd === 'flame') {
        if (!arg) return socket.emit('error_message', 'Usage: /flame <username>');
        const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(arg);
        if (!target) return socket.emit('error_message', `No user named "${arg}"`);
        const line = FLAME_LINES[Math.floor(Math.random() * FLAME_LINES.length)];
        return post(`🔥 ${me} flames ${nameWithLevel(target.id, target.username)}: ${line.replace('{target}', target.username)}`);
      }

      if (cmd === 'whackit') {
        if (!arg) return socket.emit('error_message', 'Usage: /whackit <username>');
        const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(arg);
        if (!target) return socket.emit('error_message', `No user named "${arg}"`);
        return post(`🔨 ${me} whacks ${nameWithLevel(target.id, target.username)} with a giant mallet!`);
      }
    }

    function handlePick(roomId, code) {
      const result = voucher.claim(roomId, code, user.id);
      if (result.error) return socket.emit('error_message', result.error);

      // Deliberately NOT posted to the room chat (no one else needs to see
      // who picked it) — just a private confirmation toast to the picker.
      socket.emit('voucher_won', { amount: result.amount, code: result.code });
      socket.emit('coins_update', { coins: db.prepare('SELECT coins FROM users WHERE id = ?').get(user.id).coins });
      awardXp(user.id, XP_REWARDS.GIFT_RECEIVED);
    }

    function triggerGiftShower(roomId, giftNameArg) {
      const gifts = db.prepare('SELECT * FROM gifts_catalog').all();
      if (gifts.length === 0) return;

      let specific = null;
      if (giftNameArg) {
        specific = gifts.find((g) => g.name.toLowerCase() === giftNameArg.toLowerCase());
        if (!specific) return socket.emit('error_message', `No gift named "${giftNameArg}"`);
      }
      const gift = specific || gifts[Math.floor(Math.random() * gifts.length)];
      const level = currentLevel(user.id);

      // Recipients = everyone else currently in the room. If solo, it's a free
      // celebratory effect only (nobody to actually gift).
      const recipients = [];
      const seen = new Set([user.id]);
      for (const [, s] of io.sockets.sockets) {
        if (s.data.roomId === roomId && s.data.user && !seen.has(s.data.user.id)) {
          seen.add(s.data.user.id);
          recipients.push(s.data.user);
        }
      }

      if (recipients.length === 0) {
        const text = `${user.username} [${level}] triggered a ${gift.name} ${gift.emoji} GIFT SHOWER! 🎉🎁✨`;
        postMessage(roomId, { userId: user.id, username: user.username, type: 'gift', content: text });
        io.to(`room:${roomId}`).emit('gift_shower', { username: user.username, level, giftName: gift.name, emojis: Array.from({ length: 12 }, () => gift.emoji) });
        awardXp(user.id, XP_REWARDS.GIFT_SHOWER);
        return;
      }

      const totalCost = gift.cost * recipients.length;
      const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (sender.coins < totalCost) {
        return socket.emit('error_message', `Not enough coins — a shower of ${gift.name} to ${recipients.length} people costs ${totalCost} coins`);
      }

      db.prepare('UPDATE users SET coins = coins - ?, total_spent = total_spent + ?, gifts_sent_count = gifts_sent_count + ? WHERE id = ?')
        .run(totalCost, totalCost, recipients.length, sender.id);
      for (const r of recipients) {
        db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(gift.cost, r.id);
        awardXp(r.id, XP_REWARDS.GIFT_RECEIVED);
        // Gift showers deliberately don't create a persisted Alert (unlike a
        // direct/private gift) — a shower already announces itself loudly in
        // the room chat + the on-screen shower animation, and with several
        // recipients per shower it would otherwise flood everyone's Alerts
        // list. Alerts are reserved for private gifts (room gift bar, /gift
        // <user> <gift>, and the Gift Store).
      }

      const names = recipients.map((r) => r.username);
      const shown = names.slice(0, 4).join(', ');
      const rest = names.length > 4 ? ` and ${names.length - 4} others` : '';
      const text = `<<🎁*GIFT SHOWER* ${user.username} [${level}] gives a ${gift.name} ${gift.emoji} to ${shown}${rest}! Hurray!>>`;

      postMessage(roomId, { userId: user.id, username: user.username, type: 'gift', content: text });
      io.to(`room:${roomId}`).emit('gift_shower', { username: user.username, level, giftName: gift.name, emojis: Array.from({ length: 12 }, () => gift.emoji) });
      socket.emit('coins_update', { coins: sender.coins - totalCost });
      awardXp(sender.id, XP_REWARDS.GIFT_SHOWER);
    }

    function handleGiftCommand(roomId, usernameArg, giftNameArg) {
      const recipient = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(usernameArg);
      if (!recipient) return socket.emit('error_message', `No user named "${usernameArg}"`);
      if (recipient.id === user.id) return socket.emit('error_message', "You can't send a gift to yourself");

      const gift = db.prepare('SELECT * FROM gifts_catalog WHERE name = ? COLLATE NOCASE').get(giftNameArg);
      if (!gift) return socket.emit('error_message', `No gift named "${giftNameArg}"`);

      const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      sendGift(roomId, sender, recipient, gift);
    }

    on('send_gift', ({ roomId, toUserId, giftId }) => {
      roomId = Number(roomId);
      if (!isActiveMember(user.id, roomId)) {
        return socket.emit('error_message', "You're not currently in this room — open it from Room Browser to rejoin before sending gifts.");
      }
      const gift = db.prepare('SELECT * FROM gifts_catalog WHERE id = ?').get(giftId);
      const recipient = db.prepare('SELECT * FROM users WHERE id = ?').get(toUserId);
      const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!gift || !recipient || !sender) return socket.emit('error_message', 'Invalid gift or recipient');
      sendGift(roomId, sender, recipient, gift);
    });

    on('send_gift_by_username', ({ roomId, toUsername, giftId }) => {
      roomId = Number(roomId);
      if (!isActiveMember(user.id, roomId)) {
        return socket.emit('error_message', "You're not currently in this room — open it from Room Browser to rejoin before sending gifts.");
      }
      const gift = db.prepare('SELECT * FROM gifts_catalog WHERE id = ?').get(giftId);
      const recipient = db.prepare('SELECT * FROM users WHERE username = ?').get((toUsername || '').trim());
      const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!gift) return socket.emit('error_message', 'Invalid gift');
      if (!recipient) return socket.emit('error_message', `No user named "${toUsername}"`);
      if (recipient.id === sender.id) return socket.emit('error_message', "You can't send a gift to yourself");
      sendGift(roomId, sender, recipient, gift);
    });

    function sendGift(roomId, sender, recipient, gift) {
      if (sender.coins < gift.cost) return socket.emit('error_message', 'Not enough coins');
      touchActivity(sender.id, roomId);

      db.prepare('UPDATE users SET coins = coins - ?, total_spent = total_spent + ?, gifts_sent_count = gifts_sent_count + 1 WHERE id = ?')
        .run(gift.cost, gift.cost, sender.id);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(gift.cost, recipient.id);

      // Award xp first so the levels shown in the message reflect this gift's own reward.
      const senderXp = awardXp(sender.id, XP_REWARDS.GIFT_SENT);
      const recipientXp = awardXp(recipient.id, XP_REWARDS.GIFT_RECEIVED);

      const text = `<<${sender.username} [${senderXp.level}] gives a ${gift.name} ${gift.emoji} to ${recipient.username} [${recipientXp.level}]!>>`;
      postMessage(roomId, { userId: sender.id, username: sender.username, type: 'gift', content: text });
      notifyGiftReceived(recipient.id, sender.username, gift, roomId);

      // update sender's own session/socket with new balance
      socket.emit('coins_update', { coins: sender.coins - gift.cost });
    }

    // ---- Invisible mode (Staff / Global Administrator only) ----
    // Lets a moderator sit in a room without appearing in anyone else's
    // participants list — re-checked fresh against the DB, not the cached
    // session, same as every other permission check in this file.
    on('toggle_invisible', (wantInvisible) => {
      const flags = freshRoleFlags(user.id);
      if (!flags.is_staff && !flags.is_global_admin) {
        return socket.emit('error_message', 'Only Staff or a Global Administrator can go invisible');
      }
      invisibleByUser.set(user.id, !!wantInvisible);
      socket.emit('invisible_state', { invisible: !!wantInvisible });
      if (socket.data.roomId) broadcastRoomMembers(socket.data.roomId);
    });

    // ---- Room members + kick/bump/ban (Staff or Global Administrator only,
    // or a room moderator for kick/bump) ----
    // Membership is persistent now, so this works even if the target isn't
    // currently connected/focused on the room — it just marks them inactive
    // and, if they do have a live socket focused there, boots it too. A kick
    // blocks the target from rejoining for 10 minutes, a bump for 5; a ban
    // (Room Settings' Banned tab) is the same mechanism with an effectively
    // permanent cooldown, lifted only by an explicit Unban.
    const REMOVAL_MINUTES = { kick: 10, bump: 5, ban: 100 * 365 * 24 * 60 };
    const REMOVAL_VERB = { kick: 'kicked', bump: 'bumped', ban: 'banned' };
    function performRemoval(roomId, targetUserId, mode) {
      roomId = Number(roomId);
      targetUserId = Number(targetUserId);
      const isBan = mode === 'ban';
      const actionWord = isBan ? 'ban' : mode === 'kick' ? 'kick' : 'bump';
      const minutes = REMOVAL_MINUTES[mode];
      const verb = REMOVAL_VERB[mode];

      const actorFlags = freshRoleFlags(user.id);
      const actorIsModerator = isRoomModerator(user.id, roomId);
      // Banning is a heavier, permanent action — reserved for Staff/Global
      // Admin/the room's owner, unlike kick/bump which a plain moderator can
      // also do.
      const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId);
      const actorIsOwner = !!room && room.created_by === user.id;
      const allowed = isBan
        ? (actorFlags.is_staff || actorFlags.is_global_admin || actorIsOwner)
        : (actorFlags.is_staff || actorFlags.is_global_admin || actorIsModerator);
      if (!allowed) {
        const who = isBan ? "Only Staff, a Global Administrator, or this room's owner" : "Only Staff, a Global Administrator, or this room's moderator";
        socket.emit('error_message', `${who} can ${actionWord} members`);
        return false;
      }
      if (targetUserId === user.id) {
        socket.emit('error_message', `You can't ${actionWord} yourself`);
        return false;
      }

      // Staff is immune to kick/bump/ban, period — even a Global
      // Administrator (who otherwise has full removal power) can't remove a
      // Staff member from a room. Checked fresh against the DB, not a cached flag.
      const targetFlags = freshRoleFlags(targetUserId);
      if (targetFlags.is_staff) {
        socket.emit('error_message', `${actionWord === 'kick' ? 'Kicking' : actionWord === 'bump' ? 'Bumping' : 'Banning'} Staff isn't allowed`);
        return false;
      }

      // A Global Administrator is likewise protected from anyone who isn't
      // themselves Staff or Global Admin — that includes a Staff actor and a
      // moderator/owner-only actor. A Global Admin can still act on another
      // Global Admin (or a plain user).
      const actorIsPrivileged = actorFlags.is_staff || actorFlags.is_global_admin;
      if (targetFlags.is_global_admin && (actorFlags.is_staff || !actorIsPrivileged)) {
        const who = actorFlags.is_staff ? 'Staff' : isBan ? 'a room owner' : 'a room moderator';
        socket.emit('error_message', `${actionWord === 'kick' ? 'Kicking' : actionWord === 'bump' ? 'Bumping' : 'Banning'} a Global Administrator isn't allowed for ${who}`);
        return false;
      }

      const targetRow = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);
      const wasMember = leaveMembership(targetUserId, roomId);
      if (!wasMember && !isBan) {
        socket.emit('error_message', 'That user is not in this room');
        return false;
      }
      const targetUsername = targetRow ? targetRow.username : 'User';

      blockFromRoom(targetUserId, roomId, minutes, mode);

      for (const [, s] of io.sockets.sockets) {
        if (s.data.user && s.data.user.id === targetUserId) {
          if (s.data.roomId === roomId) {
            s.leave(`room:${roomId}`);
            s.data.roomId = null;
          }
          s.emit('kicked', { roomId, by: user.username, reason: mode });
        }
      }

      const kickerLevel = currentLevel(user.id);
      const targetLevel = currentLevel(targetUserId);
      const durationText = isBan ? 'until unbanned' : `can't rejoin for ${minutes} minutes`;
      io.to(`room:${roomId}`).emit('system_message', `${targetUsername} [${targetLevel}] was ${verb} by ${user.username} [${kickerLevel}] — ${durationText}`);
      broadcastRoomMembers(roomId);
      return true;
    }

    on('kick_user', ({ roomId, targetUserId }) => performRemoval(roomId, targetUserId, 'kick'));
    on('bump_user', ({ roomId, targetUserId }) => performRemoval(roomId, targetUserId, 'bump'));
    on('ban_user', ({ roomId, targetUserId }) => performRemoval(roomId, targetUserId, 'ban'));

    // Room Settings' Banned tab: list currently-banned users, and lift a ban.
    on('get_room_bans', ({ roomId }, ack) => {
      roomId = Number(roomId);
      const rows = db.prepare(`
        SELECT u.id, u.username FROM room_blocks b
        JOIN users u ON u.id = b.user_id
        WHERE b.room_id = ? AND b.reason = 'ban' AND b.blocked_until > datetime('now')
        ORDER BY u.username COLLATE NOCASE
      `).all(roomId);
      if (typeof ack === 'function') ack({ ok: true, banned: rows });
    });

    // Shared by the Room Settings "Unban" button and the "/unban <username>"
    // chat command.
    function performUnban(roomId, targetUserId) {
      roomId = Number(roomId);
      targetUserId = Number(targetUserId);
      const actorFlags = freshRoleFlags(user.id);
      const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId);
      const actorIsOwner = !!room && room.created_by === user.id;
      if (!actorFlags.is_staff && !actorFlags.is_global_admin && !actorIsOwner) {
        socket.emit('error_message', "Only Staff, a Global Administrator, or this room's owner can unban members");
        return false;
      }
      db.prepare("DELETE FROM room_blocks WHERE user_id = ? AND room_id = ? AND reason = 'ban'").run(targetUserId, roomId);
      const targetRow = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId);
      const targetUsername = targetRow ? targetRow.username : 'User';
      io.to(`room:${roomId}`).emit('room_unbanned', { roomId, targetUserId, username: targetUsername });
      // Mirror the "was banned by ..." system line so an unban is just as
      // visible in the room's chat log, not just reflected silently in the
      // Banned list.
      const targetLevel = currentLevel(targetUserId);
      const actorLevel = currentLevel(user.id);
      io.to(`room:${roomId}`).emit('system_message', `${targetUsername} [${targetLevel}] was unbanned by ${user.username} [${actorLevel}]`);
      return true;
    }

    on('unban_user', ({ roomId, targetUserId }) => performUnban(roomId, targetUserId));

    // ---- Room silence (Staff, Global Administrator, or a room moderator) ----
    // While a room is silenced, only Staff, Global Admin, the room's owner,
    // and its moderators can post anything in it — see canBypassSilence and
    // the chat_message gate below. Shared by both the /silence chat command
    // and the Room Info screen's Silence button.
    function trySilenceRoom(roomId, secondsArg) {
      const flags = freshRoleFlags(user.id);
      if (!flags.is_staff && !flags.is_global_admin && !isRoomModerator(user.id, roomId)) {
        socket.emit('error_message', "Only Staff, a Global Administrator, or this room's moderator can silence a room");
        return;
      }
      const seconds = Math.floor(Number(secondsArg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        socket.emit('error_message', 'Usage: /silence <seconds> — e.g. /silence 600');
        return;
      }
      silenceRoomFor(roomId, Math.min(seconds, MAX_SILENCE_SECONDS), user.username);
    }

    function tryUnsilenceRoom(roomId) {
      const flags = freshRoleFlags(user.id);
      if (!flags.is_staff && !flags.is_global_admin && !isRoomModerator(user.id, roomId)) {
        socket.emit('error_message', "Only Staff, a Global Administrator, or this room's moderator can unsilence a room");
        return;
      }
      if (!roomSilence.isSilenced(roomId)) {
        socket.emit('error_message', 'This room is not currently silenced');
        return;
      }
      unsilenceRoomFor(roomId, user.username);
    }

    on('silence_room', ({ roomId, seconds }) => trySilenceRoom(Number(roomId), seconds));
    on('unsilence_room', ({ roomId }) => tryUnsilenceRoom(Number(roomId)));

    // ---- Room moderators (added/removed by the room's owner, or Staff/Global Admin) ----
    // A room can have any number of moderators — each can kick/bump members
    // and silence/unsilence this one room, same as Staff/Global Admin/the
    // owner can (see performRemoval and canBypassSilence). Shared by both
    // the /mod, /unmod chat commands and the Room Info screen.
    function trySetModerator(roomId, usernameArg) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) return socket.emit('error_message', 'Room not found');

      const flags = freshRoleFlags(user.id);
      const isOwner = room.created_by === user.id;
      if (!isOwner && !flags.is_staff && !flags.is_global_admin) {
        socket.emit('error_message', "Only this room's owner (or Staff/Global Admin) can add a moderator");
        return;
      }

      const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(usernameArg);
      if (!target) return socket.emit('error_message', `No user named "${usernameArg}"`);

      if (isRoomModerator(target.id, roomId)) {
        socket.emit('error_message', `${target.username} is already a moderator of ${room.name}`);
        return;
      }

      db.prepare('INSERT OR IGNORE INTO room_moderators (room_id, user_id, added_by) VALUES (?, ?, ?)').run(roomId, target.id, user.id);
      io.to(`room:${roomId}`).emit('system_message', `🔰 ${target.username} was made a moderator of ${room.name} by ${user.username}`);
      io.to(`room:${roomId}`).emit('room_moderators_updated', { roomId, moderators: getRoomModerators(roomId).map((m) => m.username) });
      broadcastRoomMembers(roomId);
    }

    function tryRemoveModerator(roomId, usernameArg) {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
      if (!room) return socket.emit('error_message', 'Room not found');

      const flags = freshRoleFlags(user.id);
      const isOwner = room.created_by === user.id;
      if (!isOwner && !flags.is_staff && !flags.is_global_admin) {
        socket.emit('error_message', "Only this room's owner (or Staff/Global Admin) can remove a moderator");
        return;
      }

      const target = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(usernameArg);
      if (!target) return socket.emit('error_message', `No user named "${usernameArg}"`);

      const info = db.prepare('DELETE FROM room_moderators WHERE room_id = ? AND user_id = ?').run(roomId, target.id);
      if (info.changes === 0) {
        socket.emit('error_message', `${target.username} is not a moderator of ${room.name}`);
        return;
      }

      io.to(`room:${roomId}`).emit('system_message', `${user.username} removed ${target.username} as a moderator of ${room.name}`);
      io.to(`room:${roomId}`).emit('room_moderators_updated', { roomId, moderators: getRoomModerators(roomId).map((m) => m.username) });
      broadcastRoomMembers(roomId);
    }

    on('set_moderator', ({ roomId, username }) => trySetModerator(Number(roomId), username));
    on('remove_moderator', ({ roomId, username }) => tryRemoveModerator(Number(roomId), username));

    // ---- Ghost Mode (Room Settings) — per user per room, any member ----
    // "Join this room invisibly" — persisted on the membership row, so it
    // survives disconnects; applied live in broadcastRoomMembers below
    // (hidden from everyone else's Participants list, still visible to
    // yourself). Unlike Staff/Global Admin's global invisible toggle above,
    // any member can use this, and it's scoped to one room at a time.
    on('set_room_ghost_mode', ({ roomId, ghost }) => {
      roomId = Number(roomId);
      db.prepare('UPDATE room_memberships SET ghost_mode = ? WHERE user_id = ? AND room_id = ?')
        .run(ghost ? 1 : 0, user.id, roomId);
      socket.emit('room_ghost_mode_state', { roomId, ghost: !!ghost });
      broadcastRoomMembers(roomId);
    });

    // ---- Room Settings: description + level lock (owner/Staff/Global Admin) ----
    on('update_room_settings', ({ roomId, description, lockLevel }) => {
      roomId = Number(roomId);
      const room = db.prepare('SELECT created_by FROM rooms WHERE id = ?').get(roomId);
      if (!room) return socket.emit('error_message', 'Room not found');
      const flags = freshRoleFlags(user.id);
      const isOwner = room.created_by === user.id;
      if (!flags.is_staff && !flags.is_global_admin && !isOwner) {
        return socket.emit('error_message', "Only Staff, a Global Administrator, or this room's owner can change Room Settings");
      }
      const desc = String(description || '').slice(0, 500);
      const level = Math.max(0, Math.min(100, parseInt(lockLevel, 10) || 0));
      db.prepare('UPDATE rooms SET description = ?, lock_level = ? WHERE id = ?').run(desc, level, roomId);
      io.to(`room:${roomId}`).emit('room_settings_updated', { roomId, description: desc, lockLevel: level });
      socket.emit('room_settings_saved', { roomId });
    });

    // ---- Legendary Bot (dice-betting game, confined to its own room) ----
    on('legendary_place_bet', ({ animal, amount }, ack) => {
      const result = placeLegendaryBet(user, animal, amount);
      if (typeof ack === 'function') ack(result);
      else if (!result.ok) socket.emit('error_message', result.error);
    });
    on('legendary_get_state', (data, ack) => {
      const totals = {};
      for (const [k, v] of legendaryAnimalTotals) totals[k] = v;
      if (typeof ack === 'function') ack({ phase: legendaryPhase, endsAt: legendaryEndsAt, animalTotals: totals });
    });

    socket.on('disconnect', () => {
      // A disconnect (page refresh, brief network drop, closing the tab) is
      // NOT a room-leave anymore — membership persists until an explicit
      // leave_room, a kick, or the 5-hour idle sweep. We just stop pushing
      // this socket live updates; the participant list is untouched.

      // Only mark the user fully offline once their LAST socket has gone —
      // they may have more than one tab/device connected.
      let stillConnected = false;
      for (const [, s] of io.sockets.sockets) {
        if (s.id !== socket.id && s.data.user && s.data.user.id === user.id) { stillConnected = true; break; }
      }
      if (!stillConnected) {
        presence.markOffline(user.id);
        invisibleByUser.delete(user.id);
      }
    });
  });

  // Exposed so REST routes (Color Shop, Avatar Maker, etc.) can push a live
  // Participants-panel refresh right after changing a user's cosmetic info —
  // e.g. buying a username color should show up for everyone currently in
  // that user's room immediately, not just after they refresh. Finds every
  // room this user's socket(s) are currently focused on and re-broadcasts.
  function refreshUserPresence(userId) {
    const roomIds = new Set();
    for (const [, s] of io.sockets.sockets) {
      if (s.data.user && s.data.user.id === userId && s.data.roomId) roomIds.add(s.data.roomId);
    }
    for (const roomId of roomIds) broadcastRoomMembers(roomId);
  }

  return { refreshUserPresence };
}

module.exports = { attachSocket };

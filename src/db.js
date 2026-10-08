const { DatabaseSync } = require('node:sqlite'); // built into Node.js — no native compilation needed
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { xpForLevel } = require('./level');
const { COLOR_TIERS, COLOR_TIERS_BY_KEY } = require('./colorCatalog');

// The data/ folder isn't tracked by git (only files are, and the .db itself
// is gitignored), so on a fresh clone it doesn't exist yet — create it
// before SQLite tries to open a file inside it.
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
// On Render, a fresh deploy briefly overlaps with the outgoing instance
// still finishing its own final write/snapshot to the SAME restored
// database file — without this, that split-second lock contention throws
// "database is locked" (SQLITE_BUSY) and crashes the app on boot instead of
// just waiting the handful of milliseconds it takes for the other side to
// finish. This tells SQLite to quietly retry for up to 5s before giving up.
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_staff INTEGER NOT NULL DEFAULT 0,        -- 0/1: staff privileges
  is_global_admin INTEGER NOT NULL DEFAULT 0, -- 0/1: global administrator privileges
  is_mentor INTEGER NOT NULL DEFAULT 0,       -- 0/1: mentor role (granted by staff)
  is_merchant INTEGER NOT NULL DEFAULT 0,     -- 0/1: merchant role (granted by staff)
  is_exec_board INTEGER NOT NULL DEFAULT 0,   -- 0/1: Executive Board role (granted by staff)
  is_country_rep INTEGER NOT NULL DEFAULT 0,  -- 0/1: Country Representative role (granted by staff)
  is_elite INTEGER NOT NULL DEFAULT 0,        -- 0/1: Elite User role (granted by staff)
  coins INTEGER NOT NULL DEFAULT 1000,
  xp INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  uno_wins INTEGER NOT NULL DEFAULT 0,        -- Leader Board: UNO games won
  total_spent INTEGER NOT NULL DEFAULT 0,     -- Legendary Contest: lifetime coins spent on gifts
  gifts_sent_count INTEGER NOT NULL DEFAULT 0,-- Gift Contest: lifetime gifts sent
  last_spin_at TEXT,                          -- Daily Spin cooldown
  username_color TEXT,                        -- Color Shop: purchased custom name color (hex), only shown when the account holds no role badge
  avatar_frame_color TEXT,                    -- Avatar Maker: avatar ring color
  avatar_pet TEXT,                            -- Avatar Maker: companion emoji shown next to the avatar
  avatar_scene TEXT,                          -- Avatar Maker: backdrop emoji shown on the profile card
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_by INTEGER,
  is_official INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 50,
  room_type TEXT NOT NULL DEFAULT 'chat', -- 'chat' | 'game' — chat rooms never offer games; only a game room does (see socket.js UNO gating)
  -- Deprecated — superseded by the room_moderators table below (a room can
  -- now have more than one moderator). Left in place, unread, rather than
  -- dropped (SQLite column drops require a full table rebuild); any
  -- pre-existing value is migrated into room_moderators once, below.
  moderator_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A room can have any number of moderators, each added/removed individually
-- by the room's owner (or Staff/Global Admin) via /mod <username> and
-- /unmod <username> — see socket.js. A moderator can kick/bump members and
-- silence/unsilence the room the same as Staff/Global Admin/the owner can,
-- scoped to just this one room.
CREATE TABLE IF NOT EXISTS room_moderators (
  room_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  added_by INTEGER,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'gift' | 'system' | 'voucher'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gifts_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  cost INTEGER NOT NULL
);

-- Badge Store (Explore -> Badge Store to buy with coins, Badge Panel to
-- equip/unequip) — a purely cosmetic one-time purchase, showcased on the
-- buyer's profile card (see users.equipped_badge_id above). Ownership is
-- tracked in user_badges; a badge can only be bought once per user.
CREATE TABLE IF NOT EXISTS badges_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  cost INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_badges (
  user_id INTEGER NOT NULL,
  badge_id INTEGER NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, badge_id)
);

-- Sticker Store (Explore -> Sticker Store) — packs of emoji "stickers"
-- bought once with coins; owned packs' stickers then show up as a Stickers
-- tab in the chat emoji picker (see #emojiPickerPopover in app.js), same
-- insert-into-chat-input behavior as a regular emoji.
CREATE TABLE IF NOT EXISTS sticker_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stickers TEXT NOT NULL, -- JSON array of emoji strings
  cost INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_sticker_packs (
  user_id INTEGER NOT NULL,
  pack_id INTEGER NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, pack_id)
);

-- Emoji Store (Staff / Admin Panel -> Emoji Store) — unlike Sticker Store
-- above, these are free for every user the moment Staff adds them; there's
-- no coin cost or per-user ownership. Staff can group emoji into a named
-- pack (its own tab in the chat emoji picker, with its own tab icon) or add
-- a single emoji with no pack at all, which lands in an auto-created
-- "Custom" pack (see ensureCustomEmojiPack in routes/emojiPacks.js) so the
-- picker never needs a separate "loose emoji" concept.
CREATE TABLE IF NOT EXISTS emoji_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT NOT NULL, -- shown on the pack's tab in the chat emoji picker
  emoji TEXT NOT NULL, -- JSON array of emoji strings
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Color Shop catalog (Settings -> Color Shop). Was a hard-coded array in
-- routes/colors.js; now a real table so Staff can change a color's price
-- (POST /colors/:id/price) without a code change/redeploy. Kept a TEXT id
-- (the old catalog's short slugs) so nothing else that might reference a
-- color by id breaks. icon/ring1/ring2/bold/voice_perk/sort_order were
-- added for the tiered-badge redesign (King/Queen/Mafia/Vip/Diamond/
-- Premium/Supporter/Streamer) — see the migration loop below and
-- src/colorCatalog.js for the seed data.
CREATE TABLE IF NOT EXISTS color_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hex TEXT NOT NULL,
  cost INTEGER NOT NULL
);

-- Multi-ownership for Color Shop purchases (the tiered redesign) — unlike
-- the old single username_color field, a user can now own SEVERAL tiers at
-- once (each with its own purchase/expiry) and toggle which one is active
-- (users.active_color_key). Buying an already-owned, still-active tier
-- extends expires_at rather than creating a duplicate row.
CREATE TABLE IF NOT EXISTS user_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  color_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  UNIQUE(user_id, color_id)
);

-- Each user's own quick-send gift bar (shown in the chat room's gift row) —
-- capped at 10 (enforced in the route), so the bar stays a short, glanceable
-- strip instead of every gift in the catalog. Picked from the full catalog
-- via the "+" button, which opens the complete list to favorite/unfavorite.
CREATE TABLE IF NOT EXISTS gift_favorites (
  user_id INTEGER NOT NULL,
  gift_id INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, gift_id)
);

CREATE TABLE IF NOT EXISTS room_visits (
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  visited_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, room_id)
);

CREATE TABLE IF NOT EXISTS room_favorites (
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_id)
);

-- Friendships stored as one row per pair; requester -> addressee, status pending/accepted.
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(requester_id, addressee_id)
);

-- title is the bold headline shown in the Notifications list, content is the
-- gray description line under it, and type picks which icon/color renders
-- (level, gift, coins, or system) — see ALERT_TYPES in app.js.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Self-service "Become a Merchant" requests (Explore -> Become a Merchant).
-- One pending application per user at a time (enforced in the route, not
-- here, since SQLite partial-unique-index syntax varies by version). Staff
-- review these and approve/reject; approving just sets is_merchant = 1,
-- same as flipping the checkbox in the Admin Panel today.
CREATE TABLE IF NOT EXISTS merchant_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

-- Self-service "Become a Global Administrator" requests (Explore -> Become a
-- Global Administrator) — same shape and flow as merchant_applications
-- above. Approving sets is_global_admin = 1 AND credits 1,000,000 coins in
-- one step (see routes/globalAdmin.js) — unlike Merchant, which is just the
-- role flag with no coin grant.
CREATE TABLE IF NOT EXISTS globaladmin_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  reviewed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

-- Chat "/purchase effect" store — time-limited access to a themed chat
-- effect command ("/bomb", "/thunder", ...; catalog in effectsCatalog.js).
-- One row per (user, effect): buying an effect the user already owns just
-- pushes expires_at another N days out from now rather than stacking rows
-- (see the ON CONFLICT upsert in socket.js), so "already own it" always
-- means "renew/extend", never a duplicate purchase.
CREATE TABLE IF NOT EXISTS user_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  effect_key TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  UNIQUE(user_id, effect_key)
);

-- Staff-authored posts, shared table for the Explore hub's Announcements and
-- Blog cards (they're the same mechanism with a different label).
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'announcement', -- 'announcement' | 'blog'
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'Staff',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who is currently "in" a room, as a persistent fact independent of whether
-- their socket is connected right now. A page refresh or brief network drop
-- disconnects the socket but must NOT remove someone from the room — they
-- stay listed until they explicitly leave, get kicked, or go idle for 5 hours
-- (see the ROOM_IDLE_TIMEOUT_MS sweep in socket.js).
CREATE TABLE IF NOT EXISTS room_memberships (
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set whenever this user explicitly leaves, logs out, or is kicked/bumped/
  -- idle-timed-out from this room. GET /rooms/:id/messages only returns
  -- messages newer than this for that user, so their chat view comes back
  -- empty on their next visit instead of replaying everything they already
  -- saw — a normal refresh/reconnect (which never touches this column)
  -- keeps full history exactly as before.
  history_cleared_at TEXT,
  -- Stamped to "now" every time this user genuinely (re-)enters this room —
  -- a brand new join, or coming back after being fully away (see
  -- cameBackAfterBeingAway in socket.js) — but left untouched by a plain
  -- page refresh or switching between room tabs you're already active in.
  -- join_room's history handed back to the client is everything posted
  -- after this timestamp, so: a fresh entry starts blank (nothing has been
  -- posted since "now"), while a refresh mid-session shows exactly what was
  -- on screen before the reload instead of looking like you left.
  last_entered_at TEXT,
  PRIMARY KEY (user_id, room_id)
);

-- A temporary rejoin cooldown for a specific user in a specific room, set by
-- a kick (10 minutes) or a bump (5 minutes). While blocked_until is in the
-- future, that user can't rejoin that one room (other rooms are unaffected).
-- Rows are harmless once expired and get overwritten by the next block.
CREATE TABLE IF NOT EXISTS room_blocks (
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  blocked_until TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id)
);

-- Every coin-balance change, for the My Balance screen (Settings -> My
-- Balance): a running ledger so "earned today" / "spent today" and the
-- Activity list can be computed from real history instead of just the
-- current total. delta is signed (positive = earned, negative = spent);
-- category is one of 'games' | 'gifts' | 'transfers' | 'other', matching the
-- Activity screen's filter tabs.
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user_time ON coin_transactions(user_id, created_at DESC);

-- Reactions on a post (Blog: favorite/like/dislike). One row per
-- user+post+kind; like and dislike are kept mutually exclusive by the route
-- handler (inserting one deletes the other), favorite is independent so a
-- post can be both liked and favorited at once.
CREATE TABLE IF NOT EXISTS post_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL, -- 'like' | 'dislike' | 'favorite'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(post_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id);

-- "Footprint" — who has viewed whose profile. One row per (visitor, visited)
-- pair, upserted on every fresh view so re-visiting just bumps visited_at
-- instead of piling up duplicate rows; a profile's footprint count is simply
-- COUNT(*) of rows for that visited_id (distinct visitors who've ever
-- looked, not a raw view counter). Never written for viewing your own
-- profile — see GET /api/users/:username in routes/users.js.
CREATE TABLE IF NOT EXISTS profile_visits (
  visitor_id INTEGER NOT NULL,
  visited_id INTEGER NOT NULL,
  visited_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (visitor_id, visited_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_visits_visited ON profile_visits(visited_id, visited_at DESC);

-- Deprecated: originally a single, global site-wide "/announcement" row.
-- The announcement is now per-room (see the announcement/announcement_by/
-- announcement_at columns added to rooms below) since one room's
-- announcement showing up in every other room made no sense. Left in place,
-- unread, rather than dropped (SQLite table drops aren't free either).
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  announcement TEXT,
  announcement_by TEXT,
  announcement_at TEXT
);
`);

// Migrate older databases created before Staff could gate room creation by
// level. Reuses the otherwise-unused app_settings singleton row (id=1)
// rather than a new one-row table — see the "Deprecated" note above.
const appSettingsColumns = db.prepare('PRAGMA table_info(app_settings)').all().map((c) => c.name);
if (!appSettingsColumns.includes('min_room_create_level')) {
  db.exec('ALTER TABLE app_settings ADD COLUMN min_room_create_level INTEGER NOT NULL DEFAULT 0');
}

// Migrate older databases created before Blog posts could carry a picture.
const postColumns = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (!postColumns.includes('image')) {
  db.exec('ALTER TABLE posts ADD COLUMN image TEXT');
}
// A Blog post can optionally be a Poll instead of plain text — the question
// is just the post's own `content`, and poll_options holds a JSON array of
// its choices (e.g. ["Coffee","Tea"]); NULL on every ordinary post. See the
// Home Feed composer's Poll button in app.js and post_poll_votes below.
if (!postColumns.includes('poll_options')) {
  db.exec('ALTER TABLE posts ADD COLUMN poll_options TEXT');
}

// One vote per user per poll post — voting again just changes option_index
// (see POST /posts/:id/vote), rather than adding a second vote.
db.exec(`
CREATE TABLE IF NOT EXISTS post_poll_votes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_index INTEGER NOT NULL,
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);
`);

// Migrate older databases created before mentor/merchant roles existed —
// CREATE TABLE IF NOT EXISTS above won't add columns to an existing table.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('is_mentor')) {
  db.exec('ALTER TABLE users ADD COLUMN is_mentor INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.includes('is_merchant')) {
  db.exec('ALTER TABLE users ADD COLUMN is_merchant INTEGER NOT NULL DEFAULT 0');
}
// Migrate older databases created before the Explore hub (Members roles,
// Leader Board, Contests, Daily Spin, Color Shop, Avatar Maker) existed.
const newUserColumns = [
  ['is_exec_board', "INTEGER NOT NULL DEFAULT 0"],
  ['is_country_rep', "INTEGER NOT NULL DEFAULT 0"],
  ['is_elite', "INTEGER NOT NULL DEFAULT 0"],
  ['uno_wins', "INTEGER NOT NULL DEFAULT 0"],
  ['total_spent', "INTEGER NOT NULL DEFAULT 0"],
  ['gifts_sent_count', "INTEGER NOT NULL DEFAULT 0"],
  ['last_spin_at', "TEXT"],
  ['username_color', "TEXT"],
  ['username_gradient', "TEXT"], // Staff-only: JSON array of 5-8 hex colors for a custom multi-color gradient name (Settings -> Color Shop -> Staff Gradient), overriding the default 3-color role-staff gradient. NULL = use the default.
  ['avatar_frame_color', "TEXT"],
  ['avatar_pet', "TEXT"],
  ['avatar_scene', "TEXT"],
  ['country', "TEXT"],
  ['email', "TEXT"],
  ['gender', "TEXT"],             // 'male' | 'female', set at registration
  ['referrer_user_id', "INTEGER"], // id of the account that referred this signup, if any
  ['is_bot', "INTEGER NOT NULL DEFAULT 0"], // 0/1: an ambient chat account (see src/chatbots.js) — never a real login-worthy distinction, just keeps simulated chatter from ever picking a real user's account
  ['status', "TEXT NOT NULL DEFAULT 'online'"], // 'online' | 'away' | 'busy' — the user's own chosen presence state while connected; the *effective* status shown to others is 'offline' whenever they have no live socket at all, regardless of this column (see presence.js effectiveStatus).
  ['username_color_bought_at', 'TEXT'], // when the current username_color was purchased from the Color Shop — a purchased color can't be reset/replaced for 30 days from this timestamp (see routes/colors.js COLOR_LOCK_DAYS). NULL means no active lock (never bought one, or it already expired).
  ['equipped_badge_id', 'INTEGER'], // Badge Store (Explore -> Badge Store to buy, Badge Panel to equip/unequip) — the one owned badge (badges_catalog.id, or NULL for none) currently showcased on this user's profile card.
  ['active_color_key', 'TEXT'], // Color Shop (new tiered redesign) — which ONE owned color is currently toggled on: either a color_catalog id (a purchased tier) or a role key ('merchant','elite','mentor','exec_board','country_rep','global_admin'). NULL = automatic default (the old behavior: highest-priority held role, or legacy username_color, or nothing). Staff is excluded — their gradient always wins regardless of this.
  ['avatar_photo_url', 'TEXT'], // Avatar Maker: an uploaded profile photo ("/uploads/<file>"), shown instead of the colored-initial avatar everywhere avatarPreviewHtml() renders. NULL = no photo uploaded, falls back to the initial/pet/scene avatar.
];
for (const [col, def] of newUserColumns) {
  if (!userColumns.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
}

// Migrate older databases created before the tiered Color Shop redesign
// (badge icon + colored ring + duration/bold tag + an optional "voice"
// perk per tier, shown on the shop card — see src/colorCatalog.js).
const colorCatalogColumns = db.prepare('PRAGMA table_info(color_catalog)').all().map((c) => c.name);
const newColorCatalogColumns = [
  ['icon', 'TEXT'],
  ['ring1', 'TEXT'],
  ['ring2', 'TEXT'],
  ['days', 'INTEGER NOT NULL DEFAULT 30'],
  ['bold', 'INTEGER NOT NULL DEFAULT 0'],
  ['voice_perk', 'INTEGER NOT NULL DEFAULT 1'],
  ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
];
for (const [col, def] of newColorCatalogColumns) {
  if (!colorCatalogColumns.includes(col)) {
    db.exec(`ALTER TABLE color_catalog ADD COLUMN ${col} ${def}`);
  }
}

// Migrate older databases created before per-user chat-history clearing existed.
const membershipColumns = db.prepare('PRAGMA table_info(room_memberships)').all().map((c) => c.name);
if (!membershipColumns.includes('history_cleared_at')) {
  db.exec('ALTER TABLE room_memberships ADD COLUMN history_cleared_at TEXT');
}
// Migrate older databases created before refresh-safe chat history existed.
if (!membershipColumns.includes('last_entered_at')) {
  db.exec('ALTER TABLE room_memberships ADD COLUMN last_entered_at TEXT');
}
// Ghost Mode (Room Settings): join a specific room without appearing in its
// member list to anyone but yourself. Per user per room, so it's a
// membership column rather than a global flag like Staff/Admin invisible.
if (!membershipColumns.includes('ghost_mode')) {
  db.exec('ALTER TABLE room_memberships ADD COLUMN ghost_mode INTEGER NOT NULL DEFAULT 0');
}
// Ghost Mode is now Staff/Global Admin-only (same rule as the "Going
// Invisible" status — see toggle_invisible/set_room_ghost_mode in
// socket.js), so any ordinary user who had it on from before that
// restriction existed needs it cleared — runs every boot, cheap and
// idempotent, so an already-deployed database self-heals too.
db.exec(`
  UPDATE room_memberships SET ghost_mode = 0
  WHERE ghost_mode = 1 AND user_id IN (SELECT id FROM users WHERE is_staff = 0 AND is_global_admin = 0)
`);

// Migrate older databases created before chat rooms and game rooms were kept
// separate. Every pre-existing room defaults to 'chat' via the column
// default; the seeded UNO Arena is flipped to 'game' explicitly below.
const roomColumns = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
if (!roomColumns.includes('room_type')) {
  db.exec("ALTER TABLE rooms ADD COLUMN room_type TEXT NOT NULL DEFAULT 'chat'");
  db.prepare("UPDATE rooms SET room_type = 'game' WHERE name = 'UNO Arena'").run();
}
// UNO has been removed from this build entirely — every room (including the
// old UNO Arena, kept around as a plain room so nobody's open tab breaks) is
// just a chat room now. room_type/moderator_id columns are left in place
// (SQLite can't cheaply drop a column) but nothing reads room_type anymore.
if (roomColumns.includes('room_type')) {
  db.exec("UPDATE rooms SET room_type = 'chat' WHERE room_type != 'chat'");
}
// Migrate older databases created before rooms could have a moderator.
if (!roomColumns.includes('moderator_id')) {
  db.exec('ALTER TABLE rooms ADD COLUMN moderator_id INTEGER');
}
// Room Settings: a free-text description shown as the chat's pinned welcome
// banner (replaces the old hard-coded "welcome to X chatroom" text once
// set), and a minimum-level lock (0 = open to everyone) enforced on join.
if (!roomColumns.includes('description')) {
  db.exec('ALTER TABLE rooms ADD COLUMN description TEXT');
}
if (!roomColumns.includes('lock_level')) {
  db.exec('ALTER TABLE rooms ADD COLUMN lock_level INTEGER NOT NULL DEFAULT 0');
}
// The mig66/mig33-style "/announcement" is per-room, not site-wide — a
// message posted in one room has no business showing up in another. Each
// room carries its own pinned announcement text/author/timestamp; NULL
// means no active announcement for that room. (Supersedes the earlier
// single-row app_settings-based global announcement below — that old value
// is deliberately NOT migrated into every room, since that would just
// reproduce the same "shows up everywhere" behavior this replaces.)
if (!roomColumns.includes('announcement')) {
  db.exec('ALTER TABLE rooms ADD COLUMN announcement TEXT');
}
if (!roomColumns.includes('announcement_by')) {
  db.exec('ALTER TABLE rooms ADD COLUMN announcement_by TEXT');
}
if (!roomColumns.includes('announcement_at')) {
  db.exec('ALTER TABLE rooms ADD COLUMN announcement_at TEXT');
}
// One-time backfill: rooms used to hold a single moderator_id column;
// moderators now live in room_moderators (a room can have several). Any
// already-set single moderator is copied over once — harmless to re-run,
// INSERT OR IGNORE no-ops once it's already there.
for (const r of db.prepare('SELECT id, moderator_id FROM rooms WHERE moderator_id IS NOT NULL').all()) {
  db.prepare('INSERT OR IGNORE INTO room_moderators (room_id, user_id) VALUES (?, ?)').run(r.id, r.moderator_id);
}

// Migrate older databases created before alerts had a type/title (the
// redesigned Notifications list needs both for the icon + bold headline).
const alertColumns = db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name);
if (!alertColumns.includes('type')) {
  db.exec("ALTER TABLE alerts ADD COLUMN type TEXT NOT NULL DEFAULT 'system'");
}
if (!alertColumns.includes('title')) {
  db.exec("ALTER TABLE alerts ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  // Backfill existing rows so old alerts still render sensibly under the new layout.
  db.exec("UPDATE alerts SET title = 'Notification' WHERE title = ''");
}

// Seed default rooms — the three original rooms are "official". A wider
// capacity than the default gives some headroom to show live X/Y counts.
const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
if (roomCount === 0) {
  const insertRoom = db.prepare('INSERT INTO rooms (name, is_official, capacity, room_type) VALUES (?, 1, ?, ?)');
  // Same capacity as every country room below (200) — a mismatched 100/50/70
  // here made the Official Rooms list look randomly sized for no reason.
  insertRoom.run('Lobby', 200, 'chat');
  insertRoom.run('UNO Arena', 200, 'chat'); // kept as a plain chat room name — UNO itself has been removed
  insertRoom.run('Chill Zone', 200, 'chat');
}

// Normalize capacity on any of these rooms an OLDER database already
// created with the old mismatched numbers (Lobby 100, UNO Arena 50, Chill
// Zone 70, game-bot rooms at an inconsistent 300) — runs every boot, cheap
// and idempotent, so a live/already-deployed database self-heals to the
// same organized sizing a fresh install gets: 200 for every general chat
// room (same as every country room), 300 for the three higher-traffic game
// bot rooms.
{
  const setCapacity = db.prepare('UPDATE rooms SET capacity = ? WHERE name = ? AND capacity != ?');
  for (const name of ['Lobby', 'UNO Arena', 'Chill Zone']) setCapacity.run(200, name, 200);
  for (const name of ['Legendary Bot Official', 'Official LowCard Room', 'Official Cricket Room']) setCapacity.run(300, name, 300);
}

// The Legendary Bot dice-betting game's dedicated room (added after the
// initial three, so it's seeded the same migration-safe way as the country
// rooms below rather than folded into the roomCount===0 block above).
{
  const legendaryExists = db.prepare('SELECT 1 FROM rooms WHERE name = ?').get('Legendary Bot Official');
  if (!legendaryExists) {
    db.prepare("INSERT INTO rooms (name, is_official, capacity, room_type, description) VALUES (?, 1, ?, 'chat', ?)")
      .run('Legendary Bot Official', 300, 'Bet coins on Lion, Tiger, Fox, Wolf, Bear or Panda — Legendary Bot rolls 6 dice every round and pays out on however many land on your animal. Type !start to kick off a round.');
  }
}

// LowCard and Cricket bot games — same migration-safe seeding pattern as
// the Legendary Bot room above. See createEliminationGame in socket.js.
{
  const lowcardExists = db.prepare('SELECT 1 FROM rooms WHERE name = ?').get('Official LowCard Room');
  if (!lowcardExists) {
    db.prepare("INSERT INTO rooms (name, is_official, capacity, room_type, description) VALUES (?, 1, ?, 'chat', ?)")
      .run('Official LowCard Room', 300, 'Type !start to open a new LowCard game (entry: 50 coins), !j to join within the window, then !d each round to draw a card — lowest card is eliminated until one player wins the pot.');
  }
  const cricketExists = db.prepare('SELECT 1 FROM rooms WHERE name = ?').get('Official Cricket Room');
  if (!cricketExists) {
    db.prepare("INSERT INTO rooms (name, is_official, capacity, room_type, description) VALUES (?, 1, ?, 'chat', ?)")
      .run('Official Cricket Room', 300, 'Type !start to open a new Cricket game (entry: 50 coins), !j to join within the window, then !d each round to bat — get OUT and you\'re eliminated, last batter standing wins the pot.');
  }
}

// Seed gift catalog
const giftCount = db.prepare('SELECT COUNT(*) c FROM gifts_catalog').get().c;
if (giftCount === 0) {
  const insertGift = db.prepare('INSERT INTO gifts_catalog (name, emoji, cost) VALUES (?, ?, ?)');
  insertGift.run('Rose', '🌹', 10);
  insertGift.run('Heart', '❤️', 25);
  insertGift.run('Crown', '👑', 100);
  insertGift.run('Rocket', '🚀', 250);
  insertGift.run('Diamond', '💎', 500);
  insertGift.run('Black Diamond', '🖤💎', 750);
  insertGift.run('Pink Diamond', '💗💎', 600);
  insertGift.run('Coffee', '☕', 20);
  insertGift.run('Angel', '👼', 300);
  insertGift.run('Bhai', '🫂', 80);
  insertGift.run('Boss', '🤵', 400);
}

// Seed Badge Store catalog
const badgeCount = db.prepare('SELECT COUNT(*) c FROM badges_catalog').get().c;
if (badgeCount === 0) {
  const insertBadge = db.prepare('INSERT INTO badges_catalog (name, emoji, cost) VALUES (?, ?, ?)');
  insertBadge.run('Rising Star', '🌟', 500);
  insertBadge.run('Night Owl', '🦉', 800);
  insertBadge.run('Firestarter', '🔥', 1200);
  insertBadge.run('Trendsetter', '⚡', 2000);
  insertBadge.run('Champion', '🏆', 5000);
  insertBadge.run('Legend', '🐉', 10000);
}

// Seed Sticker Store catalog
const stickerPackCount = db.prepare('SELECT COUNT(*) c FROM sticker_packs').get().c;
if (stickerPackCount === 0) {
  const insertPack = db.prepare('INSERT INTO sticker_packs (name, stickers, cost) VALUES (?, ?, ?)');
  insertPack.run('Classic Faces', JSON.stringify(['😂','😍','😎','🥳','😭','🤩']), 300);
  insertPack.run('Party Pack', JSON.stringify(['🎉','🎊','🥂','🎈','🍾','✨']), 500);
  insertPack.run('Love & Hearts', JSON.stringify(['❤️','💕','💗','💘','😘','🌹']), 500);
  insertPack.run('Animals', JSON.stringify(['🐶','🐱','🦁','🐼','🦊','🐸']), 400);
}

// Seed the Emoji Store catalog once (Staff can add more packs/emoji, or
// remove/edit these, from the Admin Panel -> Emoji Store afterward — this
// only runs the very first time, same idempotent pattern as Sticker Store
// above). Five starter packs so the chat emoji picker already has real
// category tabs (Smileys / Expressions / Creatures / Masks / Gestures) to
// show instead of coming up empty on a fresh install.
const emojiPackCount = db.prepare('SELECT COUNT(*) c FROM emoji_packs').get().c;
if (emojiPackCount === 0) {
  const insertEmojiPack = db.prepare('INSERT INTO emoji_packs (name, icon, emoji) VALUES (?, ?, ?)');
  insertEmojiPack.run('Smileys', '😊', JSON.stringify([
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
    '😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🫡','🤐',
  ]));
  insertEmojiPack.run('Expressions', '😐', JSON.stringify([
    '😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕',
    '🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🥳','🥸','😎','🤓','🧐','😕','😟','🙁',
  ]));
  insertEmojiPack.run('Creatures', '👽', JSON.stringify([
    '👽','👾','🤖','👻','💀','☠️','👹','👺','🤡','😈','😺','😸','😹','😻','😼','😽',
    '🙀','😿','😾','🐵','🙈','🙉','🙊','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨',
  ]));
  insertEmojiPack.run('Masks', '🦇', JSON.stringify([
    '🦇','🎭','🥷','🦹','🦸','🧛','🧟','🧙','🧞','🧌','🧝','🦄','🐉','🐲','🕷️','🕸️',
  ]));
  insertEmojiPack.run('Gestures', '✋', JSON.stringify([
    '✋','🖐️','🤚','🖖','👋','🤙','💪','🙏','👏','🙌','🤝','👍','👎','☝️','👆','👇',
    '👈','👉','✌️','🤞','🤟','🤘','👌','🤌','🤏','✊','👊','🤛','🤜','🫶','💯','🔥',
  ]));
}

// Seed the Color Shop catalog from src/colorCatalog.js's 8 tiers (King,
// Queen, Mafia, Vip, Diamond, Premium, Supporter, Streamer — the tiered
// badge redesign). The old flat hex-color catalog (Sunset Orange, Ocean
// Teal, ...) is removed outright — it has no icon/ring/days and doesn't fit
// the new card design, and nothing references those ids outside this table.
// INSERT OR IGNORE on id so a price a Staff member already changed under a
// new id is never stomped back to the default on a later boot.
db.exec(
  "DELETE FROM color_catalog WHERE id IN ('sunset','ocean','violet','rose','lime','gold','ice','chrome')"
);
const insertColorIfMissing = db.prepare(
  'INSERT OR IGNORE INTO color_catalog (id, name, hex, cost, icon, ring1, ring2, days, bold, voice_perk, sort_order) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
for (const t of COLOR_TIERS) {
  insertColorIfMissing.run(t.key, t.name, t.hex, t.price, t.icon, t.ring1, t.ring2, t.days, t.bold ? 1 : 0, t.voicePerk ? 1 : 0, t.order);
}

// Seed a themed gift for every country in the app's country list (the same
// list used for the profile/registration country dropdown — see COUNTRIES
// in public/app.js). Sudan is deliberately #1: it gets the lowest cost of
// any gift in the catalog, so it always sorts first everywhere gifts are
// listed (both /api/gifts and the giftstore route order by cost ASC).
// This block runs on every boot, not just when the catalog is empty, so it
// also backfills a database that was seeded before this feature existed —
// and it upserts by name, so re-running it never creates duplicates (this
// also cleans up the older plain 'Sudan' gift some earlier seeds included).
const COUNTRY_GIFTS = [
  ['🇸🇩', 'Sudan', 5],
  ['🇺🇸', 'United States', 60], ['🇨🇦', 'Canada', 60], ['🇲🇽', 'Mexico', 60], ['🇧🇷', 'Brazil', 60], ['🇦🇷', 'Argentina', 60],
  ['🇬🇧', 'United Kingdom', 60], ['🇮🇪', 'Ireland', 60], ['🇫🇷', 'France', 60], ['🇩🇪', 'Germany', 60], ['🇪🇸', 'Spain', 60],
  ['🇵🇹', 'Portugal', 60], ['🇮🇹', 'Italy', 60], ['🇳🇱', 'Netherlands', 60], ['🇧🇪', 'Belgium', 60], ['🇨🇭', 'Switzerland', 60],
  ['🇦🇹', 'Austria', 60], ['🇸🇪', 'Sweden', 60], ['🇳🇴', 'Norway', 60], ['🇩🇰', 'Denmark', 60], ['🇫🇮', 'Finland', 60],
  ['🇵🇱', 'Poland', 60], ['🇬🇷', 'Greece', 60], ['🇷🇺', 'Russia', 60], ['🇺🇦', 'Ukraine', 60], ['🇹🇷', 'Turkey', 60],
  ['🇪🇬', 'Egypt', 60], ['🇿🇦', 'South Africa', 60], ['🇳🇬', 'Nigeria', 60], ['🇰🇪', 'Kenya', 60], ['🇲🇦', 'Morocco', 60],
  ['🇸🇦', 'Saudi Arabia', 60], ['🇦🇪', 'United Arab Emirates', 60], ['🇶🇦', 'Qatar', 60], ['🇰🇼', 'Kuwait', 60], ['🇯🇴', 'Jordan', 60],
  ['🇱🇧', 'Lebanon', 60], ['🇮🇱', 'Israel', 60], ['🇮🇶', 'Iraq', 60], ['🇮🇷', 'Iran', 60], ['🇵🇰', 'Pakistan', 60],
  ['🇮🇳', 'India', 60], ['🇧🇩', 'Bangladesh', 60], ['🇱🇰', 'Sri Lanka', 60], ['🇳🇵', 'Nepal', 60], ['🇨🇳', 'China', 60],
  ['🇯🇵', 'Japan', 60], ['🇰🇷', 'South Korea', 60], ['🇹🇼', 'Taiwan', 60], ['🇭🇰', 'Hong Kong', 60], ['🇵🇭', 'Philippines', 60],
  ['🇻🇳', 'Vietnam', 60], ['🇹🇭', 'Thailand', 60], ['🇲🇾', 'Malaysia', 60], ['🇸🇬', 'Singapore', 60], ['🇮🇩', 'Indonesia', 60],
  ['🇦🇺', 'Australia', 60], ['🇳🇿', 'New Zealand', 60], ['🇨🇱', 'Chile', 60], ['🇨🇴', 'Colombia', 60], ['🇵🇪', 'Peru', 60],
  ['🇻🇪', 'Venezuela', 60], ['🇪🇨', 'Ecuador', 60], ['🇺🇾', 'Uruguay', 60], ['🇵🇾', 'Paraguay', 60], ['🇧🇴', 'Bolivia', 60],
  ['🇨🇺', 'Cuba', 60], ['🇩🇴', 'Dominican Republic', 60], ['🇯🇲', 'Jamaica', 60], ['🇹🇹', 'Trinidad and Tobago', 60], ['🇨🇿', 'Czech Republic', 60],
  ['🇸🇰', 'Slovakia', 60], ['🇭🇺', 'Hungary', 60], ['🇷🇴', 'Romania', 60], ['🇧🇬', 'Bulgaria', 60], ['🇭🇷', 'Croatia', 60],
  ['🇷🇸', 'Serbia', 60], ['🇮🇸', 'Iceland', 60], ['🇱🇺', 'Luxembourg', 60], ['🇲🇹', 'Malta', 60], ['🇨🇾', 'Cyprus', 60],
  ['🇬🇭', 'Ghana', 60], ['🇪🇹', 'Ethiopia', 60], ['🇹🇿', 'Tanzania', 60], ['🇺🇬', 'Uganda', 60], ['🇩🇿', 'Algeria', 60],
  ['🇹🇳', 'Tunisia', 60], ['🇱🇾', 'Libya', 60], ['🇰🇿', 'Kazakhstan', 60], ['🇦🇿', 'Azerbaijan', 60], ['🇬🇪', 'Georgia', 60],
  ['🇦🇲', 'Armenia', 60], ['🇴🇲', 'Oman', 60], ['🇧🇭', 'Bahrain', 60], ['🇾🇪', 'Yemen', 60], ['🇸🇾', 'Syria', 60],
];
{
  const findGiftByName = db.prepare('SELECT id FROM gifts_catalog WHERE name = ?');
  const insertCountryGift = db.prepare('INSERT INTO gifts_catalog (name, emoji, cost) VALUES (?, ?, ?)');
  const updateCountryGift = db.prepare('UPDATE gifts_catalog SET emoji = ?, cost = ? WHERE name = ?');
  for (const [flag, name, cost] of COUNTRY_GIFTS) {
    const existing = findGiftByName.get(name);
    if (existing) updateCountryGift.run(flag, cost, name);
    else insertCountryGift.run(name, flag, cost);
  }
}

// An official chat room for every country (same list as the country gifts
// just above), each pre-filled with a welcome Room Description so it looks
// alive from the moment it's created. Migration-safe (checked by name) so it
// backfills an existing database too, same pattern as the country gifts.
{
  const findRoomByName = db.prepare('SELECT id FROM rooms WHERE name = ?');
  const insertCountryRoom = db.prepare("INSERT INTO rooms (name, is_official, capacity, room_type, description) VALUES (?, 1, 200, 'chat', ?)");
  for (const [flag, name] of COUNTRY_GIFTS) {
    if (findRoomByName.get(name)) continue;
    const description = `welcome to ${name} ${flag} country's chatroom\nwe are so happy to see you here!`;
    insertCountryRoom.run(name, description);
  }
}

// Backfill a Room Description onto the original rooms too (and any older
// database's rooms that predate this feature) — only ever fills a NULL, so
// it never clobbers something an owner already wrote.
db.prepare("UPDATE rooms SET description = 'welcome to ' || name || ' chatroom\nwe are so happy to see you here!' WHERE description IS NULL").run();

// Top up the ambient bot pool to ~1000 accounts so the new country rooms
// (and every other room) have people in them — see src/chatbots.js for the
// chatter and src/socket.js for the room-drift/gift-shower simulation that
// actually moves and acts as these accounts. Migration-safe: only adds
// however many are missing, never touches the original 100. All bots share
// one fixed, never-used password hash (bots never log in).
const BOT_TARGET_COUNT = 1000;
const BOT_NAME_POOL = [
  'Kevin','Aria','Kwame','Brooklyn','Ivan','Skylar','Cole','Daniela','Sasha','Priya','Daniel','Meera','Kenji','Victoria','Aaron',
  'Jia','Joseph','Greta','Matthew','Xin','Owen','Katya','Justin','Bianca','Rahul','Layla','Dmitri','Paula','James','Renata',
  'Dylan','Amina','Julian','Ingrid','Logan','Alicia','Connor','Ling','Jordan','Chiamaka','Mateo','Sofia','Diego','Freya','Miles',
  'Grace','Xavier','Anke','Blake','Emma','Mason','Hannah','Femi','Mia','Victor','Paisley','Felix','Bella','Sergei','Sana',
  'Brian','Elena','Sipho','Nadia','Steven','Ananya','Adam','Ines','Karim','Yara','Omar','Astrid','Wei','Camila','John',
  'Claire','Andrew','Fatima','Nathan','Audrey','Arjun','Emily','Ahmed','Wyatt','Amara','Elijah','Nora','Chris','Adaeze','Lucas',
  'Abigail','Ethan','Aisha','Chen','Min-ji','Marcus','Nina','Tunde','Lily','Zoe','Noah','Ivy','Leo','Ruby','Finn',
  'Hana','Theo','Sara','Kian','Nadia','Oscar','Maya','Hugo','Elif','Rami','Lina','Ravi','Tara','Sami','Nia',
  'Kofi','Zara','Ali','Mina','Jamal','Rosa','Tariq','Ana','Bilal','Eva','Hassan','Leila','Idris','Mira','Yusuf',
  'Noor','Malik','Reza','Farah','Hakim','Salma','Bashir','Dina','Kamal','Layan','Amir','Rania','Faisal','Huda','Rashid',
];
function randomToken(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}
const BOT_PASSWORD_HASH = '$2b$10$Jgbtb3pkpeVANj/LLWitkOMWhvldqWjWw1VWzlNs/8RzvGv4JUum2';
const existingBotCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot = 1').get().c;
if (existingBotCount < BOT_TARGET_COUNT) {
  const usernameTaken = db.prepare('SELECT 1 FROM users WHERE username = ?');
  const insertBot = db.prepare(`
    INSERT INTO users (username, password_hash, coins, xp, gender, country, is_bot)
    VALUES (?, ?, 5000, ?, ?, ?, 1)
  `);
  const countryNames = COUNTRY_GIFTS.map(([, name]) => name);
  let toCreate = BOT_TARGET_COUNT - existingBotCount;
  let guard = toCreate * 20; // avoid any chance of an infinite loop
  while (toCreate > 0 && guard-- > 0) {
    const name = BOT_NAME_POOL[Math.floor(Math.random() * BOT_NAME_POOL.length)];
    const username = `${name}${randomToken(2 + Math.floor(Math.random() * 2))}`;
    if (usernameTaken.get(username)) continue;
    const gender = Math.random() < 0.5 ? 'male' : 'female';
    const country = countryNames[Math.floor(Math.random() * countryNames.length)];
    const xp = Math.floor(Math.random() * 300_000); // spreads bots across a wide range of levels
    insertBot.run(username, BOT_PASSWORD_HASH, xp, gender, country);
    toCreate--;
  }
}

// Give every room a live-feeling population from the moment the server
// starts, instead of waiting for the (much slower) ambient room-drift
// simulation in socket.js to organically spread 1000 bots across ~99 rooms
// one bot at a time. Idempotent: only tops up rooms that are genuinely thin
// on bots, so this is safe to run on every boot without endlessly piling on
// more and more memberships.
{
  // Scaled to each room's own capacity so rooms genuinely look "full of
  // people" instead of a flat, often-tiny headcount: ~80% of capacity, with
  // a sensible floor/ceiling so a small 25-capacity user room still feels
  // lively and nothing goes absurdly overboard. A bot can belong to many
  // rooms at once (room_memberships is per room per user), so the shared
  // ~1000-bot pool comfortably covers every room being topped up this way.
  const BOT_ROOM_FILL_RATIO = 0.8;
  const BOTS_PER_ROOM_MIN = 15;
  const BOTS_PER_ROOM_MAX = 220;
  const allBotIds = db.prepare('SELECT id FROM users WHERE is_bot = 1').all().map((r) => r.id);
  const allRooms = db.prepare('SELECT id, capacity FROM rooms').all();
  const insertMembership = db.prepare(`
    INSERT INTO room_memberships (user_id, room_id, active) VALUES (?, ?, 1)
    ON CONFLICT(user_id, room_id) DO UPDATE SET active = 1
  `);
  const countActiveBotsInRoom = db.prepare(`
    SELECT COUNT(*) c FROM room_memberships rm JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND rm.active = 1 AND u.is_bot = 1
  `);
  if (allBotIds.length && allRooms.length) {
    for (const room of allRooms) {
      const cap = room.capacity || BOTS_PER_ROOM_MIN;
      const target = Math.max(
        BOTS_PER_ROOM_MIN,
        Math.min(BOTS_PER_ROOM_MAX, Math.round(cap * BOT_ROOM_FILL_RATIO))
      );
      const current = countActiveBotsInRoom.get(room.id).c;
      if (current >= target) continue;
      const need = target - current;
      // Pick `need` random bots (Fisher-Yates-ish partial shuffle) to drop into this room.
      const pool = allBotIds.slice();
      for (let i = 0; i < need && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        insertMembership.run(pool[idx], room.id);
        pool.splice(idx, 1);
      }
    }
  }
}

// A user's quick-send gift bar (shown in the chat room) is capped at 10 —
// see gift_favorites above — and starts with this sensible default set
// rather than empty, so a brand-new account isn't staring at just a "+"
// button. Exposed on `db` so the register route can call it for a user it
// just created; also run once per boot below to backfill it onto every
// existing account that doesn't have any favorites yet (an upgrade from a
// version of this app before favorites existed).
const DEFAULT_FAVORITE_GIFT_NAMES = ['Sudan', 'Rose', 'Heart', 'Coffee', 'Crown', 'Rocket', 'Diamond', 'Angel', 'Bhai', 'Boss'];
// Records one line in the coin ledger — call this alongside every place that
// changes a user's `coins` column, right after the UPDATE, so the My Balance
// screen's earned/spent totals and Activity list stay accurate. delta is
// signed (positive for a gain, negative for a spend); category must be one
// of 'games' | 'gifts' | 'transfers' | 'other' (matches the Activity filter
// tabs client-side).
const insertCoinTx = db.prepare('INSERT INTO coin_transactions (user_id, delta, category, description) VALUES (?, ?, ?, ?)');
db.logCoinTx = function logCoinTx(userId, delta, category, description) {
  if (!userId || !delta) return;
  insertCoinTx.run(userId, Math.round(delta), category, description);
};

db.seedDefaultGiftFavorites = function seedDefaultGiftFavorites(userId) {
  const insertFavorite = db.prepare('INSERT OR IGNORE INTO gift_favorites (user_id, gift_id) VALUES (?, ?)');
  const findGiftId = db.prepare('SELECT id FROM gifts_catalog WHERE name = ?');
  for (const name of DEFAULT_FAVORITE_GIFT_NAMES) {
    const gift = findGiftId.get(name);
    if (gift) insertFavorite.run(userId, gift.id);
  }
};
{
  const usersWithoutFavorites = db.prepare(`
    SELECT id FROM users WHERE id NOT IN (SELECT DISTINCT user_id FROM gift_favorites)
  `).all();
  for (const { id } of usersWithoutFavorites) db.seedDefaultGiftFavorites(id);
}

// Seed default accounts if they don't already exist, both with BOTH staff and
// global admin privileges so they can bootstrap the rest of the role system.
// 'admin' is the original account; 'miniplatform' and 'boss-3llam' are
// additional, equally privileged accounts created on request — same
// protections as 'admin' below. Overridable via ADMIN_PASSWORD so the real
// value never has to live in source control (important once this repo is on
// GitHub) — set it in your environment (or a local .env, untracked) before
// running in production.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'La00280424';
const PROTECTED_ACCOUNTS = ['admin', 'miniplatform', 'boss-3llam'];
// Each protected account's baseline level is enforced on every boot (via
// xpForLevel), same as its Staff/Global Admin flags and password below —
// this is what guarantees it survives even a database that got rebuilt from
// an older/incomplete backup rather than quietly staying at whatever XP a
// stale snapshot happened to have.
const PROTECTED_LEVELS = { admin: 91, miniplatform: 118, 'boss-3llam': 104 };
for (const username of PROTECTED_ACCOUNTS) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    const xp = xpForLevel(PROTECTED_LEVELS[username] || 1);
    db.prepare('INSERT INTO users (username, password_hash, is_staff, is_global_admin, coins, bio, xp) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, hash, 1, 1, 100000, 'living in everyone\'s head rent-free', xp);
  }
}

// These protected accounts' password and baseline level are enforced on
// every boot (via xpForLevel) so they self-heal even if the DB was edited by
// hand or restored from an older backup — this always works whether the DB
// was just created or a server from an earlier version of this app is being
// upgraded in place. (Their Staff/Global Admin flags are a separate concern —
// see STAFF_ENFORCED_ACCOUNTS right below.)
for (const username of PROTECTED_ACCOUNTS) {
  const row = db.prepare('SELECT id, xp FROM users WHERE username = ?').get(username);
  if (row) {
    const minXp = xpForLevel(PROTECTED_LEVELS[username] || 1);
    if ((row.xp || 0) < minXp) {
      db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(minXp, row.id);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(ADMIN_PASSWORD, 10), row.id);
  }
}

// Of the protected accounts, only 'miniplatform' is always Staff + Global
// Admin by design — it's how the very first role gets granted to anyone
// else, so it must never lose those flags (the Admin Panel also locks its
// Staff checkbox — see routes/admin.js). Enforced again here on every boot
// so it self-heals even from a hand-edited or restored-from-backup DB.
// 'admin' and 'boss-3llam' used to be enforced the same way, but were
// demoted to plain, no-privilege users on request — see the one-time
// founders_demoted_at migration below, which clears whatever role flags they
// currently hold the first time this code runs on a given database (and
// only that once — staff can freely re-promote either of them afterward,
// same as any other account, without this undoing it on the next restart).
const STAFF_ENFORCED_ACCOUNTS = ['miniplatform'];
for (const username of STAFF_ENFORCED_ACCOUNTS) {
  db.prepare('UPDATE users SET is_staff = 1, is_global_admin = 1 WHERE username = ?').run(username);
}

// One-time: 'admin' and 'boss-3llam' go from permanently-enforced Staff +
// Global Admin to plain normal users (every role flag cleared) — requested
// once, then left alone, so this must only ever run once per database.
// Reuses the app_settings singleton row the way the "Deprecated" migrations
// above it do, rather than standing up a whole migrations table for one flag.
const appSettingsFoundersCol = db.prepare('PRAGMA table_info(app_settings)').all().map((c) => c.name);
if (!appSettingsFoundersCol.includes('founders_demoted_at')) {
  db.exec('ALTER TABLE app_settings ADD COLUMN founders_demoted_at TEXT');
}
db.exec('INSERT OR IGNORE INTO app_settings (id) VALUES (1)');
const foundersDemoted = db.prepare('SELECT founders_demoted_at FROM app_settings WHERE id = 1').get();
if (foundersDemoted && !foundersDemoted.founders_demoted_at) {
  db.prepare(`
    UPDATE users SET is_staff = 0, is_global_admin = 0, is_mentor = 0, is_merchant = 0,
      is_exec_board = 0, is_country_rep = 0, is_elite = 0
    WHERE username IN ('admin', 'boss-3llam')
  `).run();
  db.prepare("UPDATE app_settings SET founders_demoted_at = datetime('now') WHERE id = 1").run();
}

// ---- Per-room announcement (mig66/mig33-style "/announcement" command) ----
// Scoped to the room it was posted in — see the `announcement*` columns on
// `rooms` above. getAnnouncement() returns null when there's nothing active
// for that room so callers can just `if (announcement)`.
db.getAnnouncement = function getAnnouncement(roomId) {
  const row = db.prepare('SELECT announcement, announcement_by, announcement_at FROM rooms WHERE id = ?').get(roomId);
  if (!row || !row.announcement) return null;
  return { text: row.announcement, by: row.announcement_by, at: row.announcement_at };
};
db.setAnnouncement = function setAnnouncement(roomId, text, by) {
  db.prepare(`
    UPDATE rooms SET announcement = ?, announcement_by = ?, announcement_at = datetime('now') WHERE id = ?
  `).run(text, by, roomId);
};
db.clearAnnouncement = function clearAnnouncement(roomId) {
  db.prepare('UPDATE rooms SET announcement = NULL, announcement_by = NULL, announcement_at = NULL WHERE id = ?').run(roomId);
};

// ---- Room-creation level gate (Staff-configurable, Admin Panel) ----
// Site-wide minimum level a user must be to create a new chat room. 0 (the
// default) means no restriction — anyone logged in can create one. Staff
// themselves always bypass this check regardless of the configured value
// (see POST /api/rooms).
db.getMinRoomCreateLevel = function getMinRoomCreateLevel() {
  const row = db.prepare('SELECT min_room_create_level FROM app_settings WHERE id = 1').get();
  return row ? (row.min_room_create_level || 0) : 0;
};
db.setMinRoomCreateLevel = function setMinRoomCreateLevel(level) {
  db.prepare('INSERT OR IGNORE INTO app_settings (id) VALUES (1)').run();
  db.prepare('UPDATE app_settings SET min_room_create_level = ? WHERE id = 1').run(level);
};

// ---- Elite User auto-grant ----
// Any active user who sends more than ELITE_GIFT_THRESHOLD gifts (lifetime —
// gifts_sent_count, the same counter behind the Gift Contest leaderboard)
// automatically receives the Elite User role, no Staff action needed. Call
// this right after any UPDATE that bumps gifts_sent_count (see socket.js and
// routes/giftstore.js) — it's a cheap no-op once someone is already Elite.
const ELITE_GIFT_THRESHOLD = 5000;
db.checkEliteEligibility = function checkEliteEligibility(userId) {
  const row = db.prepare('SELECT is_elite, gifts_sent_count, username FROM users WHERE id = ?').get(userId);
  if (!row || row.is_elite || row.gifts_sent_count < ELITE_GIFT_THRESHOLD) return;
  db.prepare('UPDATE users SET is_elite = 1 WHERE id = ?').run(userId);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    userId, 'system', 'You are now an Elite User! 🏅',
    `You've sent over ${ELITE_GIFT_THRESHOLD.toLocaleString()} gifts — Elite User status has been granted automatically.`
  );
};

// A purchased Color Shop tier is time-limited (user_colors.expires_at); once
// it lapses it should also stop being the thing showing on that person's
// name — "My Owned Colors" already only lists non-expired rows (see
// myOwnedColors() in routes/colors.js), but users.active_color_key is a
// separate column that just sits there pointing at the (now-expired) tier
// key until something clears it, so without this, chat/participants/whois
// would keep showing an expired purchase's badge and username color
// indefinitely. There's no cron here, so this is checked lazily instead —
// call it anywhere active_color_key is about to be read for display
// (freshRoleFlags, /auth/me, /auth/login, the Color Shop routes) and it
// self-heals the moment anyone looks. A role-granted color (key isn't in
// COLOR_TIERS_BY_KEY — e.g. 'merchant', 'elite') never expires this way, so
// it's left alone; only a purchased tier that's missing or past its
// expires_at in user_colors gets cleared.
db.clearExpiredActiveColor = function clearExpiredActiveColor(userId) {
  const row = db.prepare('SELECT active_color_key FROM users WHERE id = ?').get(userId);
  if (!row || !row.active_color_key || !COLOR_TIERS_BY_KEY.has(row.active_color_key)) return;
  const stillOwned = db.prepare(
    "SELECT 1 FROM user_colors WHERE user_id = ? AND color_id = ? AND expires_at > datetime('now')"
  ).get(userId, row.active_color_key);
  if (!stillOwned) {
    db.prepare('UPDATE users SET active_color_key = NULL WHERE id = ?').run(userId);
  }
};

module.exports = db;

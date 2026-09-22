const { DatabaseSync } = require('node:sqlite'); // built into Node.js — no native compilation needed
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// The data/ folder isn't tracked by git (only files are, and the .db itself
// is gitignored), so on a fresh clone it doesn't exist yet — create it
// before SQLite tries to open a file inside it.
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
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
`);

// Migrate older databases created before Blog posts could carry a picture.
const postColumns = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (!postColumns.includes('image')) {
  db.exec('ALTER TABLE posts ADD COLUMN image TEXT');
}

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
  ['avatar_frame_color', "TEXT"],
  ['avatar_pet', "TEXT"],
  ['avatar_scene', "TEXT"],
  ['country', "TEXT"],
  ['email', "TEXT"],
  ['gender', "TEXT"],             // 'male' | 'female', set at registration
  ['referrer_user_id', "INTEGER"], // id of the account that referred this signup, if any
  ['is_bot', "INTEGER NOT NULL DEFAULT 0"], // 0/1: an ambient chat account (see src/chatbots.js) — never a real login-worthy distinction, just keeps simulated chatter from ever picking a real user's account
  ['status', "TEXT NOT NULL DEFAULT 'online'"], // 'online' | 'away' | 'busy' — the user's own chosen presence state while connected; the *effective* status shown to others is 'offline' whenever they have no live socket at all, regardless of this column (see presence.js effectiveStatus).
];
for (const [col, def] of newUserColumns) {
  if (!userColumns.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
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
  insertRoom.run('Lobby', 100, 'chat');
  insertRoom.run('UNO Arena', 50, 'chat'); // kept as a plain chat room name — UNO itself has been removed
  insertRoom.run('Chill Zone', 70, 'chat');
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
  const BOTS_PER_ROOM_TARGET = 12;
  const allBotIds = db.prepare('SELECT id FROM users WHERE is_bot = 1').all().map((r) => r.id);
  const allRoomIds = db.prepare('SELECT id FROM rooms').all().map((r) => r.id);
  const insertMembership = db.prepare(`
    INSERT INTO room_memberships (user_id, room_id, active) VALUES (?, ?, 1)
    ON CONFLICT(user_id, room_id) DO UPDATE SET active = 1
  `);
  const countActiveBotsInRoom = db.prepare(`
    SELECT COUNT(*) c FROM room_memberships rm JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND rm.active = 1 AND u.is_bot = 1
  `);
  if (allBotIds.length && allRoomIds.length) {
    for (const roomId of allRoomIds) {
      const current = countActiveBotsInRoom.get(roomId).c;
      if (current >= BOTS_PER_ROOM_TARGET) continue;
      const need = BOTS_PER_ROOM_TARGET - current;
      // Pick `need` random bots (Fisher-Yates-ish partial shuffle) to drop into this room.
      const pool = allBotIds.slice();
      for (let i = 0; i < need && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        insertMembership.run(pool[idx], roomId);
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
// 'admin' is the original account; 'miniplatform' is a second, equally
// privileged account created on request — same protections as 'admin' below.
// Overridable via ADMIN_PASSWORD so the real value never has to live in
// source control (important once this repo is on GitHub) — set it in your
// environment (or a local .env, untracked) before running in production.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'La00280424';
const PROTECTED_ACCOUNTS = ['admin', 'miniplatform'];
for (const username of PROTECTED_ACCOUNTS) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO users (username, password_hash, is_staff, is_global_admin, coins, bio) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, 1, 1, 100000, 'living in everyone\'s head rent-free');
  }
}

// These protected accounts are always Staff + Global Admin by design — it's
// how the very first role gets granted to anyone else, so they must never
// lose those flags (the Admin Panel also locks their Staff checkbox — see
// routes/admin.js). Enforced again here on every boot so they self-heal even
// if the DB was edited by hand, and their password is kept at the fixed
// value above regardless of prior state, so this always works whether the DB
// was just created or a server from an earlier version of this app is being
// upgraded in place.
for (const username of PROTECTED_ACCOUNTS) {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (row) {
    db.prepare('UPDATE users SET is_staff = 1, is_global_admin = 1, password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(ADMIN_PASSWORD, 10), row.id);
  }
}

module.exports = db;

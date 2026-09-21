// Ambient chatter: a pool of "bot" accounts (flagged is_bot = 1 in the users
// table — see db.js) that periodically post casual, room-appropriate small
// talk to whichever rooms they're members of, so a room never looks empty
// even with no real people currently online. Only ever posts as an is_bot
// account — real users are never touched by this.
const db = require('./db');
const roomSilence = require('./roomSilence');

const TOPIC_BANK = {
  Lobby: [
    "hey everyone, how's it going?",
    'anyone else just log on?',
    'morning all ☕',
    'this place is pretty chill today',
    "what's everyone up to?",
    'just got back from work, needed this',
    'loving the new color shop colors btw',
    'does anyone know how the leveling works here?',
    'just hit a new level, feeling good',
    'weekend plans anyone?',
    'this app has come a long way',
    'anyone from around here?',
    'happy to be back in the lobby lol',
    "who's up for some chatting tonight?",
    'quiet in here, someone say something 😄',
    'been a while since I stopped by',
    'anyone try the daily spin yet today?',
  ],
  'UNO Arena': [
    'hey everyone, how\'s it going?',
    'this room name is a throwback lol',
    'anyone around to chat?',
    'just hopping between rooms today',
    'how\'s everyone doing tonight?',
    'nice to see some activity in here',
    'what\'s new with everyone?',
    'just vibing in here',
  ],
  'Chill Zone': [
    'just vibing here, how is everyone',
    'this is my favorite room to relax in',
    'anyone listening to good music rn',
    'long day, glad to unwind here',
    'what shows is everyone watching these days',
    'coffee or tea people, which are you',
    'feels good to just chat with no pressure',
    'anyone else just here to unwind',
    'nice and quiet in here today',
    'always good vibes in this room',
    'rainy day here, perfect for chatting',
    'this room always has the best energy',
  ],
};
const DEFAULT_BANK = TOPIC_BANK.Lobby;

// Short reply templates that reference the previous speaker by name, so a
// back-and-forth exchange reads like a real conversation instead of two
// unrelated one-liners.
const REPLY_BANK = [
  (name) => `haha for real, ${name}?`,
  () => 'same here honestly',
  (name) => `${name} you always say that 😂`,
  () => "right?? that's exactly how I feel",
  (name) => `nice one, ${name}`,
  () => 'lol true',
  (name) => `${name} count me in`,
  () => 'good to know, thanks',
  () => 'haha yeah I noticed that too',
  (name) => `${name} that's actually a good point`,
  () => 'facts',
  (name) => `for sure, ${name}`,
];

// Pure-emoji reactions — bots drop one of these instead of a text line
// sometimes, the same way real chat gets a quick 😂 or 🔥 instead of words.
const EMOJI_REACTIONS = ['😂😂😂', '🔥🔥', '❤️', '👏👏', '😍', '🙌', '💯', '😅', '🤩', '😎', '👍', '🥳', '😭😭', '✨', '😱', '🤔'];

let timer = null;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function runOneExchange(postMessage) {
  const rooms = db.prepare('SELECT id, name FROM rooms').all();
  if (!rooms.length) return;
  const room = pick(rooms);

  // A silenced room stays silent for bots too — nothing should be able to
  // post in it (besides Staff/Global Admin/owner/moderator typing it
  // themselves) while a silence is in effect.
  if (roomSilence.isSilenced(room.id)) return;

  // Only bots that are active members of THIS room chat in it — mirrors how
  // a real member list works, just for the ambient accounts.
  const members = db.prepare(`
    SELECT u.id, u.username FROM room_memberships rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND rm.active = 1 AND u.is_bot = 1
  `).all(room.id);
  if (members.length < 2) return;

  const bank = TOPIC_BANK[room.name] || DEFAULT_BANK;
  const speakerA = pick(members);
  const line = Math.random() < 0.18 ? pick(EMOJI_REACTIONS) : pick(bank);
  postMessage(room.id, { userId: speakerA.id, username: speakerA.username, type: 'text', content: line });

  // Most of the time, someone else chimes in a few seconds later.
  if (Math.random() < 0.65) {
    const others = members.filter((m) => m.id !== speakerA.id);
    if (others.length) {
      const speakerB = pick(others);
      const replyDelay = 3_000 + Math.random() * 7_000;
      const t = setTimeout(() => {
        try {
          const replyLine = Math.random() < 0.18 ? pick(EMOJI_REACTIONS) : pick(REPLY_BANK)(speakerA.username);
          postMessage(room.id, { userId: speakerB.id, username: speakerB.username, type: 'text', content: replyLine });
        } catch (e) { /* never let a bad reply break the loop */ }
      }, replyDelay);
      t.unref?.();
    }
  }
}

// Kicks off ambient chatter. With ~99 rooms and ~1000 bot accounts, ticking
// one single room every 20-75s (the old pace) meant any one room only saw a
// bot say something every half hour or so — dead-feeling. Instead each tick
// now fires a whole BATCH of exchanges (each independently picks its own
// random room, same as before), so a single ~2-4s tick touches a good
// spread of rooms at once — the app reads as continuously, everywhere
// active rather than one room lighting up at a time.
function startAutoChat({ postMessage, minGapMs = 2_000, maxGapMs = 4_000, batchSize = 10 }) {
  if (timer) clearTimeout(timer);

  function tick() {
    for (let i = 0; i < batchSize; i++) {
      try {
        runOneExchange(postMessage);
      } catch (e) { /* never let a bad exchange kill the loop */ }
    }
    const next = minGapMs + Math.random() * (maxGapMs - minGapMs);
    timer = setTimeout(tick, next);
    timer.unref?.(); // don't keep the process alive just for this timer
  }

  timer = setTimeout(tick, 3_000);
  timer.unref?.();
}

function stopAutoChat() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { startAutoChat, stopAutoChat, TOPIC_BANK, REPLY_BANK, pick };

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

// Arabic mirror of REPLY_BANK, used in the 17 Arabic-speaking-country rooms
// (see ARABIC_ROOM_NAMES below) — plain, widely-understood Arabic rather
// than a single country's slang, so it reads naturally across all of them.
const ARABIC_REPLY_BANK = [
  (name) => `والله صدق يا ${name}؟`,
  () => 'نفس الشي عندي بصراحة',
  (name) => `${name} دايم تقول كذا 😂`,
  () => 'ايه صح، بالضبط كذا حاسس',
  (name) => `تسلم يا ${name}`,
  () => 'هههه صح',
  (name) => `${name} حاطني معاكم`,
  () => 'تمام، يعطيك العافية',
  () => 'هههه ايه لاحظت نفس الشي',
  (name) => `${name} كلامك صح فعلا`,
  () => 'بالضبط',
  (name) => `اكيد يا ${name}`,
];

// 17 Arabic-speaking-country rooms (one per country — see COUNTRIES in
// public/app.js) — every other room, including the three custom banks
// above and every other country, stays in English.
const ARABIC_ROOM_NAMES = new Set([
  'Sudan', 'Egypt', 'Morocco', 'Saudi Arabia', 'United Arab Emirates', 'Qatar',
  'Kuwait', 'Jordan', 'Lebanon', 'Iraq', 'Algeria', 'Tunisia', 'Libya', 'Oman',
  'Bahrain', 'Yemen', 'Syria',
]);

// Combinatorial small-talk generation: a small set of templates × a larger
// set of subjects gives thousands of natural-reading unique lines without
// hand-writing each one. Used as the default bank for every room that isn't
// one of the three custom ones above (Lobby / UNO Arena / Chill Zone).
function buildTopicBank(templates, subjects) {
  return templates.flatMap((t) => subjects.map((s) => t.replace('{topic}', s)));
}

const ENGLISH_TOPIC_TEMPLATES = [
  "anyone up for talking about {topic} today?",
  "so what's everyone's take on {topic}?",
  'been thinking about {topic} lately, anyone else?',
  "quick question — who else is into {topic}?",
  '{topic} has been on my mind all day',
  "what's the best thing about {topic} in your opinion?",
  'not gonna lie, I could talk about {topic} for hours',
  'does anyone here actually follow {topic}?',
  'just saw something about {topic}, thoughts?',
  "who's got recommendations for {topic}?",
  'honestly {topic} is underrated',
  'is it just me or is {topic} getting more popular lately?',
  'what got you into {topic} in the first place?',
  '{topic} kind of person here, anyone else?',
  'so random question, favorite thing about {topic}?',
  'anyone want to chat about {topic} for a bit?',
  'curious what people think about {topic}',
  '{topic} is such a good way to pass the time',
  "who else spends way too much time on {topic}",
  "what's your history with {topic}?",
  'been getting more into {topic} recently',
  'any {topic} fans in here?',
  "let's talk {topic} for a sec",
  "what's a good {topic} tip for beginners?",
  'does {topic} interest anyone else here?',
  'so I tried something new with {topic} today',
  '{topic} always puts me in a good mood',
  "what's everyone's opinion on {topic} these days?",
  'just curious, how often do you think about {topic}?',
  '{topic} chat, anyone in?',
];
const ENGLISH_SUBJECTS = [
  'football', 'basketball', 'movies', 'tv shows', 'music', 'cooking', 'baking',
  'travel', 'photography', 'video games', 'board games', 'reading', 'writing',
  'fashion', 'fitness', 'yoga', 'hiking', 'camping', 'gardening', 'coffee',
  'tea', 'art', 'painting', 'dancing', 'singing', 'cars', 'motorcycles',
  'technology', 'gadgets', 'coding', 'anime', 'comics', 'history', 'science',
  'space', 'animals', 'pets', 'fishing', 'swimming', 'cycling', 'running',
  'chess', 'poetry', 'languages', 'architecture', 'design', 'crafts',
];
const ENGLISH_TOPICS_GENERATED = buildTopicBank(ENGLISH_TOPIC_TEMPLATES, ENGLISH_SUBJECTS);

const ARABIC_TOPIC_TEMPLATES = [
  'شو رأيكم في {topic}؟',
  'حد يحب يتكلم عن {topic} اليوم؟',
  'من زمان أفكر في {topic}',
  'مين هنا يحب {topic}؟',
  '{topic} من الأشياء اللي أحبها كثير',
  'إيش أفضل شي في {topic} بنظركم؟',
  'بصراحة أقدر أتكلم عن {topic} لساعات',
  'حد يتابع {topic} هنا؟',
  'شفت شي حلو عن {topic} اليوم',
  'عندكم اقتراحات بخصوص {topic}؟',
  'بصراحة {topic} ما ياخذ حقه',
  'حسيت إن {topic} صار مشهور أكثر مؤخرا',
  'كيف بدأ اهتمامكم بـ {topic}؟',
  'أنا من محبين {topic}، فيه غيري؟',
  'سؤال بسيط، إيش أكثر شي يعجبكم في {topic}؟',
  'ودكم نتكلم شوي عن {topic}؟',
  'فضولي أعرف رأيكم في {topic}',
  '{topic} طريقة حلوة أمرر فيها وقتي',
  'مين غيري يقضي وقت طويل في {topic}؟',
  'إيش قصتكم مع {topic}؟',
  'صرت أهتم أكثر بـ {topic} مؤخرا',
  'فيه محبين {topic} هنا؟',
  'خلونا نتكلم عن {topic} شوي',
  'عندكم نصيحة للمبتدئين في {topic}؟',
  '{topic} يحمسكم ولا لا؟',
];
const ARABIC_SUBJECTS = [
  'كرة القدم', 'كرة السلة', 'الأفلام', 'المسلسلات', 'الموسيقى', 'الطبخ',
  'الحلويات', 'السفر', 'التصوير', 'ألعاب الفيديو', 'ألعاب الطاولة', 'القراءة',
  'الكتابة', 'الموضة', 'اللياقة', 'اليوغا', 'المشي لمسافات طويلة', 'التخييم',
  'الزراعة', 'القهوة', 'الشاي', 'الفن', 'الرسم', 'الرقص', 'الغناء', 'السيارات',
  'الدراجات النارية', 'التقنية', 'الأجهزة الذكية', 'البرمجة', 'الأنمي',
  'القصص المصورة', 'التاريخ', 'العلوم', 'الفضاء', 'الحيوانات',
  'الحيوانات الأليفة', 'صيد السمك', 'السباحة', 'ركوب الدراجات', 'الجري',
  'الشطرنج', 'الشعر', 'اللغات', 'التصميم',
];
const ARABIC_TOPICS_GENERATED = buildTopicBank(ARABIC_TOPIC_TEMPLATES, ARABIC_SUBJECTS);

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

  // The three hand-written banks (Lobby/UNO Arena/Chill Zone) always win;
  // otherwise an Arabic-speaking-country room gets the Arabic combinatorial
  // bank, and every other room (all other countries, any user-created room)
  // gets the English one — both comfortably exceed 1000 unique lines.
  const isArabicRoom = !TOPIC_BANK[room.name] && ARABIC_ROOM_NAMES.has(room.name);
  const bank = TOPIC_BANK[room.name] || (isArabicRoom ? ARABIC_TOPICS_GENERATED : ENGLISH_TOPICS_GENERATED);
  const replyBank = isArabicRoom ? ARABIC_REPLY_BANK : REPLY_BANK;

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
          const replyLine = Math.random() < 0.18 ? pick(EMOJI_REACTIONS) : pick(replyBank)(speakerA.username);
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

module.exports = {
  startAutoChat, stopAutoChat, TOPIC_BANK, REPLY_BANK, pick,
  ARABIC_REPLY_BANK, ARABIC_ROOM_NAMES, ENGLISH_TOPICS_GENERATED, ARABIC_TOPICS_GENERATED,
};

// Roleplay / emote chat commands — "/hug", "/dance", "/8ball", etc.
//
// Each entry in ROLEPLAY_COMMANDS is [command, selfTemplate, targetTemplate].
// - selfTemplate is used when the command is typed with no target ("/wave").
// - targetTemplate is used when a target username follows ("/wave lomi").
//   If a command has no sensible "self" form, selfTemplate falls back to the
//   targetTemplate with the sender named as their own target.
// {user} / {target} are replaced with the (already-bracketed-level) display
// name of the sender / target when the message is posted to room chat.
//
// This list intentionally doesn't try to be a byte-for-byte reproduction of
// any other app's command list — it's an original set covering the same
// categories (greetings, reactions, physical/roleplay actions, and a few
// Bengali-slang ones) requested for MiniPlatform. Adding, renaming, or
// re-wording any single command is just editing one line here — nothing
// else in the app needs to change.
const ROLEPLAY_COMMANDS = [
  // ---- Greetings / presence ----
  ['hi', '{user} says hi to everyone! 👋', '{user} says hi to {target}! 👋'],
  ['hello', '{user} says hello to everyone! 👋', '{user} says hello to {target}! 👋'],
  ['bye', '{user} says bye for now! 👋', '{user} waves bye to {target}! 👋'],
  ['afk', '{user} is now AFK (away from keyboard). 💤', null],
  ['back', '{user} is back! 🙋', null],
  ['brb', '{user} will be right back! ⏳', null],
  ['gtg', '{user} has to go now! 🏃', null],
  ['bbl', '{user} will be back later! 🕑', null],
  ['sleep', '{user} goes to sleep. 😴', null],
  ['wakeup', '{user} wakes up! 🥱', '{user} wakes {target} up! ⏰'],
  ['yawn', '{user} yawns. 🥱', null],

  // ---- Reactions ----
  ['agree', '{user} agrees! 👍', '{user} agrees with {target}! 👍'],
  ['disagree', '{user} disagrees! 👎', '{user} disagrees with {target}! 👎'],
  ['laugh', '{user} laughs out loud! 😂', '{user} laughs with {target}! 😂'],
  ['lol', '{user} says LOL! 😆', null],
  ['smile', '{user} smiles. 🙂', '{user} smiles at {target}. 🙂'],
  ['grin', '{user} grins widely. 😁', null],
  ['cry', '{user} bursts into tears. 😢', '{user} cries on {target}\'s shoulder. 😢'],
  ['sad', '{user} looks sad. 😔', null],
  ['angry', '{user} looks really angry! 😠', '{user} is angry at {target}! 😠'],
  ['shock', '{user} is shocked! 😱', null],
  ['surprised', '{user} looks surprised! 😲', null],
  ['confused', '{user} looks confused. 😕', null],
  ['blush', '{user} blushes. 😳', '{target} makes {user} blush. 😳'],
  ['wink', '{user} winks. 😉', '{user} winks at {target}. 😉'],
  ['eyeroll', '{user} rolls their eyes. 🙄', null],
  ['facepalm', '{user} facepalms. 🤦', null],
  ['shrug', '{user} shrugs. 🤷', null],
  ['bored', '{user} looks bored. 😑', null],
  ['sweat', '{user} breaks a sweat. 😅', null],
  ['scared', '{user} looks scared! 😨', null],
  ['proud', '{user} looks proud! 😤', '{user} is proud of {target}! 😤'],
  ['cool', '{user} is being cool. 😎', null],
  ['think', '{user} is thinking... 🤔', null],
  ['sick', '{user} is feeling sick. 🤒', null],
  ['faint', '{user} faints! 😵', null],

  // ---- Physical / social actions ----
  ['hug', '{user} hugs the air, wishing someone was there. 🤗', '{user} hugs {target}! 🤗'],
  ['kiss', '{user} blows a kiss to everyone! 😘', '{user} kisses {target}! 😘'],
  ['slap', '{user} slaps the air out of frustration! 👋', '{user} slaps {target}! 👋'],
  ['punch', '{user} throws a punch at the air! 👊', '{user} punches {target}! 👊'],
  ['poke', '{user} pokes around. 👉', '{user} pokes {target}! 👉'],
  ['tickle', '{user} wiggles their fingers. 🤏', '{user} tickles {target}! 🤣'],
  ['pat', '{user} pats their own head. 🖐️', '{user} pats {target} on the head. 🖐️'],
  ['nudge', '{user} nudges nobody in particular. 😏', '{user} nudges {target}. 😏'],
  ['highfive', '{user} raises a hand for a high-five! ✋', '{user} high-fives {target}! ✋'],
  ['handshake', '{user} offers a handshake. 🤝', '{user} shakes hands with {target}! 🤝'],
  ['clap', '{user} claps! 👏', '{user} claps for {target}! 👏'],
  ['cheer', '{user} cheers loudly! 🎉', '{user} cheers for {target}! 🎉'],
  ['dance', '{user} starts dancing! 💃', '{user} dances with {target}! 💃'],
  ['sing', '{user} breaks into song! 🎤', '{user} sings to {target}! 🎤'],
  ['bow', '{user} takes a bow. 🙇', '{user} bows to {target}. 🙇'],
  ['salute', '{user} salutes! 🫡', '{user} salutes {target}! 🫡'],
  ['pray', '{user} prays. 🙏', '{user} prays for {target}. 🙏'],
  ['bless', '{user} feels blessed. ✨', '{user} blesses {target}! ✨'],
  ['crown', '{user} crowns themself! 👑', '{user} crowns {target}! 👑'],
  ['cuddle', '{user} wants a cuddle. 🥰', '{user} cuddles {target}! 🥰'],
  ['snuggle', '{user} snuggles up. 🥰', '{user} snuggles with {target}! 🥰'],
  ['love', '{user} spreads some love! ❤️', '{user} sends love to {target}! ❤️'],
  ['glare', '{user} glares into the distance. 😒', '{user} glares at {target}! 😒'],
  ['stare', '{user} stares off into space. 👀', '{user} stares at {target}! 👀'],
  ['wave', '{user} waves! 👋', '{user} waves at {target}! 👋'],
  ['tackle', '{user} charges up for a tackle! 🏃', '{user} tackles {target}! 🏃'],
  ['carry', '{user} looks for someone to carry. 💪', '{user} carries {target}! 💪'],
  ['spin', '{user} spins around! 🌀', '{user} spins {target} around! 🌀'],
  // NOTE: no "/kick" emote here on purpose — "/kick <username>" is already
  // the room-moderation command (see KICK_COMMAND in socket.js).
  ['bite', '{user} bites the air. 😬', '{user} bites {target}! 😬'],

  // ---- Food / drink / misc flavor ----
  ['eat', '{user} is eating. 🍽️', null],
  ['drink', '{user} takes a sip. 🥤', null],
  ['cheers', '{user} raises a glass — cheers! 🥂', '{user} raises a glass to {target} — cheers! 🥂'],
  ['toast', '{user} makes a toast! 🥂', '{user} toasts to {target}! 🥂'],
  ['party', '{user} starts the party! 🎊', null],
  ['smoke', '{user} takes a smoke break. 🚬', null],
  ['yum', '{user} says yum! 😋', null],

  // ---- Free-form ----
  // "/act <anything>" posts a custom third-person action line, e.g.
  // "/act looks around nervously" -> "username looks around nervously".
  ['act', '{user} {arg}', null],
];

// Bengali-slang flavor commands (kept as originally requested — playful,
// not literal translations).
const BENGALI_COMMANDS = [
  ['aish', '{user} says: Aish! 😮'],
  ['ami_beshi', '{user} says: Ami beshi! (I\'m the best!) 😎'],
  ['amio_achi', '{user} says: Amio achi! (I\'m here too!) 🙋'],
  ['apu_go', '{user} says: Apu go! 🏃'],
  ['bujhini', '{user} says: Bujhini! (I don\'t get it!) 🤷'],
  ['charge_nai', '{user} says: Charge nai! (No battery!) 🔋'],
  ['dada_mane', '{user} says: Dada mane... (Big bro means...) 🧑'],
  ['dhur', '{user} says: Dhur! (Ugh!) 😤'],
  ['dhivehi', '{user} says something you don\'t quite catch. 🗣️'],
  ['goru', '{user} yells: Goru! 🐄'],
];

module.exports = { ROLEPLAY_COMMANDS, BENGALI_COMMANDS };

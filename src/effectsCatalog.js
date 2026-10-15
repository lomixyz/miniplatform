// Chat "/purchase effect" store — paid, time-limited chat effect commands
// ("/bomb", "/thunder", ...). Each entry here is both the catalog listing
// (price/emoji/label shown by "/purchase effect") AND the template used
// when an owner actually fires the command ("/bomb" itself) — one place to
// add, reprice, or reword an effect; nothing else needs to change.
//
// `text` is the line posted to room chat (system_message, same treatment as
// a roleplay emote) when the effect fires bare — {user} is replaced with the
// sender's bracketed-level display name. `textTargeted` is used instead when
// fired as "/<key> <username>" (an owned effect aimed at someone) — {user}
// and {target} are both replaced; a falsy `targetable` effect (none here,
// but left as a hook) could opt out and always fall back to `text`.
// `shower` is the set of emoji used for the falling-emoji visual (see
// playEffectShower in app.js); defaults to just the effect's own emoji
// repeated if omitted.
const EFFECTS = [
  { key: 'bomb', emoji: '💣', label: 'Bomb', price: 50000, days: 30, text: '{user} dropped a bomb! 💥', textTargeted: '{user} dropped a bomb on {target}! 💥' },
  { key: 'missile', emoji: '🚀', label: 'Missile', price: 50000, days: 30, text: '{user} launched a missile! 🚀', textTargeted: '{user} launched a missile at {target}! 🚀' },
  { key: 'grenade', emoji: '🍍', label: 'Grenade', price: 50000, days: 30, text: '{user} threw a grenade! 🍍', textTargeted: '{user} threw a grenade at {target}! 🍍' },
  { key: 'love', emoji: '💖', label: 'Love', price: 50000, days: 30, text: '{user} spread some love everywhere! 💖', textTargeted: '{user} sent some love to {target}! 💖' },
  { key: 'bird', emoji: '🐦', label: 'Bird', price: 50000, days: 30, text: '{user} released a flock of birds! 🐦', textTargeted: '{user} sent a flock of birds after {target}! 🐦' },
  { key: 'butterfly', emoji: '🦋', label: 'Butterfly', price: 50000, days: 30, text: '{user} released a swarm of butterflies! 🦋', textTargeted: '{user} sent a swarm of butterflies to {target}! 🦋' },
  { key: 'dragon', emoji: '🐉', label: 'Dragon', price: 50000, days: 30, text: '{user} summoned a dragon! 🐉', textTargeted: '{user} sent a dragon after {target}! 🐉' },
  { key: 'rain', emoji: '🌧️', label: 'Rain', price: 50000, days: 30, text: '{user} made it rain! 🌧️', textTargeted: '{user} made it rain on {target}! 🌧️' },
  { key: 'ghost', emoji: '👻', label: 'Ghost', price: 50000, days: 30, text: '{user} summoned a ghost! 👻', textTargeted: '{user} sent a ghost to haunt {target}! 👻' },
  { key: 'meteor', emoji: '☄️', label: 'Meteor', price: 50000, days: 30, text: '{user} called down a meteor shower! ☄️', textTargeted: '{user} called down a meteor on {target}! ☄️' },
  { key: 'thunder', emoji: '⚡', label: 'Thunder', price: 50000, days: 30, text: '{user} summoned a thunderstorm! 🌩️', textTargeted: '{user} struck {target} with lightning! 🌩️' },
  { key: 'snowball', emoji: '❄️', label: 'Snowball', price: 50000, days: 30, text: '{user} started a snowball fight! ❄️', textTargeted: '{user} hit {target} with a snowball! ❄️' },
  { key: 'tomato', emoji: '🍅', label: 'Tomato', price: 50000, days: 30, text: '{user} threw tomatoes everywhere! 🍅', textTargeted: '{user} threw a tomato at {target}! 🍅' },
  { key: 'laser', emoji: '🔫', label: 'Laser', price: 50000, days: 30, text: '{user} fired a laser! 🔫', textTargeted: '{user} fired a laser at {target}! 🔫' },
  { key: 'firework', emoji: '🎆', label: 'Firework', price: 50000, days: 30, text: '{user} set off fireworks! 🎆', textTargeted: '{user} set off fireworks for {target}! 🎆' },
];

const EFFECTS_BY_KEY = new Map(EFFECTS.map((e) => [e.key, e]));

module.exports = { EFFECTS, EFFECTS_BY_KEY };

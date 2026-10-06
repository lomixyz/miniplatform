// Chat "/purchase effect" store — paid, time-limited chat effect commands
// ("/bomb", "/thunder", ...). Each entry here is both the catalog listing
// (price/emoji/label shown by "/purchase effect") AND the template used
// when an owner actually fires the command ("/bomb" itself) — one place to
// add, reprice, or reword an effect; nothing else needs to change.
//
// `text` is the line posted to room chat (system_message, same treatment as
// a roleplay emote) when the effect fires — {user} is replaced with the
// sender's bracketed-level display name. `shower` is the set of emoji used
// for the falling-emoji visual (see playEffectShower in app.js); defaults
// to just the effect's own emoji repeated if omitted.
const EFFECTS = [
  { key: 'bomb', emoji: '💣', label: 'Bomb', price: 50000, days: 30, text: '{user} dropped a bomb! 💥' },
  { key: 'missile', emoji: '🚀', label: 'Missile', price: 50000, days: 30, text: '{user} launched a missile! 🚀' },
  { key: 'grenade', emoji: '🍍', label: 'Grenade', price: 50000, days: 30, text: '{user} threw a grenade! 🍍' },
  { key: 'love', emoji: '💖', label: 'Love', price: 50000, days: 30, text: '{user} spread some love everywhere! 💖' },
  { key: 'bird', emoji: '🐦', label: 'Bird', price: 50000, days: 30, text: '{user} released a flock of birds! 🐦' },
  { key: 'butterfly', emoji: '🦋', label: 'Butterfly', price: 50000, days: 30, text: '{user} released a swarm of butterflies! 🦋' },
  { key: 'dragon', emoji: '🐉', label: 'Dragon', price: 50000, days: 30, text: '{user} summoned a dragon! 🐉' },
  { key: 'rain', emoji: '🌧️', label: 'Rain', price: 50000, days: 30, text: '{user} made it rain! 🌧️' },
  { key: 'ghost', emoji: '👻', label: 'Ghost', price: 50000, days: 30, text: '{user} summoned a ghost! 👻' },
  { key: 'meteor', emoji: '☄️', label: 'Meteor', price: 50000, days: 30, text: '{user} called down a meteor shower! ☄️' },
  { key: 'thunder', emoji: '⚡', label: 'Thunder', price: 50000, days: 30, text: '{user} summoned a thunderstorm! 🌩️' },
  { key: 'snowball', emoji: '❄️', label: 'Snowball', price: 50000, days: 30, text: '{user} started a snowball fight! ❄️' },
  { key: 'tomato', emoji: '🍅', label: 'Tomato', price: 50000, days: 30, text: '{user} threw tomatoes everywhere! 🍅' },
  { key: 'laser', emoji: '🔫', label: 'Laser', price: 50000, days: 30, text: '{user} fired a laser! 🔫' },
  { key: 'firework', emoji: '🎆', label: 'Firework', price: 50000, days: 30, text: '{user} set off fireworks! 🎆' },
];

const EFFECTS_BY_KEY = new Map(EFFECTS.map((e) => [e.key, e]));

module.exports = { EFFECTS, EFFECTS_BY_KEY };

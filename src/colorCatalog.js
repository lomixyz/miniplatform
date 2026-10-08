// Color Shop catalog (tiered redesign) — 8 purchasable username-color tiers,
// each with its own badge icon, a 2-color ring (used for the shop card's top
// strip and the small round badge shown next to the username everywhere),
// a duration, an optional "bold" display flag, and a "voice" perk flag (just
// the little mic icon on the shop card — Mafia is the one tier without it).
// Mirrored on the client as COLOR_TIERS in public/app.js (same pattern as
// EFFECT_THEME mirrors src/effectsCatalog.js) so chat/participant rendering
// doesn't need a round trip to look up a badge's colors.
const COLOR_TIERS = [
  { key: 'king', name: 'King', price: 400000, days: 30, bold: true, hex: '#22d3ee', ring1: '#22d3ee', ring2: '#0e7490', icon: '👑', voicePerk: true, order: 1 },
  { key: 'queen', name: 'Queen', price: 300000, days: 30, bold: true, hex: '#f472b6', ring1: '#f472b6', ring2: '#be185d', icon: '👑', voicePerk: true, order: 2 },
  { key: 'mafia', name: 'Mafia', price: 250000, days: 30, bold: false, hex: '#fb7185', ring1: '#fb7185', ring2: '#9f1239', icon: '🎩', voicePerk: false, order: 3 },
  { key: 'vip', name: 'Vip', price: 300000, days: 40, bold: true, hex: '#fb7185', ring1: '#fb7185', ring2: '#be123c', icon: '🏅', voicePerk: true, order: 4 },
  { key: 'diamond', name: 'Diamond', price: 200000, days: 30, bold: false, hex: '#38bdf8', ring1: '#38bdf8', ring2: '#0369a1', icon: '💎', voicePerk: true, order: 5 },
  { key: 'premium', name: 'Premium', price: 150000, days: 30, bold: true, hex: '#facc15', ring1: '#facc15', ring2: '#a16207', icon: '🅿️', voicePerk: true, order: 6 },
  { key: 'supporter', name: 'Supporter', price: 100000, days: 30, bold: false, hex: '#38bdf8', ring1: '#38bdf8', ring2: '#1d4ed8', icon: '🆂', voicePerk: true, order: 7 },
  { key: 'streamer', name: 'Streamer', price: 100000, days: 30, bold: false, hex: '#fb7185', ring1: '#fb7185', ring2: '#86198f', icon: '🎥', voicePerk: true, order: 8 },
];
const COLOR_TIERS_BY_KEY = new Map(COLOR_TIERS.map((t) => [t.key, t]));

module.exports = { COLOR_TIERS, COLOR_TIERS_BY_KEY };

// Real, honest Achievements system (My Profile -> tap the "Badges" stat
// tile). Deliberately separate from the Badge Store/Badge Panel (Explore
// hub) — that's a coins-for-cosmetics shop (routes/badges.js, badges_catalog
// table) and stays untouched; this is a progress/unlock view with no
// purchasing anywhere in it. Every number here comes from a real column or
// query — nothing is a placeholder. A metric this app genuinely has no way
// to track (Followers, Following, Votes, seasonal Events) is simply absent
// rather than shown with a made-up value; the "events" category is kept so
// its real, honest count (currently always 0) is visible instead of silently
// dropped.
const db = require('./db');

function messagesCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = ?').get(userId).c;
}
function roomsJoinedCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM room_memberships WHERE user_id = ?').get(userId).c;
}
function giftsReceivedCount(userId) {
  return db.prepare("SELECT COUNT(*) c FROM coin_transactions WHERE user_id = ? AND category = 'gifts' AND delta > 0").get(userId).c;
}
function friendsCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM friendships
    WHERE (requester_id = ? OR addressee_id = ?) AND status = 'accepted'
  `).get(userId, userId).c;
}
function profileViewsCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM profile_visits WHERE visited_id = ?').get(userId).c;
}
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

const CATEGORIES = [
  { key: 'social', label: 'Social', icon: '💬' },
  { key: 'gift', label: 'Gift', icon: '🎁' },
  { key: 'games', label: 'Games', icon: '🎮' },
  { key: 'level', label: 'Level & Time', icon: '⭐' },
  { key: 'special', label: 'Special', icon: '🍀' },
  { key: 'events', label: 'Events', icon: '🎉' }, // no event system exists yet — always empty, honestly, rather than hidden
];

// tiers are ascending real thresholds; "special" ones are a single
// binary unlock (a role flag going true), not a counted metric.
const ACHIEVEMENTS = [
  { key: 'chatterbox', category: 'social', icon: '💬', name: 'Chatterbox', unit: 'messages sent in rooms', tiers: [50, 200, 500, 1000], metric: (u) => messagesCount(u.id) },
  { key: 'social_butterfly', category: 'social', icon: '🦋', name: 'Social Butterfly', unit: 'friends', tiers: [5, 10, 25, 50], metric: (u) => friendsCount(u.id) },
  { key: 'room_hopper', category: 'social', icon: '🚪', name: 'Room Hopper', unit: 'rooms joined', tiers: [10, 25, 50, 100], metric: (u) => roomsJoinedCount(u.id) },
  { key: 'popular', category: 'social', icon: '⭐', name: 'Popular', unit: 'profile views', tiers: [10, 50, 100, 250], metric: (u) => profileViewsCount(u.id) },

  { key: 'gift_giver', category: 'gift', icon: '🎁', name: 'Gift Giver', unit: 'gifts sent', tiers: [50, 200, 1000, 5000], metric: (u) => u.gifts_sent_count || 0 },
  { key: 'crowd_favorite', category: 'gift', icon: '💖', name: 'Crowd Favorite', unit: 'gifts received', tiers: [50, 200, 1000, 5000], metric: (u) => giftsReceivedCount(u.id) },
  { key: 'big_spender', category: 'gift', icon: '💰', name: 'Big Spender', unit: 'coins spent on gifts', tiers: [10000, 100000, 1000000], metric: (u) => u.total_spent || 0 },

  { key: 'game_winner', category: 'games', icon: '🏆', name: 'Game Winner', unit: 'games won', tiers: [5, 25, 100], metric: (u) => u.games_won_count || 0 },

  { key: 'rising_star', category: 'level', icon: '🌟', name: 'Rising Star', unit: 'level reached', tiers: [10, 25, 50, 100], metric: (u) => u.level || 1 },
  { key: 'veteran', category: 'level', icon: '🎖️', name: 'Veteran', unit: 'days as a member', tiers: [30, 180, 365], metric: (u) => daysSince(u.created_at) },

  { key: 'mentor', category: 'special', icon: '🧭', name: 'Mentor', special: true, desc: 'Become a Mentor', unlocked: (u) => !!u.is_mentor },
  { key: 'merchant', category: 'special', icon: '🏪', name: 'Merchant', special: true, desc: 'Become a Merchant', unlocked: (u) => !!u.is_merchant },
  { key: 'elite', category: 'special', icon: '🏅', name: 'Elite', special: true, desc: 'Become an Elite User', unlocked: (u) => !!u.is_elite },
  { key: 'staff', category: 'special', icon: '🛡️', name: 'Staff', special: true, desc: 'Join the Staff team', unlocked: (u) => !!u.is_staff },
  { key: 'country_rep', category: 'special', icon: '🌐', name: 'Country Rep', special: true, desc: 'Become a Country Representative', unlocked: (u) => !!u.is_country_rep },
  { key: 'exec_board', category: 'special', icon: '👑', name: 'Executive', special: true, desc: 'Join the Executive Board', unlocked: (u) => !!u.is_exec_board },
];

function formatNum(n) {
  if (n >= 1000000) return (n % 1000000 === 0 ? n / 1000000 : (n / 1000000).toFixed(1)) + 'M';
  if (n >= 1000) return (n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)) + 'K';
  return String(n);
}

function tierProgress(def, u) {
  if (def.special) {
    const done = !!def.unlocked(u);
    return {
      key: def.key, category: def.category, icon: def.icon, name: def.name,
      desc: def.desc, special: true, unlockedTiers: done ? 1 : 0, totalTiers: 1,
      maxed: done, value: done ? 1 : 0, target: 1, pct: done ? 100 : 0, tierThresholds: [1],
    };
  }
  const value = def.metric(u) || 0;
  const tiers = def.tiers;
  let reachedIdx = -1;
  for (let i = 0; i < tiers.length; i++) { if (value >= tiers[i]) reachedIdx = i; }
  const maxed = reachedIdx === tiers.length - 1;
  const nextIdx = maxed ? tiers.length - 1 : reachedIdx + 1;
  const target = tiers[nextIdx];
  const prevTarget = nextIdx > 0 ? tiers[nextIdx - 1] : 0;
  const pct = maxed ? 100 : Math.max(0, Math.min(100, Math.round(((value - prevTarget) / (target - prevTarget)) * 100)));
  return {
    key: def.key, category: def.category, icon: def.icon, name: def.name,
    desc: `${formatNum(target)} ${def.unit}`, special: false,
    unlockedTiers: reachedIdx + 1, totalTiers: tiers.length, maxed,
    value, target, pct, tierThresholds: tiers,
  };
}

// u must carry: id, xp-derived level, gifts_sent_count, total_spent,
// games_won_count, created_at, and the role flags (is_mentor etc.) — i.e.
// the raw users row plus a computed `level` field.
function buildAchievements(u) {
  const items = ACHIEVEMENTS.map((def) => tierProgress(def, u));
  const byCategory = {};
  CATEGORIES.forEach((c) => { byCategory[c.key] = { ...c, items: [], unlocked: 0, total: 0 }; });
  items.forEach((it) => {
    const bucket = byCategory[it.category];
    bucket.items.push(it);
    bucket.unlocked += it.unlockedTiers;
    bucket.total += it.totalTiers;
  });
  const totalUnlocked = items.reduce((s, it) => s + it.unlockedTiers, 0);
  const totalBadges = items.reduce((s, it) => s + it.totalTiers, 0);
  return {
    totalUnlocked, totalBadges,
    categories: CATEGORIES.map((c) => byCategory[c.key]),
  };
}

module.exports = { buildAchievements, formatNum };

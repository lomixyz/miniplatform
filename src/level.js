// Simple XP -> level curve. Level 1 starts at 0 xp; each subsequent level
// costs 50 more xp than the last (100, 150, 200, ...).
function levelFromXp(xp) {
  xp = Math.max(0, xp | 0);
  let level = 1;
  let remaining = xp;
  let need = 100;
  while (remaining >= need) {
    remaining -= need;
    level++;
    need += 50;
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: need, totalXp: xp };
}

// Inverse of levelFromXp: the minimum total xp needed to BE at exactly this
// level (xpIntoLevel = 0). Used when an admin sets a user's level directly.
function xpForLevel(level) {
  level = Math.max(1, level | 0);
  let xp = 0;
  let need = 100;
  for (let l = 1; l < level; l++) {
    xp += need;
    need += 50;
  }
  return xp;
}

// XP awarded for various actions — tweak freely.
const XP_REWARDS = {
  CHAT_MESSAGE: 2,
  GIFT_SENT: 5,
  GIFT_RECEIVED: 5,
  GIFT_SHOWER: 10,
};

module.exports = { levelFromXp, xpForLevel, XP_REWARDS };

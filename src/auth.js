const { levelFromXp } = require('./level');

// A purchased Color Shop color is locked in (can't be reset/replaced) for
// this many days from the purchase timestamp — see routes/colors.js.
const COLOR_LOCK_DAYS = 30;

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// requireFlag('staff') passes if the user has is_staff; requireFlag('staff','global_admin')
// passes if the user has EITHER flag (i.e. any of the listed flags is truthy).
const FLAG_MAP = {
  staff: 'is_staff', global_admin: 'is_global_admin', mentor: 'is_mentor', merchant: 'is_merchant',
  exec_board: 'is_exec_board', country_rep: 'is_country_rep', elite: 'is_elite',
};
function requireFlag(...flags) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.status(401).json({ error: 'Not logged in' });
    const ok = flags.some((f) => !!u[FLAG_MAP[f]]);
    if (!ok) return res.status(403).json({ error: 'Forbidden: insufficient privileges' });
    next();
  };
}

// Returns an ISO timestamp string while a purchased username color is still
// locked (< COLOR_LOCK_DAYS since it was bought), or null once it's free to
// change again / was never bought. Purely a read — routes/colors.js does the
// actual enforcement, this just lets the client show "locked until X".
function colorLockedUntil(boughtAt) {
  if (!boughtAt) return null;
  const boughtMs = new Date(boughtAt.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(boughtMs)) return null;
  const unlockMs = boughtMs + COLOR_LOCK_DAYS * 24 * 60 * 60 * 1000;
  return unlockMs > Date.now() ? new Date(unlockMs).toISOString() : null;
}

// Shape a raw DB user row into what's safe/useful to send to the client,
// including the derived level/progress from their stored xp.
function publicUser(row) {
  if (!row) return null;
  const { level, xpIntoLevel, xpForNextLevel } = levelFromXp(row.xp || 0);
  return {
    id: row.id,
    username: row.username,
    is_staff: !!row.is_staff,
    is_global_admin: !!row.is_global_admin,
    is_mentor: !!row.is_mentor,
    is_merchant: !!row.is_merchant,
    is_exec_board: !!row.is_exec_board,
    is_country_rep: !!row.is_country_rep,
    is_elite: !!row.is_elite,
    coins: row.coins,
    xp: row.xp || 0,
    level,
    xpIntoLevel,
    xpForNextLevel,
    bio: row.bio || '',
    uno_wins: row.uno_wins || 0,
    total_spent: row.total_spent || 0,
    gifts_sent_count: row.gifts_sent_count || 0,
    username_color: row.username_color || null,
    avatar_frame_color: row.avatar_frame_color || null,
    avatar_pet: row.avatar_pet || null,
    avatar_scene: row.avatar_scene || null,
    country: row.country || null,
    email: row.email || null,
    gender: row.gender || null,
    referrer_user_id: row.referrer_user_id || null,
    created_at: row.created_at || null,
    status: row.status === 'away' || row.status === 'busy' ? row.status : 'online',
    username_color_locked_until: colorLockedUntil(row.username_color_bought_at),
  };
}

module.exports = { requireLogin, requireFlag, publicUser, FLAG_MAP, COLOR_LOCK_DAYS, colorLockedUntil };

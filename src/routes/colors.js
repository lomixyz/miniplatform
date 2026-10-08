const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser } = require('../auth');
const { COLOR_TIERS_BY_KEY } = require('../colorCatalog');

const router = express.Router();

// ---------------------------------------------------------------------
// Color Shop (tiered redesign) — King/Queen/Mafia/Vip/Diamond/Premium/
// Supporter/Streamer, each purchasable, each with its own expiry, and a
// user can own several at once. Role-granted colors (Merchant, Elite,
// Mentor, Executive Board, Country Rep, Global Admin — Staff is excluded,
// its gradient always wins and can't be bought over or toggled off) show
// up in the same "My Owned Colors" list for as long as the role flag is
// held. Exactly one entry — purchased or role — can be the active one at a
// time (users.active_color_key); toggling it off goes back to the old
// automatic default (highest-priority held role, or nothing).
// ---------------------------------------------------------------------

const ROLE_COLOR_DEFS = [
  // Listed in the same priority order roleClass()/roleIcon() in app.js use
  // for the automatic default (staff is handled separately, above all of
  // these, and never appears in this list — see the comment above).
  { key: 'exec_board', flag: 'is_exec_board', name: 'Executive Board', hex: '#6366f1', ring1: '#6366f1', ring2: '#4338ca', icon: '🎖️' },
  { key: 'global_admin', flag: 'is_global_admin', name: 'Global Admin', hex: '#facc15', ring1: '#facc15', ring2: '#a16207', icon: '🛡️' },
  { key: 'country_rep', flag: 'is_country_rep', name: 'Country Rep', hex: '#b45309', ring1: '#b45309', ring2: '#78350f', icon: '🌐' },
  { key: 'elite', flag: 'is_elite', name: 'Elite', hex: '#14b8a6', ring1: '#14b8a6', ring2: '#0f766e', icon: '🏅' },
  { key: 'mentor', flag: 'is_mentor', name: 'Mentor', hex: '#ef4444', ring1: '#ef4444', ring2: '#b91c1c', icon: '🧭' },
  { key: 'merchant', flag: 'is_merchant', name: 'Merchant', hex: '#a855f7', ring1: '#a855f7', ring2: '#7e22ce', icon: '🅼' },
];

function roleColorLabel(def, user) {
  // "Elite Male" / "Elite Female" — same gendered naming the reference
  // design uses — falls back to the plain role name if gender isn't set.
  if (def.key === 'elite' && (user.gender === 'male' || user.gender === 'female')) {
    return `Elite ${user.gender === 'male' ? 'Male' : 'Female'}`;
  }
  return def.name;
}

// Everything this user currently qualifies to show (role perks they hold +
// non-expired purchased tiers), each flagged `active` against their single
// active_color_key. `active_color_key` itself being NULL doesn't mean
// nothing is active — it means "automatic", which resolves client-side to
// the same highest-priority-role default roleClass() always used; we still
// mark that implied entry active here so the shop's toggle row matches
// what's actually showing on the user's name right now.
function myOwnedColors(user) {
  const entries = [];
  for (const def of ROLE_COLOR_DEFS) {
    if (user[def.flag]) {
      entries.push({
        key: def.key, kind: 'role', name: roleColorLabel(def, user),
        hex: def.hex, ring1: def.ring1, ring2: def.ring2, icon: def.icon,
        expiresAt: null, // role perks last as long as the role does — no purchase countdown
      });
    }
  }
  const purchased = db.prepare(
    "SELECT color_id, expires_at FROM user_colors WHERE user_id = ? AND expires_at > datetime('now')"
  ).all(user.id);
  for (const row of purchased) {
    const tier = COLOR_TIERS_BY_KEY.get(row.color_id);
    if (!tier) continue;
    entries.push({
      key: tier.key, kind: 'purchased', name: tier.name,
      hex: tier.hex, ring1: tier.ring1, ring2: tier.ring2, icon: tier.icon,
      expiresAt: row.expires_at,
    });
  }

  // Resolve which one is effectively active: the explicit toggle if it still
  // points at something owned, else the automatic top-priority role (same
  // order as ROLE_COLOR_DEFS), else nothing.
  let effectiveKey = user.active_color_key && entries.some((e) => e.key === user.active_color_key)
    ? user.active_color_key
    : null;
  if (!effectiveKey && !user.active_color_key) {
    const topRole = ROLE_COLOR_DEFS.find((def) => user[def.flag]);
    if (topRole) effectiveKey = topRole.key;
  }
  return entries.map((e) => ({ ...e, active: e.key === effectiveKey }));
}

// GET /api/colors — the whole Color Shop screen in one call: the 8-tier
// catalog (with ownership/expiry per tier) and the user's owned-colors list.
router.get('/', requireLogin, (req, res) => {
  db.clearExpiredActiveColor(req.session.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const catalogRows = db.prepare('SELECT * FROM color_catalog ORDER BY sort_order ASC, cost ASC').all();
  const ownedMap = new Map(
    db.prepare("SELECT color_id, expires_at FROM user_colors WHERE user_id = ? AND expires_at > datetime('now')")
      .all(user.id).map((r) => [r.color_id, r.expires_at])
  );
  const catalog = catalogRows.map((c) => ({
    id: c.id, name: c.name, hex: c.hex, cost: c.cost, icon: c.icon, ring1: c.ring1, ring2: c.ring2,
    days: c.days, bold: !!c.bold, voicePerk: !!c.voice_perk,
    owned: ownedMap.has(c.id), expiresAt: ownedMap.get(c.id) || null,
  }));
  res.json({ catalog, myColors: myOwnedColors(user) });
});

// Staff-only: change a tier's price.
router.post('/:id/price', requireFlag('staff'), (req, res) => {
  const item = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'No such color' });
  const cost = Math.round(Number(req.body && req.body.cost));
  if (!Number.isFinite(cost) || cost < 1 || cost > 5_000_000) {
    return res.status(400).json({ error: 'Cost must be a whole number between 1 and 5,000,000' });
  }
  db.prepare('UPDATE color_catalog SET cost = ? WHERE id = ?').run(cost, item.id);
  const updated = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(item.id);
  res.json({ item: updated });
});

// Buy (or extend) a tier — deducts coins, inserts/extends the user_colors
// row by the tier's `days`, and auto-activates it (matches the old shop's
// "Buy -> Equipped" feel; the user can toggle it off afterward if they'd
// rather keep showing something else).
router.post('/:id/buy', requireLogin, (req, res) => {
  const tier = db.prepare('SELECT * FROM color_catalog WHERE id = ?').get(req.params.id);
  if (!tier) return res.status(404).json({ error: 'No such color' });

  const userId = req.session.user.id;
  const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  if (!row) return res.status(404).json({ error: 'User not found' });
  if (row.coins < tier.cost) {
    return res.status(400).json({ error: `Not enough coins — ${tier.name} costs ${tier.cost.toLocaleString()}` });
  }

  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(tier.cost, userId);
  db.logCoinTx(userId, -tier.cost, 'other', `Bought ${tier.name} color (Color Shop)`);

  // Extend from "now" if already owned-and-active, otherwise from "now" too
  // (a lapsed/expired tier is just bought fresh) — either way the new
  // expiry is always `days` out from this purchase moment.
  db.prepare(`
    INSERT INTO user_colors (user_id, color_id, purchased_at, expires_at)
    VALUES (?, ?, datetime('now'), datetime('now', '+' || ? || ' days'))
    ON CONFLICT(user_id, color_id) DO UPDATE SET expires_at = datetime('now', '+' || ? || ' days'), purchased_at = datetime('now')
  `).run(userId, tier.id, tier.days, tier.days);

  db.prepare('UPDATE users SET active_color_key = ? WHERE id = ?').run(tier.id, userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated), myColors: myOwnedColors(updated) });
});

// Toggle one owned color (purchased or role) on/off. Turning one ON turns
// any other off (only one active_color_key at a time); turning the
// currently-active one OFF clears it back to NULL (automatic default).
router.post('/:key/toggle', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const key = req.params.key;
  const on = !!(req.body && req.body.on);

  const owned = myOwnedColors(user);
  const entry = owned.find((e) => e.key === key);
  if (!entry) return res.status(400).json({ error: "You don't own that color" });

  if (on) {
    db.prepare('UPDATE users SET active_color_key = ? WHERE id = ?').run(key, userId);
  } else if (user.active_color_key === key) {
    db.prepare('UPDATE users SET active_color_key = NULL WHERE id = ?').run(userId);
  }
  // Turning OFF a color that was only implicitly active (active_color_key
  // was already NULL, e.g. the automatic top role) is a no-op by design —
  // there's nothing to clear, the automatic default just keeps applying.

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated), myColors: myOwnedColors(updated) });
});

// Kept as a plain alias for "turn off whatever's active" — nothing in the
// client calls this anymore (the toggle switches replaced it), but it's a
// harmless, backward-compatible no-op-safe endpoint to leave in place.
router.post('/reset', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  db.prepare('UPDATE users SET active_color_key = NULL WHERE id = ?').run(userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);
  res.json({ user: publicUser(updated), myColors: myOwnedColors(updated) });
});

// ---- Staff Gradient (Settings -> Color Shop -> Staff Gradient) ----
// Staff-only perk: pick your own 5-8 color mix for your username, instead of
// the fixed 3-color green/blue/red .role-staff gradient everyone else gets.
// Free (no Color Shop cost/lock) — it's a role perk, not a purchase.
const HEX_RE = /^#[0-9a-f]{6}$/i;
router.post('/gradient', requireFlag('staff'), (req, res) => {
  const userId = req.session.user.id;
  const colors = Array.isArray(req.body && req.body.colors) ? req.body.colors.map((c) => String(c || '').trim()) : [];
  if (colors.length < 5 || colors.length > 8) {
    return res.status(400).json({ error: 'Pick between 5 and 8 colors for your gradient' });
  }
  if (!colors.every((c) => HEX_RE.test(c))) {
    return res.status(400).json({ error: 'Every color must be a valid hex code, e.g. #22c55e' });
  }
  db.prepare('UPDATE users SET username_gradient = ? WHERE id = ?').run(JSON.stringify(colors), userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

// Back to the default 3-color Staff gradient.
router.post('/gradient/reset', requireFlag('staff'), (req, res) => {
  const userId = req.session.user.id;
  db.prepare('UPDATE users SET username_gradient = NULL WHERE id = ?').run(userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  const refresh = req.app.get('refreshUserPresence');
  if (refresh) refresh(userId);

  res.json({ user: publicUser(updated) });
});

module.exports = router;

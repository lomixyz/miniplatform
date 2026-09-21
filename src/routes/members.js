const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// The Members directory (Explore → Members) groups accounts by role instead
// of dumping every user — same "don't list everyone" reasoning as the Admin
// Panel and Give Coins search, just organized as fixed category buckets
// instead of a search box, since role membership is usually small.
//
// "Top Level Users" isn't a granted role — it's a computed top-10-by-level
// leaderboard, listed alongside the real roles because that's where the
// reference design puts it.
const ROLE_GROUPS = [
  { key: 'exec_board', label: 'Executive Board', column: 'is_exec_board', section: 'Staff & Admin' },
  { key: 'global_admin', label: 'Admin', column: 'is_global_admin', section: 'Staff & Admin' },
  { key: 'country_rep', label: 'Country Representative', column: 'is_country_rep', section: 'Staff & Admin' },
  { key: 'staff', label: 'Staff', column: 'is_staff', section: 'Staff & Admin' },
  { key: 'elite', label: 'Elite User', column: 'is_elite', section: 'Staff & Admin' },
  { key: 'mentor', label: 'Mentor', column: 'is_mentor', section: 'Community' },
  { key: 'merchant', label: 'Merchant', column: 'is_merchant', section: 'Community' },
  { key: 'top_level', label: 'Top Level Users', column: null, section: 'Community' },
];

// List of groups with just counts — cheap, used to render the category list.
router.get('/', requireLogin, (req, res) => {
  const groups = ROLE_GROUPS.map((g) => {
    const count = g.column
      ? db.prepare(`SELECT COUNT(*) c FROM users WHERE ${g.column} = 1`).get().c
      : 10; // Top Level Users is always a fixed top-10 list
    return { key: g.key, label: g.label, section: g.section, count };
  });
  res.json({ groups });
});

// The actual member list for one category.
router.get('/:key', requireLogin, (req, res) => {
  const group = ROLE_GROUPS.find((g) => g.key === req.params.key);
  if (!group) return res.status(404).json({ error: 'Unknown member group' });

  const rows = group.column
    ? db.prepare(`SELECT * FROM users WHERE ${group.column} = 1 ORDER BY username COLLATE NOCASE LIMIT 200`).all()
    : db.prepare('SELECT * FROM users ORDER BY xp DESC LIMIT 10').all();

  res.json({ label: group.label, users: rows.map(publicUser) });
});

module.exports = router;

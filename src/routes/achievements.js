const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const { levelFromXp } = require('../level');
const { buildAchievements } = require('../achievements');

const router = express.Router();

// My Profile -> "Badges" stat tile. Always the CURRENT user's own progress —
// achievements aren't shown on someone else's profile (same reasoning as
// Friends/Views on renderUserProfile: no public endpoint exposes this).
router.get('/', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return res.status(404).json({ error: 'User not found' });
  const { level } = levelFromXp(row.xp || 0);
  res.json(buildAchievements({ ...row, level }));
});

module.exports = router;

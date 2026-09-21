const express = require('express');
const db = require('../db');
const { requireFlag, publicUser } = require('../auth');

const router = express.Router();

// Staff, Mentor, and Merchant can all hand out coins to a user directly (a
// reward, a prize, a correction) — separate from the Admin Panel, which stays
// Staff-only for role/level management. Nothing is listed until searched, same
// reasoning as the Admin Panel: dumping every user doesn't scale.
router.get('/search', requireFlag('staff', 'mentor', 'merchant'), (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [], query: '' });
  const rows = db.prepare('SELECT * FROM users WHERE username LIKE ? ORDER BY username COLLATE NOCASE LIMIT 20')
    .all(`%${q}%`);
  res.json({ users: rows.map(publicUser), query: q });
});

router.post('/:id/give', requireFlag('staff', 'mentor', 'merchant'), (req, res) => {
  const targetId = Number(req.params.id);
  const amount = Math.round(Number(req.body && req.body.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'Amount must be a whole number between 1 and 100000' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);

  const giver = req.session.user;
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)')
    .run(targetId, 'coins', `${giver.username} sent you coins!`, `${giver.username} gave you ${amount} coins.`);

  // Live-push the new balance and an alert ping to the recipient if they're online.
  // This is a personal notice, not a room event — it's pushed via 'personal_notice'
  // (toast only) rather than 'system_message', so it never gets dropped into
  // whatever room chat the recipient happens to have open right now.
  const io = req.app.get('io');
  if (io) {
    for (const [, s] of io.sockets.sockets) {
      if (s.data.user && s.data.user.id === targetId) {
        s.emit('coins_update', { coins: updated.coins });
        s.emit('personal_notice', `🪙 ${giver.username} gave you ${amount} coins!`);
      }
    }
  }

  res.json({ user: publicUser(updated) });
});

module.exports = router;

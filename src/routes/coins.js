const express = require('express');
const db = require('../db');
const { requireFlag, requireLogin, publicUser } = require('../auth');

const router = express.Router();

// My Balance (Settings -> My Balance): current balance, today's earned/spent
// totals, and a recent activity feed — built entirely from the
// coin_transactions ledger (see db.logCoinTx), optionally filtered to one
// category to match the Activity screen's tabs (All/Games/Gifts/Transfers/Other).
const VALID_CATEGORIES = new Set(['games', 'gifts', 'transfers', 'other']);
router.get('/activity', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const category = VALID_CATEGORIES.has(req.query.category) ? req.query.category : null;

  const balanceRow = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId);
  const todayTotals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS earned,
      COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS spent
    FROM coin_transactions
    WHERE user_id = ? AND date(created_at) = date('now')
  `).get(userId);

  const rows = category
    ? db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? AND category = ? ORDER BY id DESC LIMIT 100').all(userId, category)
    : db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(userId);

  res.json({
    coins: balanceRow ? balanceRow.coins : 0,
    earnedToday: todayTotals.earned,
    spentToday: todayTotals.spent,
    activity: rows,
  });
});

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
  const giver = req.session.user;
  // Staff (and Global Admin) can hand out much larger amounts than a plain
  // Mentor/Merchant — this route stays open to all three roles, but the
  // upper bound now scales with how trusted the role is.
  const maxAmount = (giver.is_staff || giver.is_global_admin) ? 100_000_000 : 100_000;
  if (!Number.isFinite(amount) || amount < 1 || amount > maxAmount) {
    return res.status(400).json({ error: `Amount must be a whole number between 1 and ${maxAmount.toLocaleString('en-US')}` });
  }
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, targetId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  db.logCoinTx(targetId, amount, 'transfers', `Received from ${giver.username}`);
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

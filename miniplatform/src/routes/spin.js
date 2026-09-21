const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');
const xpStore = require('../xp');

const router = express.Router();

const SPIN_COOLDOWN_HOURS = 24;

// Weighted prize table — small/common coin prizes are far more likely than
// the big xp jackpot, same "mostly small, occasionally great" shape as a
// real spin wheel.
const PRIZES = [
  { type: 'coins', amount: 10, weight: 30 },
  { type: 'coins', amount: 25, weight: 20 },
  { type: 'coins', amount: 50, weight: 12 },
  { type: 'coins', amount: 100, weight: 4 },
  { type: 'xp', amount: 10, weight: 20 },
  { type: 'xp', amount: 25, weight: 10 },
  { type: 'xp', amount: 50, weight: 4 },
];
const TOTAL_WEIGHT = PRIZES.reduce((s, p) => s + p.weight, 0);

function pickPrize() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const p of PRIZES) {
    if (roll < p.weight) return p;
    roll -= p.weight;
  }
  return PRIZES[0];
}

function secondsUntilNextSpin(lastSpinAt) {
  if (!lastSpinAt) return 0;
  const last = new Date(lastSpinAt.replace(' ', 'T') + 'Z').getTime();
  const nextAt = last + SPIN_COOLDOWN_HOURS * 3600_000;
  return Math.max(0, Math.round((nextAt - Date.now()) / 1000));
}

router.get('/status', requireLogin, (req, res) => {
  const row = db.prepare('SELECT last_spin_at FROM users WHERE id = ?').get(req.session.user.id);
  const secondsLeft = secondsUntilNextSpin(row && row.last_spin_at);
  res.json({ canSpin: secondsLeft === 0, secondsLeft, prizes: PRIZES.map((p) => ({ type: p.type, amount: p.amount })) });
});

router.post('/play', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const row = db.prepare('SELECT last_spin_at, coins FROM users WHERE id = ?').get(userId);
  const secondsLeft = secondsUntilNextSpin(row && row.last_spin_at);
  if (secondsLeft > 0) {
    return res.status(429).json({ error: `Come back in ${Math.ceil(secondsLeft / 60)} minute${Math.ceil(secondsLeft / 60) === 1 ? '' : 's'} for your next free spin`, secondsLeft });
  }

  const prize = pickPrize();
  db.prepare("UPDATE users SET last_spin_at = datetime('now') WHERE id = ?").run(userId);

  const io = req.app.get('io');
  if (prize.type === 'coins') {
    db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(prize.amount, userId);
    for (const [, s] of io.sockets.sockets) {
      if (s.data.user && s.data.user.id === userId) {
        s.emit('coins_update', { coins: row.coins + prize.amount });
      }
    }
  } else {
    xpStore.awardXp(io, userId, prize.amount);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ prize, user: publicUser(updated) });
});

module.exports = router;

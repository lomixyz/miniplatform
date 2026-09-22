const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');
const xpStore = require('../xp');
const { XP_REWARDS } = require('../level');

const router = express.Router();

// The Gift Store (Explore → Gift Store) sends a gift straight to a friend
// with no room involved — unlike the in-room gift bar/`/gift` command, which
// require the sender to be an active member of that room. Uses the same
// gift catalog and counters (total_spent, gifts_sent_count feed the Gift
// Contest / Legendary Contest leaderboards) as room gifting.
router.post('/send', requireLogin, (req, res) => {
  const senderId = req.session.user.id;
  const { toUsername, giftId } = req.body || {};

  const recipient = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(toUsername || '').trim());
  if (!recipient) return res.status(404).json({ error: `No user named "${toUsername}"` });
  if (recipient.id === senderId) return res.status(400).json({ error: "You can't send a gift to yourself" });

  const gift = db.prepare('SELECT * FROM gifts_catalog WHERE id = ?').get(giftId);
  if (!gift) return res.status(400).json({ error: 'Invalid gift' });

  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(senderId);
  if (sender.coins < gift.cost) return res.status(400).json({ error: 'Not enough coins' });

  db.prepare('UPDATE users SET coins = coins - ?, total_spent = total_spent + ?, gifts_sent_count = gifts_sent_count + 1 WHERE id = ?')
    .run(gift.cost, gift.cost, senderId);
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(gift.cost, recipient.id);
  db.logCoinTx(senderId, -gift.cost, 'gifts', `Sent ${gift.name} to ${recipient.username}`);
  db.logCoinTx(recipient.id, gift.cost, 'gifts', `Received ${gift.name} from ${sender.username}`);

  const io = req.app.get('io');
  const senderXp = xpStore.awardXp(io, senderId, XP_REWARDS.GIFT_SENT);
  xpStore.awardXp(io, recipient.id, XP_REWARDS.GIFT_RECEIVED);

  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    recipient.id, 'gift', `${sender.username} sent you a gift!`,
    `${sender.username} sent you a ${gift.name} ${gift.emoji} from the Gift Store!`
  );

  // Personal notice, not a room event — toast only, never dropped into
  // whatever room chat the recipient happens to have open right now.
  for (const [, s] of io.sockets.sockets) {
    if (s.data.user && s.data.user.id === recipient.id) {
      s.emit('coins_update', { coins: recipient.coins + gift.cost });
      s.emit('personal_notice', `🎁 ${sender.username} sent you a ${gift.name} ${gift.emoji}!`);
    }
  }

  res.json({ ok: true, coins: sender.coins - gift.cost, senderLevel: senderXp.level });
});

module.exports = router;

// Mentor Dashboard (Explore -> Mentor Dashboard, visible only to accounts
// with is_mentor = 1) — the merchants belonging to this mentor, each one's
// daily gain and trial status, plus the pending New/Renewal requests
// waiting on this mentor's decision (accept/reject lives in routes/merchant.js,
// since both the self-service application flow and the review flow operate
// on the same merchant_applications table).
const express = require('express');
const db = require('../db');
const { requireFlag } = require('../auth');
const { levelFromXp } = require('../level');

const router = express.Router();

function sudanDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Khartoum', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

router.get('/dashboard', requireFlag('mentor'), (req, res) => {
  const mentorId = req.session.user.id;
  const today = sudanDateString();

  const merchantRows = db.prepare(`
    SELECT id, username, xp, coins, merchant_trial_expires_at, xp_daily_date, xp_daily_earned, total_spent, gifts_sent_count
    FROM users WHERE mentor_id = ? AND is_merchant = 1 ORDER BY username COLLATE NOCASE
  `).all(mentorId);

  const merchants = merchantRows.map((r) => {
    const trialExpired = !!(r.merchant_trial_expires_at && new Date(r.merchant_trial_expires_at) < new Date());
    return {
      id: r.id,
      username: r.username,
      level: levelFromXp(r.xp || 0).level,
      coins: r.coins,
      totalSpent: r.total_spent || 0,
      giftsSentCount: r.gifts_sent_count || 0,
      dailyGainXp: r.xp_daily_date === today ? (r.xp_daily_earned || 0) : 0,
      trialExpiresAt: r.merchant_trial_expires_at || null,
      trialExpired,
    };
  });

  const pending = db.prepare(`
    SELECT ma.id, ma.type, ma.message, ma.created_at, u.id AS user_id, u.username
    FROM merchant_applications ma JOIN users u ON u.id = ma.user_id
    WHERE ma.status = 'pending' AND ma.mentor_id = ? ORDER BY ma.id ASC
  `).all(mentorId);

  res.json({
    merchants,
    pending,
    summary: {
      merchantCount: merchants.length,
      trialsExpired: merchants.filter((m) => m.trialExpired).length,
      pendingCount: pending.length,
      totalDailyGainXp: merchants.reduce((sum, m) => sum + m.dailyGainXp, 0),
    },
  });
});

module.exports = router;

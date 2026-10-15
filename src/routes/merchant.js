// "Become a Merchant" self-service application (Explore -> Become a
// Merchant) — every merchant belongs to exactly one Mentor (chosen when
// applying), and that Mentor is who reviews the application (Staff can
// still review/oversee any application too, but the Mentor's own queue is
// scoped to just their own merchants — see GET /pending below). Approving
// a 'new' application sets is_merchant = 1, mentor_id, and starts a trial
// period; a merchant renews that trial by requesting renewal FROM THEIR
// OWN MENTOR (POST /renew) — same application table, type = 'renewal',
// reviewed the same way.
const express = require('express');
const db = require('../db');
const { requireLogin, requireFlag, publicUser } = require('../auth');

const router = express.Router();

const MERCHANT_TRIAL_DAYS = 30;

// Only an active Mentor, or Staff reviewing on a Mentor's behalf, may review
// a given application — never an unrelated Mentor's queue. (The route-level
// requireFlag('staff', 'mentor') above already keeps everyone else out;
// this is the extra per-row check that stops Mentor A from acting on
// Mentor B's merchant.)
function canReview(application, sessionUser) {
  if (sessionUser.is_staff) return true;
  return !!sessionUser.is_mentor && application.mentor_id === sessionUser.id;
}

// The current user's own application status (or none) — drives the
// Explore card's "Apply" vs "Pending review" vs "Already a Merchant" state.
router.get('/status', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_merchant, mentor_id, merchant_trial_expires_at FROM users WHERE id = ?').get(me);
  const application = db.prepare(
    'SELECT id, type, mentor_id, message, status, created_at, reviewed_at FROM merchant_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(me);
  const mentor = user && user.mentor_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(user.mentor_id) : null;
  res.json({
    isMerchant: !!(user && user.is_merchant),
    mentorUsername: mentor ? mentor.username : null,
    trialExpiresAt: (user && user.merchant_trial_expires_at) || null,
    trialExpired: !!(user && user.merchant_trial_expires_at && new Date(user.merchant_trial_expires_at) < new Date()),
    application: application || null,
  });
});

// Mentors to choose from when applying — every merchant must pick one (see
// "merchants belong to mentors only"), shown as a dropdown client-side.
router.get('/mentors', requireLogin, (req, res) => {
  const rows = db.prepare('SELECT id, username FROM users WHERE is_mentor = 1 ORDER BY username COLLATE NOCASE').all();
  res.json({ mentors: rows });
});

router.post('/apply', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_merchant FROM users WHERE id = ?').get(me);
  if (user && user.is_merchant) return res.status(400).json({ error: 'You are already a Merchant' });
  const pending = db.prepare("SELECT 1 FROM merchant_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending application' });

  const mentorId = Number(req.body && req.body.mentorId);
  const mentor = mentorId ? db.prepare('SELECT id FROM users WHERE id = ? AND is_mentor = 1').get(mentorId) : null;
  if (!mentor) return res.status(400).json({ error: 'Choose a Mentor to apply under — every Merchant belongs to one' });

  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  db.prepare('INSERT INTO merchant_applications (user_id, mentor_id, type, message) VALUES (?, ?, ?, ?)').run(me, mentor.id, 'new', message);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    mentor.id, 'system', 'New Merchant application',
    `${req.session.user.username} applied to become a Merchant under you — review it from your Mentor Dashboard.`
  );
  res.json({ ok: true });
});

// A merchant whose trial is running out (or already expired) asks their OWN
// mentor to renew it — never a different mentor's call, since mentor_id is
// taken straight from the merchant's own users.mentor_id, not the client.
router.post('/renew', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const user = db.prepare('SELECT is_merchant, mentor_id FROM users WHERE id = ?').get(me);
  if (!user || !user.is_merchant) return res.status(400).json({ error: 'You are not a Merchant' });
  if (!user.mentor_id) return res.status(400).json({ error: "You don't have a Mentor on file to request renewal from — contact Staff" });
  const pending = db.prepare("SELECT 1 FROM merchant_applications WHERE user_id = ? AND status = 'pending'").get(me);
  if (pending) return res.status(400).json({ error: 'You already have a pending request' });

  const message = String((req.body && req.body.message) || '').trim().slice(0, 500);
  db.prepare('INSERT INTO merchant_applications (user_id, mentor_id, type, message) VALUES (?, ?, ?, ?)').run(me, user.mentor_id, 'renewal', message);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    user.mentor_id, 'system', 'Merchant renewal request',
    `${req.session.user.username} is requesting a renewal — review it from your Mentor Dashboard.`
  );
  res.json({ ok: true });
});

// Pending applications this reviewer can act on — a Mentor's own queue
// (only applications/renewals directed at them), or every pending
// application for Staff/Global Admin (oversight).
router.get('/pending', requireFlag('staff', 'mentor'), (req, res) => {
  const sessionUser = req.session.user;
  const scopedToMentor = !(sessionUser.is_staff || sessionUser.is_global_admin);
  const rows = db.prepare(`
    SELECT ma.id, ma.type, ma.message, ma.created_at, ma.mentor_id, u.id AS user_id, u.username
    FROM merchant_applications ma JOIN users u ON u.id = ma.user_id
    WHERE ma.status = 'pending' ${scopedToMentor ? 'AND ma.mentor_id = ?' : ''}
    ORDER BY ma.id ASC
  `).all(...(scopedToMentor ? [sessionUser.id] : []));
  res.json({ applications: rows });
});

router.post('/:id/approve', requireFlag('staff', 'mentor'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM merchant_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  if (!canReview(app_, req.session.user)) return res.status(403).json({ error: "This application isn't assigned to you" });

  const trialExpiresAt = new Date(Date.now() + MERCHANT_TRIAL_DAYS * 24 * 3600 * 1000).toISOString();
  if (app_.type === 'renewal') {
    db.prepare('UPDATE users SET merchant_trial_expires_at = ? WHERE id = ?').run(trialExpiresAt, app_.user_id);
  } else {
    db.prepare('UPDATE users SET is_merchant = 1, mentor_id = ?, merchant_trial_expires_at = ? WHERE id = ?')
      .run(app_.mentor_id, trialExpiresAt, app_.user_id);
  }
  db.prepare("UPDATE merchant_applications SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system',
    app_.type === 'renewal' ? 'Merchant renewal approved' : 'Merchant application approved',
    app_.type === 'renewal'
      ? `${req.session.user.username} renewed your Merchant trial for ${MERCHANT_TRIAL_DAYS} more days.`
      : `${req.session.user.username} approved your Merchant application — you're now a Merchant (trial: ${MERCHANT_TRIAL_DAYS} days)!`
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(app_.user_id);
  const refreshUserPresence = req.app.get('refreshUserPresence');
  if (refreshUserPresence) refreshUserPresence(app_.user_id);
  res.json({ ok: true, user: publicUser(updated) });
});

router.post('/:id/reject', requireFlag('staff', 'mentor'), (req, res) => {
  const app_ = db.prepare("SELECT * FROM merchant_applications WHERE id = ? AND status = 'pending'").get(Number(req.params.id));
  if (!app_) return res.status(404).json({ error: 'Application not found' });
  if (!canReview(app_, req.session.user)) return res.status(403).json({ error: "This application isn't assigned to you" });

  db.prepare("UPDATE merchant_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(req.session.user.username, app_.id);
  db.prepare('INSERT INTO alerts (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
    app_.user_id, 'system',
    app_.type === 'renewal' ? 'Merchant renewal declined' : 'Merchant application declined',
    app_.type === 'renewal'
      ? `${req.session.user.username} declined your Merchant renewal request.`
      : `${req.session.user.username} declined your Merchant application.`
  );
  res.json({ ok: true });
});

module.exports = router;

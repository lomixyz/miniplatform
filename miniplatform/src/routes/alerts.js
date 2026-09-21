const express = require('express');
const db = require('../db');
const { requireLogin } = require('../auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const me = req.session.user.id;
  const alerts = db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(me);
  const unread = db.prepare('SELECT COUNT(*) c FROM alerts WHERE user_id = ? AND is_read = 0').get(me).c;
  res.json({ alerts: alerts.map((a) => ({ ...a, is_read: !!a.is_read })), unread });
});

router.post('/:id/read', requireLogin, (req, res) => {
  const me = req.session.user.id;
  db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(req.params.id), me);
  res.json({ ok: true });
});

router.post('/read-all', requireLogin, (req, res) => {
  const me = req.session.user.id;
  db.prepare('UPDATE alerts SET is_read = 1 WHERE user_id = ?').run(me);
  res.json({ ok: true });
});

module.exports = router;

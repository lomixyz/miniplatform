const express = require('express');
const db = require('../db');
const { requireLogin, publicUser } = require('../auth');

const router = express.Router();

// A simplified but real Avatar Maker: not full layered outfit/scene
// compositing (that needs an asset/canvas pipeline well beyond this app's
// colored-initial-avatar approach) — instead, three independent, free picks
// that actually persist and render: a frame color (the "outfit"), a
// companion emoji (the "pet"), and a backdrop emoji shown on the profile
// card (the "scene").
const FRAME_COLORS = ['#0891b2', '#f97316', '#ec4899', '#8b5cf6', '#22c55e', '#eab308', '#ef4444', '#94a3b8'];
const PETS = ['🐶', '🐱', '🐰', '🐼', '🦊', '🐧', '🐲', '🦄', '🐢', '🦋'];
const SCENES = ['🌆', '🌃', '🏖️', '🌌', '🌸', '⛰️', '🌧️', '☀️'];

router.get('/options', requireLogin, (req, res) => {
  res.json({ frameColors: FRAME_COLORS, pets: PETS, scenes: SCENES });
});

router.post('/', requireLogin, (req, res) => {
  const { frameColor, pet, scene } = req.body || {};
  if (frameColor !== undefined && frameColor !== null && !FRAME_COLORS.includes(frameColor)) {
    return res.status(400).json({ error: 'Invalid frame color' });
  }
  if (pet !== undefined && pet !== null && !PETS.includes(pet)) {
    return res.status(400).json({ error: 'Invalid pet' });
  }
  if (scene !== undefined && scene !== null && !SCENES.includes(scene)) {
    return res.status(400).json({ error: 'Invalid scene' });
  }

  const userId = req.session.user.id;
  const current = db.prepare('SELECT avatar_frame_color, avatar_pet, avatar_scene FROM users WHERE id = ?').get(userId);
  const nextFrame = frameColor === undefined ? current.avatar_frame_color : frameColor;
  const nextPet = pet === undefined ? current.avatar_pet : pet;
  const nextScene = scene === undefined ? current.avatar_scene : scene;

  db.prepare('UPDATE users SET avatar_frame_color = ?, avatar_pet = ?, avatar_scene = ? WHERE id = ?')
    .run(nextFrame, nextPet, nextScene, userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.json({ user: publicUser(updated) });
});

module.exports = router;

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const giftRoutes = require('./routes/gifts');
const adminRoutes = require('./routes/admin');
const friendRoutes = require('./routes/friends');
const alertRoutes = require('./routes/alerts');
const messageRoutes = require('./routes/messages');
const coinRoutes = require('./routes/coins');
const memberRoutes = require('./routes/members');
const leaderboardRoutes = require('./routes/leaderboard');
const spinRoutes = require('./routes/spin');
const colorRoutes = require('./routes/colors');
const avatarRoutes = require('./routes/avatar');
const postRoutes = require('./routes/posts');
const giftStoreRoutes = require('./routes/giftstore');
const userRoutes = require('./routes/users');
const { attachSocket } = require('./socket');

const app = express();
const server = http.createServer(app);
// Default 1MB max payload is too small for a shared voice note or picture —
// raised to 8MB (still well under what a typical photo/short voice clip
// needs) to cover the media-message upload path in socket.js.
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });
app.set('io', io); // lets HTTP routes (e.g. admin set-level) push live socket updates

// In-memory session store: no native module, zero setup. Sessions reset on server restart,
// which is fine for local/dev use — swap in a persistent store (e.g. Redis) for production.
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
});

// 6mb limit: default (100kb) is too small for blog posts that embed a
// base64 image data URL (POST /api/posts with an `image` field).
app.use(express.json({ limit: '6mb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/gifts', giftRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/coins', coinRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/spin', spinRoutes);
app.use('/api/colors', colorRoutes);
app.use('/api/avatar', avatarRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/giftstore', giftStoreRoutes);
app.use('/api/users', userRoutes);

const { refreshUserPresence } = attachSocket(io, sessionMiddleware);
app.set('refreshUserPresence', refreshUserPresence); // lets HTTP routes (Color Shop, Avatar Maker) live-refresh a user's room presence

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MiniPlatform running on http://localhost:${PORT}`);
  console.log('Build features: kick/bump chat commands (/kick <user>, /bump <user>) with 10min/5min rejoin cooldowns, unrecognized "/" commands now return an error instead of posting as plain text.');
});

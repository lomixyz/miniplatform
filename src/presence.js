// Shared live-presence state, written by socket.js and read by REST routes
// (so the room browser / home screen can show live "X/Y" member counts and
// which users are online, without every request touching Socket.io internals).
const roomCounts = new Map(); // roomId -> live connected member count
const onlineUserIds = new Set(); // userIds with at least one open socket
const lastOfflineAt = new Map(); // userId -> timestamp their last socket disconnected
const sessionStartedAt = new Map(); // userId -> timestamp their CURRENT online stretch began (cleared once they go fully offline)

function setRoomCount(roomId, count) {
  if (count > 0) roomCounts.set(roomId, count);
  else roomCounts.delete(roomId);
}

function getRoomCount(roomId) {
  return roomCounts.get(roomId) || 0;
}

function markOnline(userId) {
  // Only the transition into "has at least one socket" starts a fresh
  // online-time stretch — a second tab/device connecting while the first is
  // still open must not reset the clock (see endOnlineSession below, which
  // measures from this timestamp once the user's LAST socket disconnects).
  if (!onlineUserIds.has(userId)) sessionStartedAt.set(userId, Date.now());
  onlineUserIds.add(userId);
}

function markOffline(userId) {
  onlineUserIds.delete(userId);
  lastOfflineAt.set(userId, Date.now());
}

// Called once a user's LAST open socket disconnects (same "stillConnected"
// check in socket.js that guards markOffline) — ends their current online
// stretch and returns how many whole seconds it lasted, so the caller can
// persist it onto users.total_online_seconds (see db.addOnlineSeconds and
// db.checkEliteEligibility). Returns 0 if there was no tracked start (e.g.
// a server restart mid-session — that stretch's time is simply not counted,
// same trade-off as the rest of this in-memory presence module).
function endOnlineSession(userId) {
  const startedAt = sessionStartedAt.get(userId);
  sessionStartedAt.delete(userId);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function isOnline(userId) {
  return onlineUserIds.has(userId);
}

// True if this user currently has a live socket, OR went offline recently
// enough (within graceMs) that this looks like a page refresh / brief
// network blip rather than a real "came back after being away" reconnect.
// Used to decide whether a fresh connection should re-announce a room join.
function wasOnlineRecently(userId, graceMs) {
  if (onlineUserIds.has(userId)) return true;
  const t = lastOfflineAt.get(userId);
  return t != null && (Date.now() - t) < graceMs;
}

// The status shown to everyone else: always 'offline' the instant a user has
// no live socket at all (chosen status is irrelevant then — a disconnected
// user can't be "away" or "busy", they're just gone), otherwise whatever
// status they last chose ('online' | 'away' | 'busy', default 'online' —
// see the users.status column and POST /users/status).
function effectiveStatus(userId, chosenStatus) {
  if (!onlineUserIds.has(userId)) return 'offline';
  return chosenStatus === 'away' || chosenStatus === 'busy' ? chosenStatus : 'online';
}

module.exports = { setRoomCount, getRoomCount, markOnline, markOffline, endOnlineSession, isOnline, wasOnlineRecently, effectiveStatus };

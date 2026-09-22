// Shared live-presence state, written by socket.js and read by REST routes
// (so the room browser / home screen can show live "X/Y" member counts and
// which users are online, without every request touching Socket.io internals).
const roomCounts = new Map(); // roomId -> live connected member count
const onlineUserIds = new Set(); // userIds with at least one open socket
const lastOfflineAt = new Map(); // userId -> timestamp their last socket disconnected

function setRoomCount(roomId, count) {
  if (count > 0) roomCounts.set(roomId, count);
  else roomCounts.delete(roomId);
}

function getRoomCount(roomId) {
  return roomCounts.get(roomId) || 0;
}

function markOnline(userId) {
  onlineUserIds.add(userId);
}

function markOffline(userId) {
  onlineUserIds.delete(userId);
  lastOfflineAt.set(userId, Date.now());
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

module.exports = { setRoomCount, getRoomCount, markOnline, markOffline, isOnline, wasOnlineRecently, effectiveStatus };

// Shared per-room "silence" state (/silence, /unsilence — see socket.js).
// Deliberately in-memory only, not persisted to the DB: a silence is always
// a short, deliberate, temporary action (like a UNO lobby or a voucher drop
// elsewhere in this app), never something that needs to survive a server
// restart — a restart just means every room quietly comes back unsilenced.
//
// A standalone module (rather than living inside socket.js) so the REST
// rooms route can report a room's live silence status too, without needing
// a live socket connection.
const silences = new Map(); // roomId -> { until: epochMs, by: username, timer }

function isSilenced(roomId) {
  return silences.has(roomId);
}

function getSilence(roomId) {
  return silences.get(roomId) || null;
}

// Replaces any existing silence for this room (clearing its timer first) —
// re-running /silence on an already-silenced room just resets the clock.
function setSilence(roomId, { until, by, timer }) {
  const existing = silences.get(roomId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  silences.set(roomId, { until, by, timer });
}

function clearSilence(roomId) {
  const existing = silences.get(roomId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  silences.delete(roomId);
}

module.exports = { isSilenced, getSilence, setSilence, clearSilence };

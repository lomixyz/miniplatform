// Periodic in-room voucher drops: "Hurray! A small gift for you. You have 40
// seconds to pick the voucher [code] 123456. Type /pick 123456 to get the
// voucher. (Amount 60 Coins)." First correct /pick within the window wins.
const db = require('./db');

const activeVouchers = new Map(); // roomId -> { code, amount, expiresAt, claimedBy }
let spawnTimer = null;

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

function randomAmount() {
  const options = [20, 30, 40, 50, 60, 80, 100];
  return options[Math.floor(Math.random() * options.length)];
}

function getActiveVoucher(roomId) {
  return activeVouchers.get(roomId) || null;
}

// Try to claim a voucher in a room with a given code. Returns
// { ok, amount } on success, or { error } on failure — never throws.
function claim(roomId, code, claimerUserId) {
  const v = activeVouchers.get(roomId);
  if (!v) return { error: 'There is no active voucher in this room right now' };
  if (v.claimedBy) return { error: 'That voucher has already been claimed' };
  if (Date.now() > v.expiresAt) { activeVouchers.delete(roomId); return { error: 'That voucher has expired' }; }
  if (String(code).trim() !== v.code) return { error: 'Incorrect voucher code' };

  v.claimedBy = claimerUserId;
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(v.amount, claimerUserId);
  db.logCoinTx(claimerUserId, v.amount, 'other', `Voucher pick — code ${v.code}`);
  activeVouchers.delete(roomId);
  return { ok: true, amount: v.amount, code: v.code };
}

// Start the periodic spawner. `getActiveRoomIds` returns roomIds that
// currently have at least one connected member — no point dropping a
// voucher nobody can see. `onSpawn(roomId, voucher)` / `onExpire(roomId, voucher)`
// are called so the caller (socket.js) can broadcast chat messages.
function startAutoSpawn({ getActiveRoomIds, onSpawn, onExpire, intervalMs = 5 * 60_000, spawnChance = 1, windowMs = 40_000 }) {
  if (spawnTimer) clearInterval(spawnTimer);
  spawnTimer = setInterval(() => {
    const roomIds = getActiveRoomIds();
    for (const roomId of roomIds) {
      if (activeVouchers.has(roomId)) continue; // one at a time per room
      if (Math.random() > spawnChance) continue;

      const voucher = { code: randomCode(), amount: randomAmount(), expiresAt: Date.now() + windowMs, claimedBy: null };
      activeVouchers.set(roomId, voucher);
      onSpawn(roomId, voucher);

      setTimeout(() => {
        const still = activeVouchers.get(roomId);
        if (still && still.code === voucher.code && !still.claimedBy) {
          activeVouchers.delete(roomId);
          onExpire(roomId, voucher);
        }
      }, windowMs);
    }
  }, intervalMs);
  spawnTimer.unref?.(); // don't keep the process alive just for this timer
}

function stopAutoSpawn() {
  if (spawnTimer) clearInterval(spawnTimer);
  spawnTimer = null;
}

module.exports = { getActiveVoucher, claim, startAutoSpawn, stopAutoSpawn };

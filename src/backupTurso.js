// Turso backup/restore for the local SQLite file — a safety net only, not a
// replacement database. The live app still reads/writes data/app.db via
// node:sqlite exactly as it always has (db.js, every src/routes/*.js file —
// none of that changes). This module just:
//
//   1) on boot, if data/app.db doesn't exist yet (e.g. a fresh Render
//      container after a redeploy wiped the disk), tries to pull the most
//      recent snapshot down from Turso and write it to data/app.db BEFORE
//      db.js's own seed/migration logic runs — see restoreFromTursoIfMissing();
//   2) every BACKUP_INTERVAL_MS, pushes a fresh snapshot of data/app.db up
//      to Turso — see startPeriodicBackup().
//
// Both directions are best-effort and fully isolated: a missing/invalid
// Turso config, a network error, or Turso being down is caught and logged,
// never thrown — the app boots and runs exactly as it did before this file
// existed. Nothing here ever touches a table while the live app might be
// writing to it; it only reads data/app.db (backup) or writes to it before
// anything else does (restore, and only when the file doesn't exist yet).
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function tursoConfigured() {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

async function getClient() {
  const { createClient } = require('@libsql/client');
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

// ---- dump local SQLite -> plain JS snapshot (read-only) ----
function dumpLocalDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const tables = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    return tables.map((t) => ({
      name: t.name,
      sql: t.sql,
      rows: db.prepare(`SELECT * FROM "${t.name}"`).all(),
    }));
  } finally {
    db.close();
  }
}

// ---- push a snapshot up to Turso (full replace, one batched transaction) ----
async function backupToTurso() {
  if (!tursoConfigured()) return;
  if (!fs.existsSync(DB_PATH)) return;
  let client;
  try {
    const tables = dumpLocalDb();
    client = await getClient();
    const statements = [{ sql: 'PRAGMA foreign_keys = OFF;', args: [] }];
    for (const t of tables) statements.push({ sql: `DROP TABLE IF EXISTS "${t.name}";`, args: [] });
    for (const t of tables) statements.push({ sql: `${t.sql};`, args: [] });
    for (const t of tables) {
      for (const row of t.rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        statements.push({
          sql: `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
          args: cols.map((c) => row[c]),
        });
      }
    }
    await client.batch(statements, 'write');
    console.log(`[backupTurso] Backed up ${tables.length} tables to Turso.`);
  } catch (err) {
    console.warn('[backupTurso] Backup skipped (non-fatal):', err.message);
  } finally {
    if (client) client.close();
  }
}

// ---- pull the latest snapshot down from Turso into data/app.db ----
// Only runs when data/app.db doesn't exist yet, so it can never overwrite
// data the live container already has.
async function restoreFromTursoIfMissing() {
  if (!tursoConfigured()) return;
  if (fs.existsSync(DB_PATH)) return; // already has a DB file — nothing to restore

  let client;
  try {
    client = await getClient();
    const tablesResult = await client.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    );
    if (!tablesResult.rows.length) {
      console.log('[backupTurso] No backup found on Turso yet — starting with a fresh local database.');
      return;
    }

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec('PRAGMA foreign_keys = OFF;');
      for (const t of tablesResult.rows) {
        db.exec(`${t.sql};`);
        const rowsResult = await client.execute(`SELECT * FROM "${t.name}"`);
        if (!rowsResult.rows.length) continue;
        const cols = rowsResult.columns;
        const stmt = db.prepare(
          `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        );
        for (const row of rowsResult.rows) stmt.run(...cols.map((c) => row[c]));
      }
      console.log(`[backupTurso] Restored ${tablesResult.rows.length} tables from Turso.`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[backupTurso] Restore skipped (non-fatal) — starting fresh instead:', err.message);
    // Never leave behind a half-written/corrupt file for db.js to trip over.
    try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch (_) { /* ignore */ }
  } finally {
    if (client) client.close();
  }
}

function startPeriodicBackup() {
  if (!tursoConfigured()) {
    console.log('[backupTurso] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — periodic backup disabled.');
    return;
  }
  setInterval(() => { backupToTurso(); }, BACKUP_INTERVAL_MS).unref();
  // Also take one backup shortly after boot, so a snapshot exists even if
  // the server restarts again before the first interval fires.
  setTimeout(() => { backupToTurso(); }, 60 * 1000).unref();
}

module.exports = { backupToTurso, restoreFromTursoIfMissing, startPeriodicBackup, tursoConfigured };

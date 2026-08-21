// ===========================================================================
// OpusMax Proxy — SQLite Database Layer
// Migrated from Cloudflare KV to better-sqlite3 for local persistence
// ===========================================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/opusmax.db');

let db;

function getDb() {
  if (!db) {
    // Ensure database directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // Always-disable FK enforcement — there are no FK relationships
    // between our application tables, and the old schema has a stray
    // share_index->shares FK that breaks deleteShare()
    db.pragma('foreign_keys = OFF');
    initDb(db);
  }
  return db;
}

function initDb(database) {
  // Versioned schema: bump DB_VERSION when schema changes
  const DB_VERSION = 1;

  database.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  let storedVersion = database.prepare(
    "SELECT value FROM _meta WHERE key = 'version'"
  ).get();

  if (!storedVersion) {
    storedVersion = { value: '0' };
  }

  const currentVersion = parseInt(storedVersion.value, 10);
  if (currentVersion < DB_VERSION) {
    // Disable FK enforcement during schema migration
    database.exec('PRAGMA legacy_alter_table = ON');
    database.exec('PRAGMA foreign_keys = OFF');

    // Drop tables in reverse FK dependency order (child tables first)
    database.exec(`
      DROP TABLE IF EXISTS login_failures;
      DROP TABLE IF EXISTS details;
      DROP TABLE IF EXISTS usage_buckets;
      DROP TABLE IF EXISTS share_index;
      DROP TABLE IF EXISTS shares;
      DROP INDEX IF EXISTS idx_details_share_window;
    `);

    database.exec(`
      CREATE TABLE shares (
        shareKey   TEXT PRIMARY KEY,
        expiresAt  TEXT NOT NULL,
        tokenLimit INTEGER NOT NULL,
        createdAt  TEXT NOT NULL,
        name       TEXT NOT NULL DEFAULT 'shared'
      );

      CREATE TABLE share_index (
        shareKey TEXT PRIMARY KEY
      );

      CREATE TABLE usage_buckets (
        shareKey  TEXT NOT NULL,
        windowEnd INTEGER NOT NULL,
        tokens    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (shareKey, windowEnd)
      );

      CREATE TABLE details (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        shareKey      TEXT NOT NULL,
        windowEnd     INTEGER NOT NULL,
        timestamp     TEXT NOT NULL,
        input         INTEGER NOT NULL DEFAULT 0,
        output        INTEGER NOT NULL DEFAULT 0,
        cacheRead     INTEGER NOT NULL DEFAULT 0,
        cacheCreation INTEGER NOT NULL DEFAULT 0,
        total         INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_details_share_window ON details(shareKey, windowEnd);

      CREATE TABLE login_failures (
        ip      TEXT PRIMARY KEY,
        count   INTEGER NOT NULL DEFAULT 0,
        lastFail INTEGER NOT NULL
      );
    `);

    database.prepare(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('version', ?)"
    ).run(String(DB_VERSION));
  }
}

// --- Shares ---

function createShareKey(shareKey, expiresAt, tokenLimit, name) {
  const d = getDb();
  const finalName = name || 'shared';
  d.prepare(
    'INSERT OR REPLACE INTO shares (shareKey, expiresAt, tokenLimit, createdAt, name) VALUES (?, ?, ?, COALESCE((SELECT createdAt FROM shares WHERE shareKey = ?), ?), ?)'
  ).run(shareKey, expiresAt, tokenLimit, shareKey, new Date().toISOString(), finalName);

  // Also add to share index
  d.prepare('INSERT OR IGNORE INTO share_index (shareKey) VALUES (?)').run(shareKey);
}

function getShare(shareKey) {
  const row = getDb().prepare('SELECT expiresAt, tokenLimit, createdAt, name FROM shares WHERE shareKey = ?').get(shareKey);
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) {
    deleteShare(shareKey);
    return null;
  }
  return row;
}

function deleteShare(shareKey) {
  const d = getDb();
  d.prepare("DELETE FROM share_index WHERE shareKey = ?").run(shareKey);
  d.prepare("DELETE FROM details WHERE shareKey = ?").run(shareKey);
  d.prepare("DELETE FROM usage_buckets WHERE shareKey = ?").run(shareKey);
  d.prepare("DELETE FROM shares WHERE shareKey = ?").run(shareKey);
}

function getAllShareKeys() {
  const rows = getDb().prepare('SELECT shareKey FROM share_index').all();
  return rows.map(r => r.shareKey);
}

function addToIndex(shareKey) {
  const existing = getDb().prepare('SELECT shareKey FROM share_index WHERE shareKey = ?').get(shareKey);
  if (!existing) {
    getDb().prepare('INSERT INTO share_index (shareKey) VALUES (?)').run(shareKey);
  }
}

// --- Usage ---

function getWindowUsage(shareKey, windowEndTimestamp) {
  const row = getDb().prepare('SELECT tokens FROM usage_buckets WHERE shareKey = ? AND windowEnd = ?').get(shareKey, windowEndTimestamp);
  return row ? row.tokens : 0;
}

function incrementWindowUsage(shareKey, windowEndTimestamp, tokens) {
  getDb().prepare(
    'INSERT INTO usage_buckets (shareKey, windowEnd, tokens) VALUES (?, ?, ?) ON CONFLICT(shareKey, windowEnd) DO UPDATE SET tokens = tokens + ?'
  ).run(shareKey, windowEndTimestamp, tokens, tokens);
}

// --- Details ---

function getDetails(shareKey, windowEndTimestamp) {
  const rows = getDb().prepare(
    'SELECT timestamp, input, output, cacheRead, cacheCreation, total FROM details WHERE shareKey = ? AND windowEnd = ? ORDER BY id ASC'
  ).all(shareKey, windowEndTimestamp);
  return rows.map(r => ({
    timestamp: r.timestamp,
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheCreation: r.cacheCreation,
    total: r.total,
  }));
}

function addDetail(shareKey, windowEndTimestamp, input, output, cacheRead, cacheCreation, total) {
  const d = getDb();

  d.prepare(
    'INSERT INTO details (shareKey, windowEnd, timestamp, input, output, cacheRead, cacheCreation, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(shareKey, windowEndTimestamp, new Date().toISOString(), input, output, cacheRead, cacheCreation, total);

  const countRow = d.prepare('SELECT COUNT(*) as cnt FROM details WHERE shareKey = ? AND windowEnd = ?').get(shareKey, windowEndTimestamp);
  if (countRow.cnt > 25) {
    const excess = countRow.cnt - 25;
    d.prepare(
      'DELETE FROM details WHERE id IN (SELECT id FROM details WHERE shareKey = ? AND windowEnd = ? ORDER BY id ASC LIMIT ?)'
    ).run(shareKey, windowEndTimestamp, excess);
  }
}

// --- Login rate limiting ---

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const d = getDb();
  const existing = d.prepare('SELECT count, lastFail FROM login_failures WHERE ip = ?').get(ip);

  if (existing) {
    if (now - existing.lastFail > 60 * 1000) {
      d.prepare('UPDATE login_failures SET count = 1, lastFail = ? WHERE ip = ?').run(now, ip);
      return 1;
    } else {
      const count = existing.count + 1;
      d.prepare('UPDATE login_failures SET count = ?, lastFail = ? WHERE ip = ?').run(count, now, ip);
      return count;
    }
  }

  d.prepare('INSERT INTO login_failures (ip, count, lastFail) VALUES (?, 1, ?)').run(ip, now);
  return 1;
}

function incrementLoginFail(ip) {
  const now = Date.now();
  const d = getDb();
  const existing = d.prepare('SELECT count, lastFail FROM login_failures WHERE ip = ?').get(ip);
  if (existing) {
    d.prepare('UPDATE login_failures SET count = count + 1, lastFail = ? WHERE ip = ?').run(now, ip);
    return existing.count + 1;
  } else {
    d.prepare('INSERT INTO login_failures (ip, count, lastFail) VALUES (?, 1, ?)').run(ip, now);
    return 1;
  }
}

function getLoginFailCount(ip) {
  const row = getDb().prepare('SELECT count FROM login_failures WHERE ip = ?').get(ip);
  return row ? row.count : 0;
}

function clearLoginFail(ip) {
  getDb().prepare('DELETE FROM login_failures WHERE ip = ?').run(ip);
}

// --- Cleanup ---

function cleanupOldRecords(cutoffTimestamp) {
  const ts = typeof cutoffTimestamp === "number" ? cutoffTimestamp : Date.now() - (7 * 24 * 60 * 60 * 1000);
  const d = getDb();
  const bucketsRemoved = d.prepare("DELETE FROM usage_buckets WHERE windowEnd < ?").run(ts).changes;
  const detailsRemoved = d.prepare("DELETE FROM details WHERE windowEnd < ?").run(ts).changes;
  return { bucketsRemoved, detailsRemoved };
}

module.exports = {
  init: () => getDb(),
  createShareKey,
  getShare,
  deleteShare,
  getAllShareKeys,
  addToIndex,
  getWindowUsage,
  incrementWindowUsage,
  getDetails,
  addDetail,
  checkLoginRateLimit,
  incrementLoginFail,
  getLoginFailCount,
  clearLoginFail,
  cleanupOldRecords,
};
// ===========================================================================
// OpusMax Proxy — database layer tests
// Uses built-in node:test runner, no external dependencies
// ===========================================================================

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DB_MODULE_PATH = path.resolve(__dirname, "..", "src", "lib", "db.js");

function createDbModule(dbPath) {
  delete require.cache[require.resolve(DB_MODULE_PATH)];
  process.env.DATABASE_PATH = dbPath;
  return require(DB_MODULE_PATH);
}

function makeTmpDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opusmax-db-test-"));
  return path.join(tmpDir, "test.db");
}

// Helper: a future ISO-8601 expiry so tests don't race against TTL
function futureExpiry(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ===========================================================================
describe("Database schema & WAL mode", () => {
  const dbPath = makeTmpDbPath();
  const db = createDbModule(dbPath);

  // Trigger initialization by doing a trivial write
  db.incrementWindowUsage("__init__", 0, 0);

  it("creates the database file", () => {
    assert.ok(fs.existsSync(dbPath), "database file should exist");
  });

  it("enables WAL journal mode", () => {
    const Database = require("better-sqlite3");
    const check = new Database(dbPath);
    const mode = check.pragma("journal_mode", { simple: true });
    check.close();
    assert.strictEqual(mode, "wal", `journal_mode should be wal, got ${mode}`);
  });

  it("creates all expected tables", () => {
    const Database = require("better-sqlite3");
    const check = new Database(dbPath);
    const rows = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    check.close();

    const tableNames = rows.map(r => r.name);
    assert.ok(
      tableNames.includes("shares"),
      "shares table should exist"
    );
    assert.ok(
      tableNames.includes("share_index"),
      "share_index table should exist"
    );
    assert.ok(
      tableNames.includes("usage_buckets"),
      "usage_buckets table should exist"
    );
    assert.ok(
      tableNames.includes("details"),
      "details table should exist"
    );
    assert.ok(
      tableNames.includes("login_failures"),
      "login_failures table should exist"
    );
  });

  it("runs initSchema idempotently (module reload)", () => {
    // Reloading the module should not error even though tables already exist.
    const reloaded = createDbModule(dbPath);
    assert.strictEqual(typeof reloaded.createShareKey, "function");
  });
});

// ===========================================================================
describe("Share key management", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("creates a share key", () => {
    db.createShareKey("sk-test1", futureExpiry(), 5000, "my share");
    const row = db.getShare("sk-test1");
    assert.ok(row, "share should exist");
    assert.strictEqual(row.name, "my share");
    assert.strictEqual(row.tokenLimit, 5000);
    assert.ok(row.createdAt, "should have createdAt");
    assert.ok(row.expiresAt, "should have expiresAt");
  });

  it("returns null for a missing share key", () => {
    assert.strictEqual(db.getShare("does-not-exist"), null);
  });

  it("creates with default name 'shared'", () => {
    db.createShareKey("sk-def", futureExpiry(), 100, "");
    const row = db.getShare("sk-def");
    assert.strictEqual(row.name, "shared");
  });

  it("updates an existing share key on re-creation", () => {
    db.createShareKey("sk-update", futureExpiry(), 1000, "old name");
    db.createShareKey("sk-update", futureExpiry(60), 2000, "new name");
    const row = db.getShare("sk-update");
    assert.strictEqual(row.name, "new name");
    assert.strictEqual(row.tokenLimit, 2000);
  });

  it("deletes a share key", () => {
    db.createShareKey("sk-del", futureExpiry(), 500, "gone");
    db.deleteShare("sk-del");
    assert.strictEqual(db.getShare("sk-del"), null);
  });

  it("adds share keys to the index and retrieves all", () => {
    db.createShareKey("sk-a", futureExpiry(), 100, "a");
    db.createShareKey("sk-b", futureExpiry(), 200, "b");
    db.createShareKey("sk-c", futureExpiry(), 300, "c");

    const keys = db.getAllShareKeys();
    assert.ok(keys.includes("sk-a"));
    assert.ok(keys.includes("sk-b"));
    assert.ok(keys.includes("sk-c"));
    assert.strictEqual(keys.length, 3);
  });

  it("deduplicates index entries via addToIndex", () => {
    db.addToIndex("sk-dup");
    db.addToIndex("sk-dup");
    const keys = db.getAllShareKeys();
    const dupes = keys.filter(k => k === "sk-dup");
    assert.strictEqual(dupes.length, 1, "index should have no duplicates");
  });

  it("removes deleted share key from index", () => {
    db.createShareKey("sk-keep", futureExpiry(), 100, "keep");
    db.createShareKey("sk-remove", futureExpiry(), 200, "remove");
    db.deleteShare("sk-remove");

    const keys = db.getAllShareKeys();
    assert.ok(keys.includes("sk-keep"));
    assert.ok(!keys.includes("sk-remove"), "deleted key should be gone from index");
  });

  it("returns empty array when index is empty", () => {
    assert.deepStrictEqual(db.getAllShareKeys(), []);
  });
});

// ===========================================================================
describe("Window usage tracking", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("returns 0 for a non-existent bucket", () => {
    assert.strictEqual(db.getWindowUsage("sk-x", 1000000), 0);
  });

  it("increments and retrieves usage", () => {
    db.incrementWindowUsage("sk-1", 1000000, 150);
    assert.strictEqual(db.getWindowUsage("sk-1", 1000000), 150);
  });

  it("accumulates across multiple increments", () => {
    db.incrementWindowUsage("sk-2", 2000000, 100);
    db.incrementWindowUsage("sk-2", 2000000, 200);
    db.incrementWindowUsage("sk-2", 2000000, 50);
    assert.strictEqual(db.getWindowUsage("sk-2", 2000000), 350);
  });

  it("keeps separate windows isolated", () => {
    db.incrementWindowUsage("sk-3", 1000000, 100);
    db.incrementWindowUsage("sk-3", 2000000, 200);
    db.incrementWindowUsage("sk-3", 3000000, 300);
    assert.strictEqual(db.getWindowUsage("sk-3", 1000000), 100);
    assert.strictEqual(db.getWindowUsage("sk-3", 2000000), 200);
    assert.strictEqual(db.getWindowUsage("sk-3", 3000000), 300);
  });

  it("keeps separate share keys isolated", () => {
    db.incrementWindowUsage("sk-a", 1000000, 500);
    db.incrementWindowUsage("sk-b", 1000000, 999);
    assert.strictEqual(db.getWindowUsage("sk-a", 1000000), 500);
    assert.strictEqual(db.getWindowUsage("sk-b", 1000000), 999);
  });
});

// ===========================================================================
describe("Detail tracking", () => {
  let db;
  let dbPath;
  const windowEnd = 5000000;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("returns empty array when no details exist", () => {
    assert.deepStrictEqual(db.getDetails("sk-x", windowEnd), []);
  });

  it("adds and retrieves a single detail", () => {
    db.addDetail("sk-1", windowEnd, 10, 20, 5, 3, 38);
    const details = db.getDetails("sk-1", windowEnd);
    assert.strictEqual(details.length, 1);
    assert.strictEqual(details[0].input, 10);
    assert.strictEqual(details[0].output, 20);
    assert.strictEqual(details[0].cacheRead, 5);
    assert.strictEqual(details[0].cacheCreation, 3);
    assert.strictEqual(details[0].total, 38);
    assert.ok(details[0].timestamp, "should have timestamp");
  });

  it("returns details ordered by insertion", () => {
    db.addDetail("sk-2", windowEnd, 1, 0, 0, 0, 1);
    db.addDetail("sk-2", windowEnd, 2, 0, 0, 0, 2);
    db.addDetail("sk-2", windowEnd, 3, 0, 0, 0, 3);
    const details = db.getDetails("sk-2", windowEnd);
    assert.strictEqual(details[0].total, 1);
    assert.strictEqual(details[1].total, 2);
    assert.strictEqual(details[2].total, 3);
  });

  it("keeps separate windows isolated", () => {
    db.addDetail("sk-3", 1000000, 10, 0, 0, 0, 10);
    db.addDetail("sk-3", 2000000, 20, 0, 0, 0, 20);
    assert.strictEqual(db.getDetails("sk-3", 1000000).length, 1);
    assert.strictEqual(db.getDetails("sk-3", 2000000).length, 1);
    assert.strictEqual(db.getDetails("sk-3", 1000000)[0].total, 10);
    assert.strictEqual(db.getDetails("sk-3", 2000000)[0].total, 20);
  });

  it("enforces the max 25 detail limit", () => {
    for (let i = 0; i < 35; i++) {
      db.addDetail("sk-4", windowEnd, i, i, i, i, i * 4);
    }
    const details = db.getDetails("sk-4", windowEnd);
    assert.strictEqual(
      details.length, 25,
      `should cap at 25 details, got ${details.length}`
    );
    // Should keep the last 25 (most recent)
    assert.strictEqual(details[0].total, 10 * 4); // index 10 (35 - 25)
    assert.strictEqual(details[24].total, 34 * 4);
  });
});

// ===========================================================================
describe("Login rate limiting", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("returns 0 for an IP with no failures", () => {
    assert.strictEqual(db.getLoginFailCount("1.2.3.4"), 0);
  });

  it("increments the failure count", () => {
    assert.strictEqual(db.incrementLoginFail("1.2.3.4"), 1);
    assert.strictEqual(db.incrementLoginFail("1.2.3.4"), 2);
    assert.strictEqual(db.incrementLoginFail("1.2.3.4"), 3);
  });

  it("returns the count after increments", () => {
    db.incrementLoginFail("5.6.7.8");
    db.incrementLoginFail("5.6.7.8");
    assert.strictEqual(db.getLoginFailCount("5.6.7.8"), 2);
  });

  it("tracks different IPs independently", () => {
    db.incrementLoginFail("10.0.0.1");
    db.incrementLoginFail("10.0.0.1");
    db.incrementLoginFail("10.0.0.2");
    assert.strictEqual(db.getLoginFailCount("10.0.0.1"), 2);
    assert.strictEqual(db.getLoginFailCount("10.0.0.2"), 1);
  });

  it("clears the failure record", () => {
    db.incrementLoginFail("3.3.3.3");
    db.incrementLoginFail("3.3.3.3");
    db.clearLoginFail("3.3.3.3");
    assert.strictEqual(db.getLoginFailCount("3.3.3.3"), 0);
  });

  it("clearing a non-existent IP is a no-op", () => {
    assert.doesNotThrow(() => db.clearLoginFail("99.99.99.99"));
  });
});

// ===========================================================================
describe("Cleanup of old records", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("removes old usage buckets", () => {
    const now = Date.now();
    const old = now - (8 * 24 * 60 * 60 * 1000); // 8 days ago
    const recent = now - (3 * 24 * 60 * 60 * 1000);  // 3 days ago

    db.incrementWindowUsage("sk-a", old, 100);
    db.incrementWindowUsage("sk-a", recent, 200);
    db.incrementWindowUsage("sk-a", recent + 1000, 300);

    const result = db.cleanupOldRecords();
    assert.ok(result.bucketsRemoved >= 1, "should remove at least 1 old bucket");

    assert.strictEqual(db.getWindowUsage("sk-a", old), 0, "old bucket should be gone");
    assert.strictEqual(db.getWindowUsage("sk-a", recent), 200, "recent bucket should remain");
    assert.strictEqual(db.getWindowUsage("sk-a", recent + 1000), 300, "recent bucket should remain");
  });

  it("removes old details", () => {
    const now = Date.now();
    const old = now - (8 * 24 * 60 * 60 * 1000);
    const recent = now - (3 * 24 * 60 * 60 * 1000);

    db.addDetail("sk-b", old, 1, 0, 0, 0, 1);
    db.addDetail("sk-b", recent, 2, 0, 0, 0, 2);
    db.addDetail("sk-b", recent + 1000, 3, 0, 0, 0, 3);

    const result = db.cleanupOldRecords();
    assert.ok(result.detailsRemoved >= 1, "should remove old details");

    assert.strictEqual(db.getDetails("sk-b", old).length, 0, "old details should be gone");
    assert.strictEqual(db.getDetails("sk-b", recent).length, 1, "recent details should remain");
    assert.strictEqual(db.getDetails("sk-b", recent + 1000).length, 1, "recent details should remain");
  });

  it("returns 0 removed when nothing is old enough", () => {
    const now = Date.now();
    const cutoff = now - (1 * 60 * 60 * 1000); // 1 hour ago
    db.incrementWindowUsage("sk-c", now, 100);
    db.addDetail("sk-c", now, 1, 0, 0, 0, 1);

    const result = db.cleanupOldRecords(cutoff);
    assert.strictEqual(result.bucketsRemoved, 0);
    assert.strictEqual(result.detailsRemoved, 0);
  });

  it("cleanup with no old records is safe", () => {
    // No data at all — should not throw
    assert.doesNotThrow(() => db.cleanupOldRecords(Date.now()));
  });
});

// ===========================================================================
describe("Persistence across connections", () => {
  it("data survives module reload via DATABASE_PATH", () => {
    const dbPath = makeTmpDbPath();

    // Write
    let db = createDbModule(dbPath);
    db.createShareKey("sk-persist", futureExpiry(), 42, "persist");
    db.incrementWindowUsage("sk-persist", 9999999, 123);
    db.addDetail("sk-persist", 9999999, 1, 2, 3, 4, 10);
    db.addToIndex("sk-persist");

    // Reload
    db = createDbModule(dbPath);

    assert.strictEqual(db.getShare("sk-persist").tokenLimit, 42);
    assert.strictEqual(db.getWindowUsage("sk-persist", 9999999), 123);
    assert.strictEqual(db.getDetails("sk-persist", 9999999).length, 1);
    assert.ok(db.getAllShareKeys().includes("sk-persist"));
  });
});

// ===========================================================================
describe("Concurrent-like access patterns", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDbModule(dbPath);
  });

  it("handles rapid sequential increments without lost updates", () => {
    for (let i = 0; i < 500; i++) {
      db.incrementWindowUsage("sk-fast", 7777777, 1);
    }
    assert.strictEqual(db.getWindowUsage("sk-fast", 7777777), 500);
  });

  it("handles rapid interleaved detail inserts", () => {
    for (let i = 0; i < 30; i++) {
      db.addDetail("sk-inter", 8888888, i, 0, 0, 0, i);
    }
    const details = db.getDetails("sk-inter", 8888888);
    assert.strictEqual(details.length, 25, "should still be capped at 25");
    assert.strictEqual(details[24].total, 29);
  });

  it("handles mixed share + usage + detail operations", () => {
    for (let i = 0; i < 20; i++) {
      const key = `sk-mixed-${i}`;
      db.createShareKey(key, futureExpiry(), 1000, `share ${i}`);
      db.addToIndex(key);
      db.incrementWindowUsage(key, 1234567 + i, 42 + i);
      db.addDetail(key, 1234567 + i, 10, 5, 2, 1, 18);
    }

    const keys = db.getAllShareKeys();
    assert.strictEqual(keys.length, 20);

    for (let i = 0; i < 20; i++) {
      const key = `sk-mixed-${i}`;
      assert.ok(db.getShare(key), `share ${i} should exist`);
      assert.strictEqual(db.getWindowUsage(key, 1234567 + i), 42 + i);
      assert.strictEqual(db.getDetails(key, 1234567 + i).length, 1);
    }
  });
});

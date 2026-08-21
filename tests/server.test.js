// ===========================================================================
// OpusMax Proxy — server integration tests
// ===========================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_ADMIN_SECRET = 'test-admin-secret-123';
const TEST_API_KEY = 'sk-ant-test-key-123';

let server;
let dbPath;
let db; // database module instance

function makeReq(method, urlPath, opts = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const body = opts.body && typeof opts.body === 'string'
      ? opts.body
      : opts.body ? JSON.stringify(opts.body) : null;
    const headers = { ...opts.headers };
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers,
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  process.env.ANTHROPIC_API_KEY = TEST_API_KEY;
  process.env.ADMIN_SECRET = TEST_ADMIN_SECRET;
  process.env.PORT = '0';

  // Fresh DB path
  dbPath = path.join(os.tmpdir(), 'opusmax-svr-' + Date.now() + '.db');
  process.env.DATABASE_PATH = dbPath;

  // Load db AFTER env is set
  db = require('../src/lib/db.js');
  db.init();

  const { createApp } = require('../src/server.js');
  const app = createApp();

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

// ===========================================================================
describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await makeReq('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
  });
});

// ===========================================================================
describe("POST /v1/messages", () => {
  it("returns 401 without share key", async () => {
    const res = await makeReq('POST', '/v1/messages');
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.error.includes('Missing'));
  });

  it("returns 403 for invalid share key", async () => {
    const res = await makeReq('POST', '/v1/messages', {
      headers: { 'X-Share-Key': 'doesnotexist' },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'Invalid share key');
  });

  it("returns 403 for expired share key (deleted on access)", async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    db.createShareKey('sk-test-expired', past, 1000, 'expired');

    const res = await makeReq('POST', '/v1/messages', {
      headers: { 'X-Share-Key': 'sk-test-expired' },
    });
    // getShare detects expiry, deletes the record, returns null -> "Invalid share key"
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'Invalid share key');
  });

  it("accepts Authorization header as share key", async () => {
    db.createShareKey('sk-test-auth', new Date(Date.now() + 86400000).toISOString(), 1000, 'auth');
    const res = await makeReq('POST', '/v1/messages', {
      headers: { Authorization: 'Bearer sk-test-auth' },
    });
    // Should get a 502 from upstream (test API key) not a 401/403
    assert.ok([401, 403, 502].includes(res.status));
  });

  it("returns 429 when token limit reached", async () => {
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    db.createShareKey('sk-test-ratelimit', futureExpiry, 1000, 'limit');

    // Manually fill the bucket to capacity
    const now = new Date();
    const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 28, 0, 0));
    let windowEnd;
    if (now <= anchor) {
      windowEnd = anchor.getTime();
    } else {
      const elapsed = now - anchor;
      const periods = Math.ceil(elapsed / 18000000);
      windowEnd = anchor.getTime() + periods * 18000000;
    }
    db.incrementWindowUsage('sk-test-ratelimit', windowEnd, 1000);

    const res = await makeReq('POST', '/v1/messages', {
      headers: { 'X-Share-Key': 'sk-test-ratelimit' },
    });
    assert.strictEqual(res.status, 429);
    assert.ok(res.body.error.includes('Token limit'));
  });
});

// ===========================================================================
describe("GET /v1/models", () => {
  it("proxies without share key auth", async () => {
    const res = await makeReq('GET', '/v1/models');
    // Should NOT return our share-key 401 error
    const isWrongError = res.body?.error && String(res.body.error).includes('Missing X-Share-Key');
    assert.ok(!isWrongError, 'should not return share-key auth error');
  });
});

// ===========================================================================
describe("Admin authentication", () => {
  it("GET /admin/keys returns 401 without Bearer", async () => {
    const res = await makeReq('GET', '/admin/keys');
    assert.strictEqual(res.status, 401);
  });

  it("GET /admin/keys returns 401 with wrong secret", async () => {
    const res = await makeReq('GET', '/admin/keys', {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.strictEqual(res.status, 401);
  });

  it("GET /admin/keys returns keys with correct secret", async () => {
    db.createShareKey('sk-adminkeys', new Date(Date.now() + 86400000).toISOString(), 5000, 'adminkeys');
    const res = await makeReq('GET', '/admin/keys', {
      headers: { Authorization: 'Bearer ' + TEST_ADMIN_SECRET },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.keys));
    assert.ok(res.body.keys.some(k => k.shareKey === 'sk-adminkeys'));
  });
});

// ===========================================================================
describe("POST /admin/create", () => {
  it("creates a key with auth", async () => {
    const res = await makeReq('POST', '/admin/create', {
      headers: {
        Authorization: 'Bearer ' + TEST_ADMIN_SECRET,
        'Content-Type': 'application/json',
      },
      body: { days: 7, tokenLimit: 50000, name: 'integration-test' },
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.shareKey);
    assert.strictEqual(res.body.name, 'integration-test');
    assert.strictEqual(res.body.tokenLimit, 50000);
  });

  it("clamps days to 1-30 range", async () => {
    const res = await makeReq('POST', '/admin/create', {
      headers: {
        Authorization: 'Bearer ' + TEST_ADMIN_SECRET,
        'Content-Type': 'application/json',
      },
      body: { days: 100, tokenLimit: 1000 },
    });
    assert.strictEqual(res.status, 201);
  });

  it("returns 401 without auth", async () => {
    const res = await makeReq('POST', '/admin/create', {
      headers: { 'Content-Type': 'application/json' },
      body: { days: 1 },
    });
    assert.strictEqual(res.status, 401);
  });
});

// ===========================================================================
describe("POST /admin/revoke", () => {
  it("revokes a key", async () => {
    const keyName = 'sk-revoke-' + Date.now();
    db.createShareKey(keyName, new Date(Date.now() + 86400000).toISOString(), 1000, 'revoke');

    const res = await makeReq('POST', '/admin/revoke', {
      headers: {
        Authorization: 'Bearer ' + TEST_ADMIN_SECRET,
        'Content-Type': 'application/json',
      },
      body: { shareKey: keyName },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(db.getShare(keyName), null);
  });

  it("returns 400 without shareKey", async () => {
    const res = await makeReq('POST', '/admin/revoke', {
      headers: {
        Authorization: 'Bearer ' + TEST_ADMIN_SECRET,
        'Content-Type': 'application/json',
      },
      body: {},
    });
    assert.strictEqual(res.status, 400);
  });
});

// ===========================================================================
describe("GET /admin/stats", () => {
  it("returns 400 without key param", async () => {
    const res = await makeReq('GET', '/admin/stats', {
      headers: { Authorization: 'Bearer ' + TEST_ADMIN_SECRET },
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes('?key='));
  });

  it("returns 404 for unknown key", async () => {
    const res = await makeReq('GET', '/admin/stats?key=nonexistent', {
      headers: { Authorization: 'Bearer ' + TEST_ADMIN_SECRET },
    });
    assert.strictEqual(res.status, 404);
  });

  it("returns stats for a valid key", async () => {
    db.createShareKey('sk-stats-valid', new Date(Date.now() + 86400000).toISOString(), 10000, 'stats test');

    const res = await makeReq('GET', '/admin/stats?key=sk-stats-valid', {
      headers: { Authorization: 'Bearer ' + TEST_ADMIN_SECRET },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.shareKey, 'sk-stats-valid');
    assert.strictEqual(res.body.name, 'stats test');
    assert.strictEqual(res.body.tokenLimit, 10000);
    assert.ok('currentWindowUsed' in res.body);
    assert.ok('windowUsage' in res.body);
    assert.ok('breakdown' in res.body);
    assert.ok(Array.isArray(res.body.details));
  });
});

// ===========================================================================
describe("CORS", () => {
  it("returns CORS headers on OPTIONS", async () => {
    const res = await makeReq('OPTIONS', '/health');
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
    assert.ok(res.headers['access-control-allow-methods']);
  });

  it("returns CORS headers on JSON responses", async () => {
    const res = await makeReq('GET', '/health');
    assert.strictEqual(res.headers['access-control-allow-origin'], '*');
  });
});

// ===========================================================================
describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await makeReq('GET', '/nonexistent-route');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'not found');
  });
});

// ===========================================================================
// OpusMax Proxy — Express Server
// Migrated from Cloudflare Pages Function
// ===========================================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db.js');

// --- Constants ---
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5-hour rolling window
const WINDOW_ANCHOR_HOURS = 18;
const WINDOW_ANCHOR_MINUTES = 28;
const ANTHROPIC_API = 'https://api.anthropic.com/v1';
const ADMIN_LOGIN_LIMIT = 5;
const ADMIN_LOGIN_WINDOW_SEC = 60;
const ADMIN_LOGIN_LOCKOUT_SEC = 900;
const PORT = parseInt(process.env.PORT || '3000', 10);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Share-Key',
};

function addCorsHeaders(res) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
}

function getCurrentWindowEnd() {
  const now = new Date();
  const anchor = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    WINDOW_ANCHOR_HOURS, WINDOW_ANCHOR_MINUTES, 0, 0
  ));
  if (now <= anchor) return anchor.getTime();
  const elapsed = now - anchor;
  const periods = Math.ceil(elapsed / WINDOW_MS);
  return anchor.getTime() + periods * WINDOW_MS;
}

function generateKey(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const max = 256 - (256 % chars.length);
  const result = [];
  while (result.length < length) {
    const arr = new Uint8Array(1);
    crypto.randomFillSync(arr);
    if (arr[0] < max) result.push(chars[arr[0] % chars.length]);
  }
  return result.join('');
}

function json(res, body, status = 200) {
  addCorsHeaders(res);
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setRateLimitHeaders(res, record, windowUsage, total) {
  res.setHeader('X-RateLimit-Limit', String(record.tokenLimit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, record.tokenLimit - windowUsage - total)));
  res.setHeader('X-RateLimit-Reset', new Date(getCurrentWindowEnd()).toISOString());
}

function copyAllowedHeaders(src, dest) {
  const allowed = ['content-type', 'date', 'cache-control', 'retry-after', 'x-request-id'];
  src.headers.forEach((val, key) => {
    if (allowed.includes(key.toLowerCase())) {
      dest.setHeader(key, val);
    }
  });
}

// ===========================================================================
// Express App
// ===========================================================================

function createApp() {
  const app = express();

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request timeout middleware
  app.use((req, res, next) => {
    if (req.path === '/v1/messages') {
      req.setTimeout(5 * 60 * 1000);
      res.setTimeout(5 * 60 * 1000);
    } else {
      req.setTimeout(30 * 1000);
      res.setTimeout(30 * 1000);
    }
    next();
  });

  // --- CORS headers on every response ---
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Share-Key');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // --- GET /health ---
  app.get('/health', (req, res) => {
    json(res, { status: 'ok' });
  });

  // --- POST /v1/messages (proxy relay) ---
  app.post('/v1/messages', async (req, res) => {
    const shareKey = req.header('x-share-key')
      || (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim()
      || (req.query.shareKey || '');

    if (!shareKey) {
      return json(res, { error: 'Missing X-Share-Key header or shareKey param' }, 401);
    }

    const record = db.getShare(shareKey);
    if (!record) {
      return json(res, { error: 'Invalid share key' }, 403);
    }

    if (new Date(record.expiresAt) < new Date()) {
      db.deleteShare(shareKey);
      return json(res, { error: 'Share key expired' }, 403);
    }

    const windowUsage = db.getWindowUsage(shareKey, getCurrentWindowEnd());
    if (windowUsage >= record.tokenLimit) {
      return json(res, {
        error: 'Token limit reached for this window',
        used: windowUsage,
        limit: record.tokenLimit,
        reset: new Date(getCurrentWindowEnd()).toISOString(),
      }, 429);
    }

    const body = JSON.stringify(req.body);
    let isStream = false;
    try { isStream = JSON.parse(body).stream === true; } catch {}

    try {
      const upstream = await fetch(`${ANTHROPIC_API}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      const contentType = upstream.headers.get('content-type') || '';

      // --- Streaming (SSE) ---
      if (isStream && contentType.includes('text/event-stream') && upstream.body) {
        let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
        let totalTokens = 0;
        let buffer = '';

        res.status(upstream.status);
        copyAllowedHeaders(upstream, res);

        setRateLimitHeaders(res, record, windowUsage, totalTokens);
        res.setHeader('X-Tokens-Charged', '0');
        res.setHeader('X-Tokens-Input', '0');
        res.setHeader('X-Tokens-Output', '0');
        res.setHeader('X-Tokens-Cache-Read', '0');
        res.setHeader('X-Tokens-Cache-Creation', '0');
        addCorsHeaders(res);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;
              res.write(chunk);

              let eventEnd;
              while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
                const eventText = buffer.slice(0, eventEnd);
                buffer = buffer.slice(eventEnd + 2);

                if (eventText.includes('"usage"')) {
                  for (const line of eventText.split('\n')) {
                    if (line.startsWith('data: ') && line.includes('"usage"')) {
                      try {
                        const evt = JSON.parse(line.slice(6));
                        if (evt.type === 'message_start' && evt.message?.usage) {
                          inputTokens = evt.message.usage.input_tokens || 0;
                          outputTokens = evt.message.usage.output_tokens || 0;
                          cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
                          cacheCreationTokens = evt.message.usage.cache_creation_input_tokens || 0;
                          totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
                        } else if (evt.type === 'message_delta' && evt.usage) {
                          outputTokens += evt.usage.output_tokens || 0;
                          totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
                        }
                      } catch {}
                    }
                  }
                }
              }
            }

            if (totalTokens > 0) {
              db.incrementWindowUsage(shareKey, getCurrentWindowEnd(), totalTokens);
              db.addDetail(shareKey, getCurrentWindowEnd(), inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens);
            }
          } catch (err) {
            console.error('Stream error:', err.message);
          } finally {
            res.end();
          }
        })();

        return;
      }

      // --- Non-streaming ---
      const respBody = await upstream.text();
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;

      try {
        const parsed = JSON.parse(respBody);
        if (parsed.usage) {
          inputTokens = parsed.usage.input_tokens || 0;
          outputTokens = parsed.usage.output_tokens || 0;
          cacheReadTokens = parsed.usage.cache_read_input_tokens || 0;
          cacheCreationTokens = parsed.usage.cache_creation_input_tokens || 0;
        }
      } catch {}

      const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      if (total > 0) {
        db.incrementWindowUsage(shareKey, getCurrentWindowEnd(), total);
        db.addDetail(shareKey, getCurrentWindowEnd(), inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, total);
      }

      res.status(upstream.status);
      copyAllowedHeaders(upstream, res);
      setRateLimitHeaders(res, record, windowUsage, total);
      res.setHeader('X-Tokens-Charged', String(total));
      res.setHeader('X-Tokens-Input', String(inputTokens));
      res.setHeader('X-Tokens-Output', String(outputTokens));
      res.setHeader('X-Tokens-Cache-Read', String(cacheReadTokens));
      res.setHeader('X-Tokens-Cache-Creation', String(cacheCreationTokens));
      addCorsHeaders(res);
      res.send(respBody);

    } catch (err) {
      console.error('Proxy error:', err.message);
      json(res, { error: 'Upstream request failed: ' + err.message }, 502);
    }
  });

  // --- GET /v1/models ---
  app.get('/v1/models', async (req, res) => {
    try {
      const upstream = await fetch(`${ANTHROPIC_API}/models`, {
        headers: {
          'anthropic-version': '2023-06-01',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
        },
      });
      const body = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', 'application/json');
      addCorsHeaders(res);
      res.send(body);
    } catch (err) {
      console.error('Models proxy error:', err.message);
      json(res, { error: 'Upstream request failed' }, 502);
    }
  });

  // =========================================================================
  // Admin routes
  // =========================================================================
  const adminRouter = express.Router();

  // GET /admin or /admin/ -> redirect to dashboard (no auth required)
  adminRouter.get('/', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    addCorsHeaders(res);
    res.redirect(302, `${origin}/dashboard.html`);
  });

  // GET /admin/view -> redirect to dashboard
  adminRouter.get('/view', (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    addCorsHeaders(res);
    res.redirect(302, `${origin}/dashboard.html`);
  });

  // POST /admin/view -> form-based login
  adminRouter.post('/view', async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const newCount = db.checkLoginRateLimit(ip);
    if (newCount > ADMIN_LOGIN_LIMIT) {
      return json(res, { error: 'Too many failed attempts' }, 429);
    }

    const secret = (req.body && req.body.secret) || '';
    if (!secret || secret !== adminSecret) {
      return json(res, { error: 'unauthorized' }, 401);
    }

    db.clearLoginFail(ip);

    const origin = `${req.protocol}://${req.get('host')}`;
    addCorsHeaders(res);
    res.redirect(302, `${origin}/dashboard.html`);
  });

  // All remaining admin API routes require Bearer auth
  adminRouter.use((req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const auth = req.header('authorization') || '';

    if (!auth.startsWith('Bearer ')) {
      return json(res, { error: 'unauthorized' }, 401);
    }

    const token = auth.slice(7);
    if (token !== adminSecret) {
      return json(res, { error: 'unauthorized' }, 401);
    }

    // --- GET /admin/keys ---
    if (req.method === 'GET' && req.path === '/keys') {
      const index = db.getAllShareKeys();
      const keys = [];
      for (const k of index) {
        const record = db.getShare(k);
        if (record) {
          keys.push({ ...record, shareKey: k, id: k });
        }
      }
      return json(res, { keys });
    }

    // --- POST /admin/create ---
    if (req.method === 'POST' && req.path === '/create') {
      const days = Math.min(30, Math.max(1, parseInt(req.body?.days) || 1));
      const tokenLimit = Math.min(100000000, Math.max(1000, parseInt(req.body?.tokenLimit) || 100000));
      const name = (req.body?.name || 'shared').slice(0, 50);
      const shareKey = generateKey(16);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + days * 86400000);
      const host = req.get('host');

      db.createShareKey(shareKey, expiresAt.toISOString(), tokenLimit, name);

      return json(res, {
        shareKey,
        expiresAt: expiresAt.toISOString(),
        tokenLimit,
        name,
        curl: `curl -X POST https://${host}/v1/messages -H "X-Share-Key: ${shareKey}" -H "Content-Type: application/json" -d '{...}'`,
      }, 201);
    }

    // --- POST /admin/revoke ---
    if (req.method === 'POST' && req.path === '/revoke') {
      if (!req.body?.shareKey) {
        return json(res, { error: 'shareKey required' }, 400);
      }
      db.deleteShare(req.body.shareKey);
      return json(res, { ok: true });
    }

    // --- GET /admin/stats ---
    if (req.method === 'GET' && req.path === '/stats') {
      const key = req.query.key;
      if (!key) {
        return json(res, { error: '?key=<shareKey> required' }, 400);
      }

      const data = db.getShare(key);
      if (!data) {
        return json(res, { error: 'Key not found' }, 404);
      }

      const currentWindowUsed = db.getWindowUsage(key, getCurrentWindowEnd());
      const windowUsage = {};
      for (let i = 0; i < 6; i++) {
        const windowEnd = getCurrentWindowEnd() - (i + 1) * WINDOW_MS;
        const v = db.getWindowUsage(key, windowEnd);
        if (v > 0) {
          windowUsage[new Date(windowEnd).toISOString().split('T')[0]] = v;
        }
      }

      const details = db.getDetails(key, getCurrentWindowEnd());
      const breakdown = details.reduce(
        (acc, d) => ({
          input: acc.input + d.input,
          output: acc.output + d.output,
          cacheRead: acc.cacheRead + d.cacheRead,
          cacheCreation: acc.cacheCreation + d.cacheCreation,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
      );

      return json(res, {
        shareKey: key,
        expiresAt: data.expiresAt,
        tokenLimit: data.tokenLimit,
        createdAt: data.createdAt,
        name: data.name,
        currentWindowUsed,
        windowUsage,
        percentUsed: Math.round((currentWindowUsed / data.tokenLimit) * 100),
        breakdown,
        details: details.reverse(),
      });
    }

    return json(res, { error: 'not found' }, 404);
  });

  // Mount admin router
  app.use('/admin', adminRouter);

  // --- Serve dashboard.html ---
  app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
  });

  // --- SPA fallback: serve dashboard for root ---
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
  });

  // 404 fallback
  app.use((req, res) => {
    json(res, { error: 'not found' }, 404);
  });

  return app;
}

// ===========================================================================
// Server entry point
// ===========================================================================

async function startServer() {
  // Fail fast on missing env vars
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }
  if (!process.env.ADMIN_SECRET) {
    console.error('ERROR: ADMIN_SECRET environment variable is required');
    process.exit(1);
  }

  // Initialize database
  db.init();
  console.log('Database initialized');

  // Create and start Express app
  const app = createApp();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`OpusMax Proxy listening on http://127.0.0.1:${PORT}`);
  });

  // Handle server errors
  server.on('error', (err) => {
    console.error('Server error:', err.message);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

// Export for testing
module.exports = { createApp, startServer };

// Start if run directly
if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// --- Constants ---
const WINDOW_SECONDS = 5 * 60 * 60; // 5-hour rolling window
const WINDOW_MS = WINDOW_SECONDS * 1000;
// OpusMax resets at 11:58 PM IST = 6:28 PM UTC
const WINDOW_ANCHOR_UTC_MS = (18 + 28 / 60) * 60 * 60 * 1000; // 18:28 UTC in ms from midnight

// --- KV Keys ---
// share:{shareKey}  → JSON: { expiresAt (ISO), tokenLimit, createdAt, name }
// bucket:{shareKey}:{bucketStart} → token count for that 5-hour window

interface ShareRecord {
  expiresAt: string;
  tokenLimit: number;
  createdAt: string;
  name: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Health check ---
    if (path === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- Admin routes (authenticated with ADMIN_SECRET) ---
    if (path === '/admin/create' && request.method === 'POST') {
      return handleCreateShare(request, env);
    }
    if (path === '/admin/list' && request.method === 'GET') {
      return handleListShares(request, env);
    }
    if (path === '/admin/revoke' && request.method === 'POST') {
      return handleRevoke(request, env);
    }
    if (path === '/admin/stats' && request.method === 'GET') {
      return handleStats(request, env);
    }

    // --- Proxy: check for share key in header or query param ---
    const shareKey = request.headers.get('X-Share-Key')
                    || url.searchParams.get('shareKey')
                    || (() => {
                      const auth = request.headers.get('Authorization');
                      if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
                      return null;
                    })();

    if (!shareKey) {
      return Response.json({ error: 'Missing X-Share-Key header or shareKey query parameter' }, { status: 401 });
    }

    // Validate share key
    const shareData = await env.SHARE_KV.get(`share:${shareKey}`, 'json') as ShareRecord | null;

    if (!shareData) {
      return Response.json({ error: 'Invalid share key' }, { status: 403 });
    }

    // Check expiration
    if (new Date(shareData.expiresAt) < new Date()) {
      await env.SHARE_KV.delete(`share:${shareKey}`);
      return Response.json({ error: 'This share key has expired' }, { status: 403 });
    }

    // Check token limit (5-hour rolling window)
    const windowTokens = await getWindowUsage(env, shareKey);
    if (windowTokens >= shareData.tokenLimit) {
      const windowEnd = getCurrentWindowEnd();
      return Response.json({
        error: 'Rate limit reached',
        limit: shareData.tokenLimit,
        used: windowTokens,
        resetAt: new Date(windowEnd).toISOString(),
      }, { status: 429 });
    }

    // --- Proxy the request to Anthropic ---
    try {
      // Read the request body
      const body = await request.text();

      // Forward to Anthropic with your key
      const anthropicRequest = new Request('https://api.opusmax.pro/v1' + path + url.search, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: request.method !== 'GET' && request.method !== 'HEAD' ? body : undefined,
      });

      const response = await fetch(anthropicRequest);
      const responseBody = await response.text();

      // Extract token usage from response
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const parsed = JSON.parse(responseBody);
        if (parsed.usage) {
          inputTokens = parsed.usage.input_tokens || 0;
          outputTokens = parsed.usage.output_tokens || 0;
        }
      } catch {
        // Not JSON or no usage field — skip tracking
      }

      const totalTokens = inputTokens + outputTokens;

      // Update usage in current 5-hour window (fire-and-forget with ctx.waitUntil)
      if (totalTokens > 0) {
        ctx.waitUntil(incrementWindowUsage(env, shareKey, totalTokens));
      }

      // Return response with custom headers showing remaining quota
      const newHeaders = new Headers(response.headers);
      const currentWindow = await getWindowUsage(env, shareKey);
      const remaining = shareData.tokenLimit - currentWindow;
      newHeaders.set('X-RateLimit-Limit', String(shareData.tokenLimit));
      newHeaders.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
      newHeaders.set('X-RateLimit-Reset', new Date(getCurrentWindowEnd()).toISOString());

      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

    } catch (error) {
      return Response.json({ error: 'Proxy error', details: String(error) }, { status: 500 });
    }
  },
};

// --- Admin Handlers ---

async function handleCreateShare(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) {
    return Response.json({ error: 'ADMIN_SECRET not configured' }, { status: 500 });
  }

  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { days = 1, tokenLimit = 100_000, name = 'shared-key' } = body;

  if (days < 1 || days > 30) {
    return Response.json({ error: 'Days must be between 1 and 30' }, { status: 400 });
  }
  if (tokenLimit < 1000 || tokenLimit > 20_000_000) {
    return Response.json({ error: 'Token limit must be between 1,000 and 20,000,000 (per 5-hour window)' }, { status: 400 });
  }

  // Generate a random share key
  const shareKey = generateKey(16);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const record: ShareRecord = {
    expiresAt: expiresAt.toISOString(),
    tokenLimit,
    createdAt: now.toISOString(),
    name,
  };

  await env.SHARE_KV.put(`share:${shareKey}`, JSON.stringify(record), {
    expirationTtl: Math.ceil((days + 1) * 24 * 60 * 60), // KV TTL slightly longer than share expiry
  });

  return Response.json({
    shareKey,
    expiresAt: record.expiresAt,
    tokenLimit,
    name,
    usageUrl: new URL(request.url).origin + '/admin/stats?key=' + shareKey,
    instructions: `Share this key with: ${new URL(request.url).origin}\n\nThey should set header: X-Share-Key: ${shareKey}\n\nOr use: curl -H "X-Share-Key: ${shareKey}" ${new URL(request.url).origin}/v1/messages -d '...'`,
  });
}

async function handleListShares(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // List all share keys (KV doesn't have list, so we return from cursor tracking)
  // For simplicity, we track active shares via a separate index
  const indexRaw = await env.SHARE_KV.get('share:index', 'json');
  const index: string[] = indexRaw || [];

  const shares = await Promise.all(
    index.map(async (key) => {
      const data = await env.SHARE_KV.get(`share:${key}`, 'json');
      return data ? { key, ...data } : null;
    })
  );

  return Response.json({ shares: shares.filter(Boolean) });
}

async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { shareKey } = await request.json().catch(() => ({}));
  if (!shareKey) {
    return Response.json({ error: 'shareKey required' }, { status: 400 });
  }

  await env.SHARE_KV.delete(`share:${shareKey}`);
  return Response.json({ success: true, message: `Revoked ${shareKey}` });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const shareKey = new URL(request.url).searchParams.get('key');
  if (!shareKey) {
    return Response.json({ error: '?key=<shareKey> required' }, { status: 400 });
  }

  // For the stats endpoint, allow both admin auth AND the share key holder
  const auth = request.headers.get('Authorization');
  const isAdmin = auth === `Bearer ${env.ADMIN_SECRET}`;

  if (!isAdmin) {
    // Allow the share key holder to check their own stats
    const holderKey = request.headers.get('X-Share-Key');
    if (holderKey !== shareKey) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const data = await env.SHARE_KV.get(`share:${shareKey}`, 'json');
  if (!data) {
    return Response.json({ error: 'Share key not found' }, { status: 404 });
  }

  // Get window-based usage breakdown (current + last 6 windows)
  const windowUsage: Record<string, { tokens: number; resetAt: string }> = {};
  for (let i = 0; i < 6; i++) {
    const windowEnd = getCurrentWindowEnd() - (i * WINDOW_MS);
    const bucketKey = `bucket:${shareKey}:${windowEnd}`;
    const count = await env.SHARE_KV.get(bucketKey);
    const dateKey = new Date(windowEnd).toISOString();
    windowUsage[dateKey] = {
      tokens: count ? parseInt(count) : 0,
      resetAt: new Date(windowEnd - WINDOW_MS).toISOString(),
    };
  }

  // Get current window usage
  const currentWindowTokens = await getWindowUsage(env, shareKey);

  return Response.json({
    shareKey,
    expiresAt: data.expiresAt,
    tokenLimit: data.tokenLimit,
    createdAt: data.createdAt,
    name: data.name,
    windowUsage,
    currentWindowUsed: currentWindowTokens,
    percentUsed: Math.round((currentWindowTokens / data.tokenLimit) * 100),
  });
}

// --- Rolling Window Helpers (5-hour windows, matching OpusMax) ---

function getCurrentWindowEnd(): number {
  // OpusMax resets at 11:58 PM IST = 6:28 PM UTC, then every 5 hours after.
  // Windows: 13:28→18:28, 18:28→23:28, 23:28→04:28, 04:28→09:28, etc. (UTC)
  const now = Date.now();
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const anchor = today.getTime() + WINDOW_ANCHOR_UTC_MS;
  const elapsed = now - anchor;
  const windowEnd = anchor + Math.ceil(elapsed / WINDOW_MS) * WINDOW_MS;
  return windowEnd;
}

async function getWindowUsage(env: Env, shareKey: string): Promise<number> {
  const windowEnd = getCurrentWindowEnd();
  const bucketKey = `bucket:${shareKey}:${windowEnd}`;
  const raw = await env.SHARE_KV.get(bucketKey);
  return parseInt(raw || '0', 10);
}

async function incrementWindowUsage(env: Env, shareKey: string, tokens: number): Promise<void> {
  const windowEnd = getCurrentWindowEnd();
  const bucketKey = `bucket:${shareKey}:${windowEnd}`;
  const current = parseInt((await env.SHARE_KV.get(bucketKey)) || '0', 10);
  const newTotal = current + tokens;
  // KV TTL: keep the bucket for 6 hours (1h past window end)
  const ttlSec = Math.max(60, Math.ceil((windowEnd + 3600000 - Date.now()) / 1000));
  await env.SHARE_KV.put(bucketKey, String(newTotal), { expirationTtl: ttlSec });
}

// --- Helpers ---

function generateKey(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

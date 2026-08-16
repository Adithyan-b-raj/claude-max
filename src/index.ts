import Anthropic from 'npm:@anthropic-ai/sdk@0.67.0';

// --- KV Keys ---
// share:{shareKey}  → JSON: { expiresAt (ISO), tokenLimit, usedTokens, createdAt, name }
// usage:{shareKey}:{date} → counter (daily token usage breakdown)

interface ShareRecord {
  expiresAt: string;
  tokenLimit: number;
  usedTokens: number;
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
    const shareKey = request.headers.get('X-Share-Key') || url.searchParams.get('shareKey');

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

    // Check token limit
    if (shareData.usedTokens >= shareData.tokenLimit) {
      return Response.json({
        error: 'Token limit reached',
        limit: shareData.tokenLimit,
        used: shareData.usedTokens,
        resetAt: shareData.expiresAt
      }, { status: 429 });
    }

    // --- Proxy the request to Anthropic ---
    try {
      // Read the request body
      const body = await request.text();

      // Forward to Anthropic with your key
      const anthropicRequest = new Request('https://api.anthropic.com/v1' + path + url.search, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
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

      // Update usage in KV (fire-and-forget with ctx.waitUntil)
      if (totalTokens > 0) {
        ctx.waitUntil(updateUsage(env, shareKey, shareData, totalTokens));
      }

      // Return response with custom headers showing remaining quota
      const newHeaders = new Headers(response.headers);
      const remaining = shareData.tokenLimit - shareData.usedTokens - totalTokens;
      newHeaders.set('X-RateLimit-Limit', String(shareData.tokenLimit));
      newHeaders.set('X-RateLimit-Remaining', String(Math.max(0, remaining)));
      newHeaders.set('X-RateLimit-Reset', shareData.expiresAt);

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
  if (tokenLimit < 1000 || tokenLimit > 10_000_000) {
    return Response.json({ error: 'Token limit must be between 1,000 and 10,000,000' }, { status: 400 });
  }

  // Generate a random share key
  const shareKey = generateKey(16);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const record: ShareRecord = {
    expiresAt: expiresAt.toISOString(),
    tokenLimit,
    usedTokens: 0,
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

  // Get daily usage breakdown (last 7 days)
  const dailyUsage: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const count = await env.SHARE_KV.get(`usage:${shareKey}:${dateStr}`);
    if (count) dailyUsage[dateStr] = parseInt(count);
  }

  return Response.json({
    shareKey,
    ...(data as ShareRecord),
    dailyUsage,
    percentUsed: Math.round(((data as ShareRecord).usedTokens / (data as ShareRecord).tokenLimit) * 100),
  });
}

// --- Helpers ---

async function updateUsage(env: Env, shareKey: string, shareData: ShareRecord, tokens: number): Promise<void> {
  const newTotal = shareData.usedTokens + tokens;
  const updated: ShareRecord = { ...shareData, usedTokens: newTotal };
  await env.SHARE_KV.put(`share:${shareKey}`, JSON.stringify(updated));

  // Track daily usage
  const today = new Date().toISOString().split('T')[0];
  const currentDaily = parseInt((await env.SHARE_KV.get(`usage:${shareKey}:${today}`)) || '0');
  await env.SHARE_KV.put(`usage:${shareKey}:${today}`, String(currentDaily + tokens));
}

function generateKey(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

// ===========================================================================
// OpusMax Proxy — Cloudflare Pages Function
// Handles: proxy relay, admin API, and serves the dashboard.
// ===========================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Share-Key",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Constants ---
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5-hour rolling window
const ANCHOR_EPOCH = Date.UTC(2026, 0, 1, 18, 28, 0, 0); // Anchored to 18:28 UTC (11:58 PM IST)

function getCurrentWindowEnd() {
  const now = Date.now();
  const periods = Math.floor((now - ANCHOR_EPOCH) / WINDOW_MS) + 1;
  return ANCHOR_EPOCH + periods * WINDOW_MS;
}

// --- KV helpers ---
function getShareKey(key) { return `share:${key}`; }
function getBucketKey(key, windowEnd) { return `bucket:${key}:${windowEnd}`; }

const ADMIN_LOGIN_LIMIT = 5;
const ADMIN_LOGIN_WINDOW_SEC = 60;
const ADMIN_LOGIN_LOCKOUT_SEC = 900;

async function checkLoginRateLimit(env, ip) {
  const key = `loginfail:${ip}`;
  const raw = await env.SHARE_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= ADMIN_LOGIN_LIMIT) return false;
  await env.SHARE_KV.put(key, String(count + 1), { expirationTtl: ADMIN_LOGIN_WINDOW_SEC });
  return true;
}

async function recordLoginSuccess(env, ip) {
  await env.SHARE_KV.delete(`loginfail:${ip}`);
}

async function getShareIndex(env) {
  let raw = await env.SHARE_KV.get("share:index", "json");
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  return Array.isArray(raw) ? raw : [];
}

async function getShare(env, key) {
  return env.SHARE_KV.get(getShareKey(key), "json");
}

async function deleteShare(env, key) {
  await env.SHARE_KV.delete(getShareKey(key));
  const index = await getShareIndex(env);
  await env.SHARE_KV.put("share:index", JSON.stringify(index.filter(k => k !== key)));
}

async function addToIndex(env, key) {
  const index = await getShareIndex(env);
  if (!index.includes(key)) {
    await env.SHARE_KV.put("share:index", JSON.stringify([...index, key]));
  }
}

async function getWindowUsage(env, shareKey) {
  const bucketKey = getBucketKey(shareKey, getCurrentWindowEnd());
  return parseInt(await env.SHARE_KV.get(bucketKey) || "0", 10);
}

async function incrementWindowUsage(env, shareKey, tokens) {
  const windowEnd = getCurrentWindowEnd();
  const bucketKey = getBucketKey(shareKey, windowEnd);
  const currentVal = await env.SHARE_KV.get(bucketKey);
  const current = currentVal ? parseInt(currentVal, 10) : 0;
  const finalTotal = current + tokens;
  const ttlSec = Math.max(60, Math.ceil((windowEnd + 3600000 - Date.now()) / 1000));
  await env.SHARE_KV.put(bucketKey, String(finalTotal), { expirationTtl: ttlSec });
}

function generateKey(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const max = 256 - (256 % chars.length);
  const result = [];
  while (result.length < length) {
    const arr = new Uint8Array(1);
    crypto.getRandomValues(arr);
    if (arr[0] < max) result.push(chars[arr[0] % chars.length]);
  }
  return result.join("");
}

// ===========================================================================
// Proxy relay — forwards to Anthropic API via opusmax.pro
// ===========================================================================
async function proxyRelay(request, env, ctx) {
  const shareKey = request.headers.get("x-share-key")
    || request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim()
    || new URL(request.url).searchParams.get("shareKey");

  if (!shareKey) return json({ error: "Missing X-Share-Key header or shareKey param" }, 401);

  const record = await getShare(env, shareKey);
  if (!record) return json({ error: "Invalid share key" }, 403);
  if (new Date(record.expiresAt) < new Date()) {
    await deleteShare(env, shareKey);
    return json({ error: "Share key expired" }, 403);
  }

  const windowUsage = await getWindowUsage(env, shareKey);
  if (windowUsage >= record.tokenLimit) {
    return json({ error: "Token limit reached for this window", used: windowUsage, limit: record.tokenLimit, reset: new Date(getCurrentWindowEnd()).toISOString() }, 429);
  }

  const body = await request.text();
  let isStream = false;
  try { isStream = JSON.parse(body).stream === true; } catch { }

  // Forward all anthropic-* headers from the client (prompt caching, beta features, etc.)
  const upstreamHeaders = {
    "Content-Type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",  // default fallback
  };
  for (const [key, val] of request.headers) {
    if (key.toLowerCase().startsWith("anthropic-")) {
      upstreamHeaders[key] = val;
    }
  }

  const upstream = await fetch("https://api.opusmax.pro/v1/messages", {
    method: "POST",
    headers: upstreamHeaders,
    body,
  });

  const contentType = upstream.headers.get("content-type") || "";

  // --- Streaming (SSE) ---
  if (isStream && contentType.includes("text/event-stream") && upstream.body) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const reader = upstream.body.getReader();
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    let totalTokens = 0;
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          await writer.write(encoder.encode(chunk));

          let eventEnd;
          while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
            const eventText = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);
            // Skip processing event lines if eventText doesn't contain the "usage" keyword,
            // avoiding unnecessary splits and iterations for 99% of formatting events.
            if (eventText.includes('"usage"')) {
              for (const line of eventText.split("\n")) {
                if (line.startsWith("data: ") && line.includes('"usage"')) {
                  try {
                    const evt = JSON.parse(line.slice(6));
                    if (evt.type === "message_start" && evt.message?.usage) {
                      inputTokens = evt.message.usage.input_tokens || 0;
                      outputTokens = evt.message.usage.output_tokens || 0;
                      cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
                      cacheCreationTokens = evt.message.usage.cache_creation_input_tokens || 0;
                      totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
                    } else if (evt.type === "message_delta" && evt.usage) {
                      outputTokens += evt.usage.output_tokens || 0;
                      totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
                    }
                  } catch { }
                }
              }
            }
          }
        }
        if (totalTokens > 0) {
          ctx.waitUntil(incrementWindowUsage(env, shareKey, totalTokens));
          ctx.waitUntil(storeDetail(env, shareKey, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens));
        }
      } catch { /* stream interrupted */ }
      finally { await writer.close(); }
    })();

    const headers = new Headers(upstream.headers);
    headers.set("X-RateLimit-Limit", String(record.tokenLimit));
    headers.set("X-RateLimit-Remaining", String(Math.max(0, record.tokenLimit - windowUsage - totalTokens)));
    headers.set("X-RateLimit-Reset", new Date(getCurrentWindowEnd()).toISOString());
    headers.set("X-Tokens-Charged", String(totalTokens));
    headers.set("X-Tokens-Input", String(inputTokens));
    headers.set("X-Tokens-Output", String(outputTokens));
    headers.set("X-Tokens-Cache-Read", String(cacheReadTokens));
    headers.set("X-Tokens-Cache-Creation", String(cacheCreationTokens));
    return new Response(readable, { status: upstream.status, headers });
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
  } catch { }

  const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  if (total > 0) {
    ctx.waitUntil(incrementWindowUsage(env, shareKey, total));
    ctx.waitUntil(storeDetail(env, shareKey, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, total));
  }

  const headers = new Headers();
  const allowed = new Set(["content-type", "date", "cache-control", "retry-after", "x-request-id"]);
  for (const [key, val] of upstream.headers) {
    if (allowed.has(key.toLowerCase())) headers.set(key, val);
  }
  headers.set("X-RateLimit-Limit", String(record.tokenLimit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, record.tokenLimit - windowUsage - total)));
  headers.set("X-RateLimit-Reset", new Date(getCurrentWindowEnd()).toISOString());
  headers.set("X-Tokens-Charged", String(total));
  headers.set("X-Tokens-Input", String(inputTokens));
  headers.set("X-Tokens-Output", String(outputTokens));
  headers.set("X-Tokens-Cache-Read", String(cacheReadTokens));
  headers.set("X-Tokens-Cache-Creation", String(cacheCreationTokens));
  return new Response(respBody, { status: upstream.status, headers });
}

// Store per-request detail for dashboard
async function storeDetail(env, shareKey, input, output, cacheRead, cacheCreation, total) {
  const winEnd = getCurrentWindowEnd();
  const dk = `detail:${shareKey}:${winEnd}`;
  const existing = await env.SHARE_KV.get(dk);
  const arr = existing ? JSON.parse(existing) : [];
  arr.push({ timestamp: new Date().toISOString(), input, output, cacheRead, cacheCreation, total });
  // Keep only up to 25 items since dashboard displays only the last 20 requests.
  // This reduces JSON payload size dramatically and saves CPU parsing/stringify time.
  if (arr.length > 25) arr.splice(0, arr.length - 25);
  const ttl = Math.max(60, Math.ceil((winEnd + 3600000 - Date.now()) / 1000));
  await env.SHARE_KV.put(dk, JSON.stringify(arr), { expirationTtl: ttl });
}

// ===========================================================================
// Pages Function entry point
// ===========================================================================
// ===========================================================================
// Pages Function entry point
// ===========================================================================
export async function onRequest(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!env.SHARE_KV) {
      return json({ error: "SHARE_KV KV namespace is not bound. Please attach SHARE_KV in Cloudflare Pages Settings -> Functions -> KV namespace bindings." }, 500);
    }

    // Proxy relay
    if (path === "/v1/messages" && request.method === "POST") {
      return await proxyRelay(request, env, context);
    }

    // Model discovery — proxy to upstream so it reflects actual available models
    if (path === "/v1/models" && request.method === "GET") {
      const upstream = await fetch("https://api.opusmax.pro/v1/models", {
        headers: { "anthropic-version": "2023-06-01", "x-api-key": env.ANTHROPIC_API_KEY || "" },
      });
      const body = await upstream.text();
      const headers = new Headers();
      headers.set("content-type", "application/json");
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(body, { status: upstream.status, headers });
    }

    // Generic /v1/* catch-all proxy — handles /v1/messages/count_tokens and other sub-endpoints
    if (path.startsWith("/v1/") && (request.method === "POST" || request.method === "GET")) {
      const catchallHeaders = {
        "Content-Type": request.headers.get("content-type") || "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      };
      for (const [key, val] of request.headers) {
        if (key.toLowerCase().startsWith("anthropic-")) {
          catchallHeaders[key] = val;
        }
      }
      const catchallResp = await fetch(`https://api.opusmax.pro${path}`, {
        method: request.method,
        headers: catchallHeaders,
        body: request.method === "POST" ? await request.text() : undefined,
      });
      const respHeaders = new Headers();
      const allowed = new Set(["content-type", "date", "cache-control", "retry-after", "x-request-id"]);
      for (const [k, v] of catchallResp.headers) {
        if (allowed.has(k.toLowerCase())) respHeaders.set(k, v);
      }
      Object.entries(corsHeaders).forEach(([k, v]) => respHeaders.set(k, v));
      return new Response(catchallResp.body, {
        status: catchallResp.status,
        headers: respHeaders,
      });
    }

    // Health check
    if (path === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }

    // Admin routes — serve the dashboard HTML
    if (path.startsWith("/admin")) {
      const adminSecret = env.ADMIN_SECRET;
      if (!adminSecret) return json({ error: "Set ADMIN_SECRET env var in Cloudflare Pages Settings." }, 503);
      return await handleAdmin(request, env, adminSecret);
    }

    // Serve dashboard.html as a static asset via Pages
    if (request.method === "GET" && path === "/dashboard.html" && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Everything else: serve static files
    if (env.ASSETS) return env.ASSETS.fetch(request);

    // Fallback
    return json({ error: "not found" }, 404);
  } catch (err) {
    return json({ error: err.message || "Internal Worker Error", stack: String(err.stack || err) }, 500);
  }
}

// ===========================================================================
// Admin handler — serves dashboard + JSON API
// ===========================================================================
async function handleAdmin(request, env, adminSecret) {
  const url = new URL(request.url);
  const path = url.pathname;
  const auth = request.headers.get("Authorization") || "";
  const isFormAuth = request.method === "POST" && path === "/admin/view";

  // Allow form-based login (POST /admin/view)
  if (!isFormAuth && !auth.startsWith("Bearer ")) {
    return json({ error: "unauthorized" }, 401);
  }

  // GET /admin or /admin/view → redirect to the SPA dashboard
  if ((request.method === "GET" && (path === "/admin" || path === "/admin/")) || path === "/admin/view") {
    return serveAdminPage(env, new URL(request.url).origin);
  }

  // POST /admin/view → validate secret, then redirect to dashboard
  if (isFormAuth) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await checkLoginRateLimit(env, ip))) return json({ error: "Too many failed attempts" }, 429);
    const form = await request.formData().catch(() => null);
    const secret = form ? form.get("secret") : "";
    if (!secret || secret !== adminSecret) return json({ error: "unauthorized" }, 401);
    await recordLoginSuccess(env, ip);
    return serveAdminPage(env, new URL(request.url).origin);
  }

  // All remaining admin routes need Bearer auth
  const token = auth.slice(7);
  if (token !== adminSecret) return json({ error: "unauthorized" }, 401);

  // List keys
  if (request.method === "GET" && path === "/admin/keys") {
    const index = await getShareIndex(env);
    const rawShares = await Promise.all(index.map(k => getShare(env, k)));
    const keys = [];
    for (let i = 0; i < index.length; i++) {
      if (!rawShares[i]) continue;
      keys.push({ ...rawShares[i], shareKey: index[i], id: index[i] });
    }
    return json({ keys });
  }

  // Create key
  if (request.method === "POST" && path === "/admin/create") {
    const body = await request.json().catch(() => ({}));
    const days = Math.min(30, Math.max(1, parseInt(body.days) || 1));
    const tokenLimit = Math.min(100_000_000, Math.max(1000, parseInt(body.tokenLimit) || 100000));
    const name = (body.name || "shared").slice(0, 50);
    const shareKey = generateKey(16);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 86400000);
    const record = { expiresAt: expiresAt.toISOString(), tokenLimit, createdAt: now.toISOString(), name };
    await env.SHARE_KV.put(`share:${shareKey}`, JSON.stringify(record), { expirationTtl: Math.ceil((days + 1) * 86400) });
    await addToIndex(env, shareKey);
    return json({ shareKey, expiresAt: record.expiresAt, tokenLimit, name, curl: `curl -X POST https://${request.headers.get("host")}/v1/messages -H "X-Share-Key: ${shareKey}" -H "Content-Type: application/json" -d '{...}'` }, 201);
  }

  // Revoke key
  if (request.method === "POST" && path === "/admin/revoke") {
    const body = await request.json().catch(() => ({}));
    if (!body.shareKey) return json({ error: "shareKey required" }, 400);
    await deleteShare(env, body.shareKey);
    return json({ ok: true });
  }

  // Stats (with per-request details + token breakdown)
  if (request.method === "GET" && path.startsWith("/admin/stats")) {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return json({ error: "?key=<shareKey> required" }, 400);
    const data = await getShare(env, key);
    if (!data) return json({ error: "Key not found" }, 404);

    const currentWindowUsed = await getWindowUsage(env, key);
    const windowUsage = {};
    for (let i = 0; i < 6; i++) {
      const windowEnd = getCurrentWindowEnd() - (i + 1) * WINDOW_MS;
      const v = await env.SHARE_KV.get(getBucketKey(key, windowEnd));
      if (v) windowUsage[new Date(windowEnd).toISOString().split("T")[0]] = parseInt(v, 10);
    }

    const detailRaw = await env.SHARE_KV.get(`detail:${key}:${getCurrentWindowEnd()}`);
    const details = detailRaw ? JSON.parse(detailRaw) : [];
    const breakdown = details.reduce(
      (acc, d) => ({ input: acc.input + d.input, output: acc.output + d.output, cacheRead: acc.cacheRead + d.cacheRead, cacheCreation: acc.cacheCreation + d.cacheCreation }),
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    );

    return json({
      shareKey: key, expiresAt: data.expiresAt, tokenLimit: data.tokenLimit,
      createdAt: data.createdAt, name: data.name,
      currentWindowUsed, windowUsage,
      percentUsed: Math.round((currentWindowUsed / data.tokenLimit) * 100),
      breakdown,
      details: details.reverse(),
    });
  }

  return json({ error: "not found" }, 404);
}

// ===========================================================================
// Serve the admin SPA — redirects to /dashboard.html (static asset)
// ===========================================================================
async function serveAdminPage(env, origin) {
  return new Response("", {
    status: 302,
    headers: { Location: `${origin}/dashboard.html` },
  });
}

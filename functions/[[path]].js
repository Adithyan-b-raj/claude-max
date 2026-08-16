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

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function countTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// --- Constants ---
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5-hour rolling window in ms
// OpusMax resets at 11:58 PM IST = 6:28 PM UTC every day
const WINDOW_ANCHOR_HOURS = 18;
const WINDOW_ANCHOR_MINUTES = 28;

function getCurrentWindowEnd() {
  const now = new Date();
  // Anchor to today at 18:28 UTC (11:58 PM IST)
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), WINDOW_ANCHOR_HOURS, WINDOW_ANCHOR_MINUTES, 0, 0));

  if (now <= anchor) {
    return anchor.getTime();
  }

  const elapsed = now - anchor;
  const periods = Math.ceil(elapsed / WINDOW_MS);
  return anchor.getTime() + periods * WINDOW_MS;
}

// --- KV helpers ---
function getShareKey(key) { return `share:${key}`; }
function getBucketKey(key, windowEnd) { return `bucket:${key}:${windowEnd}`; }

async function getShare(env, key) {
  return env.SHARE_KV.get(getShareKey(key), "json");
}

async function deleteShare(env, key) {
  await env.SHARE_KV.delete(getShareKey(key));
  const index = (await env.SHARE_KV.get("share:index", "json")) || [];
  const updated = index.filter((k) => k !== key);
  await env.SHARE_KV.put("share:index", JSON.stringify(updated));
}

async function addToIndex(env, key) {
  const index = (await env.SHARE_KV.get("share:index", "json")) || [];
  if (!index.includes(key)) {
    await env.SHARE_KV.put("share:index", JSON.stringify([...index, key]));
  }
}

async function getWindowUsage(env, shareKey) {
  const windowEnd = getCurrentWindowEnd();
  const bucketKey = getBucketKey(shareKey, windowEnd);
  const raw = await env.SHARE_KV.get(bucketKey);
  return parseInt(raw || "0", 10);
}

async function incrementWindowUsage(env, shareKey, tokens) {
  const windowEnd = getCurrentWindowEnd();
  const bucketKey = getBucketKey(shareKey, windowEnd);
  const current = parseInt((await env.SHARE_KV.get(bucketKey)) || "0", 10);
  const ttlSec = Math.max(60, Math.ceil((windowEnd + 3600000 - Date.now()) / 1000));
  await env.SHARE_KV.put(bucketKey, String(current + tokens), { expirationTtl: ttlSec });
}

function generateKey(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

// --- Dashboard HTML ---
async function dashboard(keys, adminSecret, env) {
  const now = Date.now();
  const windowEnd = getCurrentWindowEnd();

  const rows = keys
    .map(async (k) => {
      const windowUsage = await getWindowUsage(env, k.shareKey);
      const pct = k.tokenLimit > 0 ? Math.min(100, (windowUsage / k.tokenLimit) * 100) : 0;
      const status = k.revoked
        ? '<span class="status revoked">Revoked</span>'
        : now > new Date(k.expiresAt).getTime()
          ? '<span class="status expired">Expired</span>'
          : pct >= 100
            ? '<span class="status exceeded">Cap hit</span>'
            : '<span class="status active">Active</span>';
      const ttl =
        now > new Date(k.expiresAt).getTime()
          ? "expired"
          : `${Math.max(0, Math.round((new Date(k.expiresAt).getTime() - now) / 3600000))}h left`;
      return `<tr>
        <td>${escapeHtml(k.name)}</td>
        <td><code>${escapeHtml(k.shareKey)}</code></td>
        <td>${formatTokens(windowUsage)} / ${formatTokens(k.tokenLimit)}</td>
        <td><div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%"></div></div></td>
        <td>${status}</td>
        <td>${ttl}</td>
        <td class="actions">
          <button onclick="copyKey('${escapeHtml(k.shareKey)}')">Copy</button>
          <button onclick="revokeKey('${escapeHtml(k.shareKey)}')" class="danger">Revoke</button>
        </td>
      </tr>`;
    });

  const activeKeys = keys.filter((k) => !k.revoked && now <= new Date(k.expiresAt).getTime());
  const windowUsages = await Promise.all(activeKeys.map((k) => getWindowUsage(env, k.shareKey)));
  const totalUsed = windowUsages.reduce((a, u) => a + u, 0);
  const totalCap = activeKeys.reduce((a, k) => a + k.tokenLimit, 0);
  const activeCount = activeKeys.filter((k, i) => windowUsages[i] < k.tokenLimit).length;
  const renderedRows = await Promise.all(rows);

  const windowReset = new Date(getCurrentWindowEnd()).toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
  });
  const remainingMin = Math.max(0, Math.round((windowEnd - now) / 60000));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OpusMax Proxy</title>
<style>
  :root { --bg: #ffffff; --card: #ffffff; --border: #000000; --text: #000000; --muted: #666666; --line: #e5e5e5; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 32px 24px; max-width: 1200px; margin: 0 auto; line-height: 1.5; }
  h1 { font-size: 1.1rem; margin-bottom: 8px; font-weight: 500; letter-spacing: -0.01em; }
  h2 { font-size: 0.7rem; margin-bottom: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; font-weight: 500; }
  .card { background: var(--card); border: 1px solid var(--border); padding: 24px; margin-bottom: 2px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border-top: 1px solid var(--border); border-left: 1px solid var(--border); margin-bottom: 24px; }
  .stat { text-align: left; padding: 16px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .stat .value { font-size: 1.6rem; font-weight: 500; letter-spacing: -0.02em; }
  .stat .label { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; font-weight: 500; }
  form { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 0.7rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
  input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; font-size: 0.85rem; outline: none; transition: border-color 0.15s; border-radius: 0; }
  input:focus { border-color: var(--text); }
  button { border: 1px solid var(--border); padding: 10px 20px; font-size: 0.8rem; font-weight: 500; cursor: pointer; color: var(--text); background: var(--text); color: var(--bg); transition: all 0.15s; letter-spacing: 0.02em; border-radius: 0; }
  button:hover { opacity: 0.75; }
  button.danger { background: var(--bg); color: var(--text); }
  button.secondary { background: var(--bg); color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 12px 8px; border-bottom: 1px solid var(--border); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
  td { padding: 14px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  td code { font-size: 0.75rem; background: var(--bg); padding: 4px 8px; border: 1px solid var(--line); font-family: ui-monospace, monospace; letter-spacing: 0.02em; }
  .bar-wrap { border-bottom: 1px solid var(--text); height: 16px; width: 100%; min-width: 80px; position: relative; }
  .bar { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--text); transition: width 0.3s; }
  .status { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; }
  .status.active { text-decoration: underline; text-underline-offset: 3px; }
  .status.expired, .status.exceeded { color: var(--muted); }
  .status.revoked { text-decoration: line-through; color: var(--muted); }
  .actions { display: flex; gap: 8px; }
  .actions button { padding: 6px 14px; font-size: 0.72rem; background: var(--bg); color: var(--text); border: 1px solid var(--border); }
  .empty { color: var(--muted); text-align: center; padding: 32px; font-size: 0.85rem; letter-spacing: 0.02em; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(8px); background: var(--text); color: var(--bg); padding: 12px 24px; font-size: 0.82rem; opacity: 0; transition: all 0.2s; pointer-events: none; z-index: 100; font-weight: 500; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #login-form .field:first-child { flex: 1; min-width: 200px; }
  .footer { text-align: center; color: var(--muted); font-size: 0.7rem; margin-top: 32px; letter-spacing: 0.04em; text-transform: uppercase; }
</style>
</head>
<body>

  <!-- Login -->
  <div id="login-section" class="card" style="max-width:420px;margin:60px auto">
    <h1>OpusMax Proxy</h1>
    <p style="color:var(--muted);font-size:0.85rem;margin-bottom:16px">Enter the admin secret to manage shared API keys.</p>
    <form id="login-form" onsubmit="return doLogin(event)">
      <div class="field">
        <label>Admin secret</label>
        <input type="password" id="secret" placeholder="Enter admin secret" autofocus />
      </div>
      <button type="submit">Unlock dashboard</button>
    </form>
  </div>

  <!-- Dashboard (hidden until login) -->
  <div id="dashboard" style="display:none">
    <div class="card">
      <h1>Create shared key</h1>
      <form onsubmit="return createKey(event)" style="margin-top:12px">
        <div class="field">
          <label>Label</label>
          <input id="f-name" placeholder="e.g. friend" />
        </div>
        <div class="field">
          <label>TTL (days, 1–30)</label>
          <input id="f-ttl" type="number" value="1" min="1" max="30" />
        </div>
        <div class="field">
          <label>Token limit</label>
          <input id="f-cap" type="number" value="100000" min="1000" step="1000" />
        </div>
        <button type="submit">Create key</button>
      </form>
    </div>

    <div class="card">
      <h1>Shared keys</h1>
      <div class="grid">
        <div class="stat"><div class="value">${keys.length}</div><div class="label">Total keys</div></div>
        <div class="stat"><div class="value">${activeCount}</div><div class="label">Active</div></div>
        <div class="stat"><div class="value">${formatTokens(totalUsed)}</div><div class="label">Tokens used (this window)</div></div>
        <div class="stat"><div class="value">${formatTokens(totalCap)}</div><div class="label">Total cap</div></div>
      </div>
      <div class="card" style="margin-bottom:24px;padding:12px 24px;display:flex;gap:24px;align-items:center;flex-wrap:wrap">
        <span style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:500">Window</span>
        <span style="font-size:0.85rem">5-hour rolling &middot; resets at <strong>${windowReset} IST</strong></span>
        <span style="font-size:0.85rem;color:var(--muted)">&middot; ${remainingMin}m remaining</span>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Label</th><th>Key</th><th>Usage</th><th>Quota</th><th>Status</th><th>TTL</th><th></th></tr></thead>
          <tbody>${renderedRows.length ? renderedRows.join("") : `<tr><td colspan="7" class="empty">No keys yet</td></tr>`}</tbody>
        </table>
      </div>
      <div style="margin-top:16px">
        <button class="secondary" onclick="location.reload()">Refresh</button>
      </div>
    </div>

    <div class="footer">OpusMax Proxy &mdash; API keys managed securely via Cloudflare Workers + KV</div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const SECRET = ${JSON.stringify(adminSecret)};
    const API_BASE = "";

    function toast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 2200);
    }

    async function api(method, path, body) {
      const opts = { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + SECRET } };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(API_BASE + path, opts);
      if (r.status === 401) { alert("Invalid admin secret"); return; }
      return r;
    }

    function doLogin(e) {
      e.preventDefault();
      const v = document.getElementById("secret").value.trim();
      if (!v) return false;
      sessionStorage.setItem("adminSecret", v);
      location.reload();
      return false;
    }

    async function createKey(e) {
      e.preventDefault();
      const name = document.getElementById("f-name").value.trim() || "shared";
      const ttl = parseInt(document.getElementById("f-ttl").value) || 1;
      const cap = parseInt(document.getElementById("f-cap").value) || 100000;
      const r = await api("POST", "/admin/create", { days: ttl, tokenLimit: cap, name });
      const data = await r.json();
      if (r.ok) { toast("Key created: " + data.shareKey); location.reload(); }
      else toast(data.error || "Error creating key");
      return false;
    }

    async function copyKey(key) {
      await navigator.clipboard.writeText(key);
      toast("Copied: " + key);
    }

    async function revokeKey(key) {
      const r = await api("POST", "/admin/revoke", { shareKey: key });
      if (r.ok) { toast("Key revoked"); location.reload(); }
      else toast("Failed to revoke");
    }

    // Auto-login if secret in session
    if (sessionStorage.getItem("adminSecret")) {
      document.getElementById("login-section").style.display = "none";
      document.getElementById("dashboard").style.display = "";
    }
  </script>
</body>
</html>`;
}

// --- Pages Function handler ---
// Pages Functions use `onRequest` with a context object, not Worker-style `fetch`.
export const onRequest = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---- Proxy relay: /v1/messages ----
  if (path === "/v1/messages" && request.method === "POST") {
    return proxyRelay(request, env, context);
  }

  // ---- Model discovery: /v1/models ----
  if (path === "/v1/models" && request.method === "GET") {
    return proxyModels(request, env);
  }

  // ---- Admin routes (require Bearer admin secret) ----
  if (path.startsWith("/admin")) {
    return handleAdmin(request, env);
  }

  // ---- Health check ----
  if (path === "/health") {
    return json({ status: "ok", timestamp: new Date().toISOString() });
  }

  // ---- Everything else: serve static files ----
  // On Pages, env.ASSETS is the static asset fetcher
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  // Fallback: serve the dashboard
  if (path === "/" || path === "/index.html") {
    const adminSecret = await env.SHARE_KV.get("adminSecret");
    if (!adminSecret) {
      // First-time setup screen
      return new Response(dashboard([], "", env), {
        headers: { "content-type": "text/html" },
      });
    }
    const index = (await env.SHARE_KV.get("share:index", "json")) || [];
    const keys = [];
    for (const k of index) {
      const data = await getShare(env, k);
      if (data) keys.push({ ...data, shareKey: k, id: k });
    }
    return new Response(dashboard(keys, adminSecret, env), {
      headers: { "content-type": "text/html" },
    });
  }

  return json({ error: "not found" }, 404);
};

// ---- Model discovery ----
async function proxyModels(request, env) {
  // Validate share key for model listing
  const shareKey = request.headers.get("x-share-key")
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
    || new URL(request.url).searchParams.get("shareKey");
  if (!shareKey) return json({ error: "Missing X-Share-Key header or shareKey param" }, 401);

  const record = await getShare(env, shareKey);
  if (!record) return json({ error: "Invalid share key" }, 403);

  const upstream = await fetch("https://api.opusmax.pro/v1/models", {
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
  });

  const data = await upstream.json();
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

// ---- Proxy relay ----
async function proxyRelay(request, env, ctx) {
  const shareKey = request.headers.get("x-share-key")
    || (() => {
      const auth = request.headers.get("Authorization");
      if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
      return null;
    })()
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

  // Detect stream mode from request body
  let isStream = false;
  try { isStream = JSON.parse(body).stream === true; } catch {}

  const upstream = await fetch("https://api.opusmax.pro/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body,
  });

  const contentType = upstream.headers.get("content-type") || "";

  // --- Streaming (SSE): pipe through, parse usage in real-time ---
  if (isStream && contentType.includes("text/event-stream") && upstream.body) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const reader = upstream.body.getReader();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          await writer.write(encoder.encode(chunk));

          // Look for usage in last line of buffer
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ") && line.includes("\"usage\"")) {
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "message_start" && evt.message?.usage) {
                  inputTokens = evt.message.usage.input_tokens || 0;
                  outputTokens = evt.message.usage.output_tokens || 0;
                  cacheReadTokens = evt.message.usage.cache_read_input_tokens || 0;
                  cacheCreationTokens = evt.message.usage.cache_creation_input_tokens || 0;
                } else if (evt.type === "message_delta" && evt.usage) {
                  outputTokens = evt.usage.output_tokens || outputTokens;
                }
              } catch {}
            }
          }
          // Keep last 2 lines for cross-chunk parsing
          const keep = lines.slice(-2).join("\n");
          buffer = keep;
        }
        const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
        if (total > 0) ctx.waitUntil(incrementWindowUsage(env, shareKey, total));
      } catch (e) {
        // Stream interrupted — best-effort count what we have
      } finally {
        await writer.close();
      }
    })();

    const headers = new Headers(upstream.headers);
    headers.set("X-RateLimit-Limit", String(record.tokenLimit));
    headers.set("X-RateLimit-Remaining", String(Math.max(0, record.tokenLimit - windowUsage)));
    headers.set("X-RateLimit-Reset", new Date(getCurrentWindowEnd()).toISOString());

    return new Response(readable, { status: upstream.status, headers });
  }

  // --- Non-streaming: buffer and extract usage from JSON ---
  const respBody = await upstream.text();
  let inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreationTokens = 0;

  try {
    const parsed = JSON.parse(respBody);
    if (parsed.usage) {
      inputTokens = parsed.usage.input_tokens || 0;
      outputTokens = parsed.usage.output_tokens || 0;
      cacheReadTokens = parsed.usage.cache_read_input_tokens || 0;
      cacheCreationTokens = parsed.usage.cache_creation_input_tokens || 0;
    }
  } catch {
    // Non-JSON / unexpected format
  }

  const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  if (total > 0) {
    ctx.waitUntil(incrementWindowUsage(env, shareKey, total));
  }

  const headers = new Headers(upstream.headers);
  const windowAfterThis = windowUsage + total;
  headers.set("X-RateLimit-Limit", String(record.tokenLimit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, record.tokenLimit - windowAfterThis)));
  headers.set("X-RateLimit-Reset", new Date(getCurrentWindowEnd()).toISOString());

  return new Response(respBody, { status: upstream.status, headers });
}

// ---- Admin handler ----
async function handleAdmin(request, env) {
  try {
    const auth = request.headers.get("Authorization");
    const adminSecret = await env.SHARE_KV.get("adminSecret");
    const path = new URL(request.url).pathname;

    // Bootstrap: first time setup (no auth required)
    if (!adminSecret) {
      if (request.method === "POST" && path === "/admin/init") {
        const body = await request.json().catch(() => ({}));
        if (!body.adminSecret) return json({ error: "adminSecret required" }, 400);
        await env.SHARE_KV.put("adminSecret", body.adminSecret);
        return json({ ok: true });
      }
      return json({ error: "not_initialized", message: "POST /admin/init with {adminSecret: '...'}" }, 503);
    }

    // All admin routes require Bearer auth (dashboard and API alike)
    if (auth !== `Bearer ${adminSecret}`) return json({ error: "unauthorized" }, 401);

    // GET /admin — serve the dashboard HTML
    if (request.method === "GET" && (path === "/admin" || path === "/admin/")) {
      const index = (await env.SHARE_KV.get("share:index", "json")) || [];
      const rawShares = await Promise.all(index.map(k => getShare(env, k)));
      const keys = [];
      for (let i = 0; i < index.length; i++) {
        if (!rawShares[i]) continue;
        keys.push({ ...rawShares[i], shareKey: index[i], id: index[i] });
      }
      const windowUsages = await Promise.all(keys.map(k => getWindowUsage(env, k.shareKey)));
      for (let i = 0; i < keys.length; i++) keys[i].windowUsage = windowUsages[i];
      return new Response(await dashboard(keys, adminSecret, env), {
        headers: { "content-type": "text/html" },
      });
    }

  // List keys
  if (request.method === "GET" && path === "/admin/keys") {
    const index = (await env.SHARE_KV.get("share:index", "json")) || [];
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
    const tokenLimit = Math.min(10_000_000, Math.max(1000, parseInt(body.tokenLimit) || 100000));
    const name = (body.name || "shared").slice(0, 50);

    const shareKey = generateKey(16);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 86400000);

    const record = {
      expiresAt: expiresAt.toISOString(),
      tokenLimit,
      usedTokens: 0,
      createdAt: now.toISOString(),
      name,
    };

    await env.SHARE_KV.put(`share:${shareKey}`, JSON.stringify(record));
    await addToIndex(env, shareKey);

    return json({
      shareKey,
      expiresAt: record.expiresAt,
      tokenLimit,
      name,
      curl: `curl -X POST https://${request.headers.get("host")}/v1/messages -H "X-Share-Key: ${shareKey}" -H "Content-Type: application/json" -d '{...}'`,
    }, 201);
  }

  // Revoke key
  if (request.method === "POST" && path === "/admin/revoke") {
    const body = await request.json().catch(() => ({}));
    if (!body.shareKey) return json({ error: "shareKey required" }, 400);
    await deleteShare(env, body.shareKey);
    return json({ ok: true });
  }

  // Stats
  if (request.method === "GET" && path.startsWith("/admin/stats")) {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return json({ error: "?key=<shareKey> required" }, 400);
    const data = await getShare(env, key);
    if (!data) return json({ error: "Key not found" }, 404);

    const daily = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      const v = await env.SHARE_KV.get(`usage:${key}:${ds}`);
      if (v) daily[ds] = parseInt(v);
    }

    return json({
      shareKey: key,
      ...data,
      dailyUsage: daily,
      percentUsed: Math.round((data.usedTokens / data.tokenLimit) * 100),
    });
  }

  return json({ error: "not found" }, 404);
  } catch (err) {
    console.error("Admin handler error:", err);
    return json({ error: "internal_error", message: err.message }, 500);
  }
}

# OpusMax Proxy — Cloudflare Pages

Share your Claude API key with time-based expiration, token limits, and a built-in dashboard.

## Deploy to Cloudflare Pages

1. Push this repo to GitHub
2. Create a new Pages project → connect repo
3. In **Settings → Functions → KV Namespaces**, bind `SHARE_KV`:
   - Production ID: `<your kv namespace id>`
4. In **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your Claude API key (encrypted)
5. Deploy — visit your Pages URL, you'll get the admin dashboard

## First-time setup

1. Visit your Pages URL → you'll see the login screen
2. POST to `/admin/init` to set your admin secret:
   ```bash
   curl -X POST https://YOUR_PROJECT.pages.dev/admin/init \
     -H "Content-Type: application/json" \
     -d '{"adminSecret": "your-secret-password"}'
   ```
3. Log in with that secret at `/admin`

## How it works

The dashboard at `/admin` lets you:
- **Create shared keys** — set name, TTL (1-30 days), token limit
- **Revoke keys** — instant kill switch
- **Track usage** — see token consumption per key

Shared users call the API at `/v1/messages` with `X-Share-Key: <shareKey>` — exactly like the Anthropic API, just a different base URL and one extra header.

## No build step needed

This is plain JS — Cloudflare Pages runs it directly. No npm install, no framework, no build config.

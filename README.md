# OpusMax Proxy

Share your Claude API key with time-based expiration, token limits, and a built-in dashboard.

## What It Does

- **API Proxy** — forwards `/v1/messages` and `/v1/models` to Anthropic
- **Shared Keys** — generate time-limited keys with per-window token budgets
- **Admin Dashboard** — web UI for key management and usage monitoring
- **Streaming Support** — full SSE streaming passthrough with token tracking
- **Rate Limiting** — per-key token windows and admin login protection

## Routes

| Route | Method | Auth | Description |
|---|---|---|---|
| `/v1/messages` | POST | Share key | Proxy to Anthropic API |
| `/v1/models` | GET | None | Model discovery proxy |
| `/health` | GET | None | Health check |
| `/admin/keys` | GET | Bearer | List all keys |
| `/admin/create` | POST | Bearer | Create new key |
| `/admin/revoke` | POST | Bearer | Revoke key |
| `/admin/stats` | GET | Bearer | Key usage stats |
| `/admin/view` | POST | Form | Dashboard login |
| `/dashboard.html` | GET | None | Admin dashboard |

## Deployment

### AWS EC2 (Recommended)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for step-by-step instructions.

Quick start:
```bash
npm install
cp .env.example .env
# Edit .env with your keys
npm start
```

### Cloudflare Pages (Legacy)

The original Cloudflare Pages deployment is preserved in `functions/[[path]].js` and `wrangler.toml`.

```bash
wrangler pages project create opusmax-proxy
wrangler pages deploy .
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `ADMIN_SECRET` | Yes | Admin dashboard password |
| `DATABASE_PATH` | No | SQLite file path (default: `./data/opusmax.db`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | Environment (default: `production`) |

## Testing

```bash
npm test
```

## Backup

See [BACKUP.md](./BACKUP.md) for automated backup and restore procedures.

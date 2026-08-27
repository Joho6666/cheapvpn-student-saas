# Recommended deployment

Use `compose.yml` with Docker and Caddy. Copy `.env.production.example` to `.env.production`, set `DOMAIN`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, a strong non-placeholder `ADMIN_PASSWORD`, a random non-placeholder `ADMIN_ENCRYPTION_KEY` of at least 32 characters, manual or webhook payment settings, and at least one real upstream source. Webhook mode also requires a non-placeholder signing secret of at least 32 characters.

```bash
npm ci
npm run build
npm run test:all
docker compose up -d --build
curl -i https://your-domain/health/ready
```

Only Caddy should be reachable from the Internet; do not expose port 4000 directly. `health` means the process is alive; `health/ready` is the launch gate and must return 200. Schedule `docker compose exec app npm run backup` and copy the backup outside the host.

Local fixture tests may set `ALLOW_PRIVATE_UPSTREAM_URLS=true`. Never copy that value into production. Cloudflare deployment is experimental: run Wrangler bundle dry-run first, ensure the token has Worker, D1 migration and secret permissions, and do not assume `wrangler whoami` proves those permissions.

Root release ZIPs are retained for compatibility but duplicate the source. Prefer GitHub Releases for future distribution; do not delete the existing archives during V1.0 cleanup.

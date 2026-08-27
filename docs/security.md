# Security controls

- `safeRemoteFetch` permits only HTTP(S), rejects URL credentials, resolves DNS before every request, pins the approved address for the request, revalidates every redirect, limits redirect depth, and rejects loopback, unspecified, RFC1918, link-local, metadata, multicast and IPv6 ULA addresses.
- `ALLOW_PRIVATE_UPSTREAM_URLS` defaults to `false`. It is only enabled by isolated local tests and production startup refuses it.
- Supplier URLs are checked when an administrator saves them and again immediately before a request. Credentials and complete upstream URLs are never returned by admin APIs or logs.
- Express and Caddy emit CSP compatible with the current Vite/Tailwind/font assets, Permissions-Policy, HSTS in production, `nosniff` and Referrer-Policy.
- Logs are JSON lines with an allowlist of identifiers and statuses. Passwords, sessions, subscription tokens, payment secrets, provider tokens and full URLs are excluded.

Before launch, use HTTPS, a strong admin password, a random encryption key, a non-mock payment mode, an explicitly configured CORS allowlist, daily off-host SQLite backups and a real supplier with customer-level usage if accurate quota accounting is required.

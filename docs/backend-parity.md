# Node / Worker backend parity

Node API is the V1.0 specification. The Worker is an experimental compatibility path and is intentionally not feature-complete.

Node-only or Node-first behavior currently includes:

- `GET /api/admin/metrics` with UTC daily/monthly revenue and operational metrics.
- SQLite-backed sessions, password reset mail injection, payment event idempotency and the open-order unique index.
- Provider source management, usage synchronization, source assignment, support tickets and token reset.
- Caddy/Docker production preflight and the `ALLOW_PRIVATE_UPSTREAM_URLS` test-only guard.

The Worker may continue to serve its existing compatible public routes, but new ProviderAdapter methods, Metrics, SQLite migrations and operations UI must not be added there until a separate parity project is approved. Deploy the Node/Docker path for real customers.

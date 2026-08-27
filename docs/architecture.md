# CheapVPN V1.0 architecture

The recommended production path is Node.js, Docker and Caddy. Cloudflare Worker remains an experimental alternative and does not receive new Node business adapters or operating metrics.

```text
Browser -> Caddy (HTTPS, headers) -> Express -> SQLite -> ProviderAdapter -> Supplier
```

`server/index.js` owns production startup, signal handling and background jobs. `server/app.js` owns the Express application and keeps API compatibility. Environment parsing is in `server/config/env.js`; SQLite schema, migrations and the open-order preflight are in `server/db/database.js`. `GenericSubscriptionProvider` handles safe supplier reads, while `MockProvider` is reserved for isolated tests. Payment callbacks remain application-owned and use an idempotent event claim.

SQLite is the source of truth for users, orders, payment events, sessions, subscriptions, usage snapshots, referrals and support tickets. In-memory session/rate-limit caches are performance helpers only; authenticated sessions survive an API restart because their hashes are persisted.

The API deliberately does not pretend that a generic subscription URL can create, renew or disable supplier accounts. Those operations return `PROVIDER_OPERATION_UNSUPPORTED` until a real supplier adapter is implemented and tested.

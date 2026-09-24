# Resource pools and unified subscriptions

Node/Docker is the supported runtime for resource pools. A pool contains one or more enabled upstream sources. New paid subscriptions bind to the default pool and receive one CheapVPN URL whose Universal, Clash, and Sing-box payloads contain all healthy members.

## Operations

Open `/#admin` → `资源配置` to create a pool, select its sources, make it the default, preview its health, or sync all active subscriptions in that pool. Preview reports only healthy source count, node totals, deduplicated node totals, and protocol counts; it never returns upstream URLs, raw nodes, or credentials.

Every sync records a run and a per-subscription source assignment. A failed member is kept for audit and omitted from generated content. If every member fails, the last known working subscription payload stays available and the subscription sync state becomes `stale`.

Nodes are deduplicated using an internal SHA-256 fingerprint of protocol, endpoint, authentication identity, and transport parameters. Display names do not affect deduplication, so the same node from two suppliers is emitted once.

## Usage boundary

The pool does not sum shared supplier traffic counters. With exactly one healthy source, its existing `subscription-userinfo` aggregate remains visible as an upstream aggregate and is not enforced as a customer quota. With multiple healthy sources, the app does not invent a combined per-customer quota. Exact limits require a supplier per-customer Usage/Provider API or a gateway you operate.

## Deployment migration boundary

Cloudflare Worker/D1 remains an experimental backend and is not kept in live sync with Node/SQLite. Before a future production cutover, back up D1, export non-secret business data, deploy the Node/Docker stack on a new subdomain, and re-enter or securely re-encrypt upstream/payment credentials with the Node deployment key. Do not copy encrypted Worker secrets or raw subscription payloads into SQLite. Validate users, orders, active subscriptions, `/health/ready`, and customer imports on the new subdomain before switching the production domain.

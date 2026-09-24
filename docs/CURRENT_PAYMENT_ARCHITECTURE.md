# CheapVPN current payment architecture

Production payment source of truth is **Docker / Express + SQLite**. Cloudflare Worker payment routes stay experimental and are **not** the official WeChat/Alipay entry.

## 1. Current payment flow (before Native QR)

1. Signed-in customer `POST /api/orders` with `{ planId, renewal }` and `Idempotency-Key`.
2. Server prices the order in cents, inserts `orders.status='pending'`, 30-minute `expires_at`.
3. Mode-specific collection:
   - `mock`: customer `POST /api/orders/:id/confirm` (blocked in production).
   - `manual`: customer submits a payment reference; admin confirms.
   - `webhook`: generic HMAC JSON at `POST /api/webhooks/payment`.
4. Historical `completeOrder()` fetched upstream **before** marking the order paid. A failed upstream call could roll `processing` back to `pending` after money was already taken. Native QR payments must not do that.

There was no `payments` table, no WeChat Native `code_url`, and no Alipay `alipay.trade.precreate`. Frontend `qrcode` only rendered subscription import URLs.

## 2. Reusable capabilities

- Order lifecycle, one open order per user, 30-minute expiry, processing recovery.
- `payment_events.provider_event_id UNIQUE` and amount checks via `toCents`.
- Subscription activate/renew logic (now `activatePaidOrder()` after money is recorded).
- Admin manual confirm as fallback.
- Health/ready payment gate and production startup preflight.
- Existing mock / manual / HMAC e2e tests.

## 3. Capabilities added for trial operations

- Unified Payment Provider adapters: `wechat`, `alipay`, `mock` (Stripe/PayPal later).
- `payments` table, QR content strings, provider trade numbers, query throttle.
- WeChat Pay API v3 Native + Alipay face-to-face precreate.
- Official notify verification (not screenshots, not “I paid”).
- `completePayment()` then `activatePaidOrder()` so paid money is never rolled back.
- Activation retry for paid-but-not-activated orders.
- Customer payment modal with locally generated QR codes.
- Admin payment list, query, close, and retry-activation.

## 4. Files touched

- `server/db/database.js`, `server/config/env.js`, `server/app.js`, `server/observability/logger.js`
- `server/payments/**`
- `src/app.js`, `src/payment-modal.js`, `src/style.css`
- `.env.example`, `.env.production.example`
- `cloudflare/migrations/0006_payments.sql` (schema only; Worker is not the production PSP)
- `docs/PAYMENT_SETUP.md`, `docs/PAYMENT_PRODUCTION_CHECKLIST.md`, `docs/backend-parity.md`
- `scripts/payment-*-e2e.mjs`, `package.json`

## 5. Risks

- WeChat/Alipay merchant category may refuse VPN goods; adapters exist, unofficial collection is not implemented.
- Worker and Express payment behavior must not silently diverge — Worker stays non-production.
- Secrets in env/Docker only; never log private keys, APIv3 keys, or full subscription URLs.
- Concurrent webhooks must stay idempotent on `provider_event_id`.

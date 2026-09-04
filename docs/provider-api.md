# Provider and payment adapter contract

`ProviderAdapter` exposes these operations:

- `getStatus()`
- `getSubscription(url, options)`
- `getUsage(url, options)`
- `createCustomer(input)`
- `renewCustomer(input)`
- `disableCustomer(input)`

Every implementation should return provider data with an explicit `source` and throw an error with a stable `code`. The generic supplier implementation supports read-only subscription and usage endpoints. Customer lifecycle operations intentionally throw `PROVIDER_OPERATION_UNSUPPORTED`; a failed upstream operation must never be reported as a successful activation.

`MockProvider` is only for tests. It must not be selected by a production startup. Payment is similarly separated into mock, manual and webhook modes. Webhook requests are verified against the raw body, claim a globally unique event ID, compare integer cents, and claim the order before activation.

Amounts remain decimal `REAL` values in the compatible SQLite/API schema for V1.0. Application comparisons and calculations use integer cents. A future migration can add `amount_cents INTEGER`, backfill with `ROUND(amount * 100)`, verify `amount_cents / 100.0 = amount` for every order/event, then switch reads and writes in one maintenance release; do not drop the decimal columns until rollback has been ruled out.

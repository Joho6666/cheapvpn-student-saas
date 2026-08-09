import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = 4500 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const secret = "payment-e2e-secret";
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-payment-"));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "payment-admin-password",
    ADMIN_ENCRYPTION_KEY: "payment-admin-encryption-key",
    PAYMENT_WEBHOOK_SECRET: secret,
    PAYMENT_MODE: "webhook",
    ALLOW_DEMO_SUBSCRIPTION: "true",
    PAYMENT_CHECKOUT_URL_TEMPLATE: "https://pay.example.test/checkout?order_id={orderId}&amount={amount}",
    UPSTREAM_SUBSCRIPTION_URL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
      server.kill();
    });
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* The child process is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Payment test server did not start. ${output}`);
}

async function request(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function expectOk(result, message) {
  assert.equal(result.response.ok, true, `${message}: ${JSON.stringify(result.data)}`);
  return result.data;
}

try {
  await waitForHealth();
  const suffix = crypto.randomBytes(4).toString("hex");
  const registration = expectOk(await request("/api/auth/register", { method: "POST", body: {
    name: "Webhook Buyer", email: `webhook-${suffix}@example.test`, password: "password123",
  } }), "webhook registration");
  const paymentConfig = expectOk(await request("/api/payment/config", { headers: { Authorization: `Bearer ${registration.token}` } }), "payment configuration");
  assert.equal(paymentConfig.ready, true, "webhook payment should report ready when checkout and signature are configured");
  const plans = expectOk(await request("/api/plans"), "webhook plans");
  const orderResponse = expectOk(await request("/api/orders", { method: "POST", headers: { Authorization: `Bearer ${registration.token}` }, body: { planId: plans.plans[0].id, renewal: false } }), "webhook order creation");
  assert.match(orderResponse.order.checkoutUrl, /^https:\/\/pay\.example\.test\/checkout/);

  const payload = {
    provider: "test-provider",
    eventId: `evt_${suffix}`,
    orderId: orderResponse.order.id,
    status: "paid",
    amount: orderResponse.order.amount,
  };
  const rawPayload = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");
  const paid = expectOk(await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": signature }, body: payload }), "signed payment webhook");
  assert.equal(paid.subscription.status, "active");
  assert.match(paid.subscription.links.universal, /\/s\//);

  const duplicate = expectOk(await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": signature }, body: payload }), "duplicate payment webhook");
  assert.equal(duplicate.duplicate, true, "duplicate event should be idempotent");
  const retryPayload = { ...payload, eventId: `evt_retry_${suffix}` };
  const retrySignature = crypto.createHmac("sha256", secret).update(JSON.stringify(retryPayload)).digest("hex");
  const paidRetry = expectOk(await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": retrySignature }, body: retryPayload }), "paid order retry webhook");
  assert.equal(paidRetry.alreadyPaid, true, "a different retry event for a paid order should remain successful");

  const failedOrder = expectOk(await request("/api/orders", { method: "POST", headers: { Authorization: `Bearer ${registration.token}` }, body: { planId: plans.plans[0].id, renewal: true } }), "failed payment order creation");
  const conflictingPayload = { ...payload, orderId: failedOrder.order.id };
  const conflictingSignature = crypto.createHmac("sha256", secret).update(JSON.stringify(conflictingPayload)).digest("hex");
  const conflictingEvent = await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": conflictingSignature }, body: conflictingPayload });
  assert.equal(conflictingEvent.response.status, 409, "a payment event cannot be reused for another order");
  assert.equal(conflictingEvent.data.error.code, "PAYMENT_EVENT_CONFLICT");
  const failedPayload = { provider: "test-provider", eventId: `evt_failed_${suffix}`, orderId: failedOrder.order.id, status: "failed", amount: failedOrder.order.amount };
  const failedRaw = JSON.stringify(failedPayload);
  const failedSignature = crypto.createHmac("sha256", secret).update(failedRaw).digest("hex");
  const failed = expectOk(await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": failedSignature }, body: failedPayload }), "failed payment webhook");
  assert.equal(failed.status, "failed", "failed payment should release the pending order");

  const invalid = await request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": "bad-signature" }, body: { ...payload, eventId: `evt_bad_${suffix}` } });
  assert.equal(invalid.response.status, 401, "invalid webhook signature should be rejected");

  console.log("Payment webhook E2E passed: checkout URL, signed payment, subscription activation, idempotency, signature rejection");
} finally {
  await stop();
}

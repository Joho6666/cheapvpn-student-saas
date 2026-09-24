import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheapvpn-payment-race-"));
const port = 6200 + Math.floor(Math.random() * 200);
Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ADMIN_PASSWORD: "duplicate-payment-admin", ADMIN_ENCRYPTION_KEY: "duplicate-payment-encryption-key",
  PAYMENT_MODE: "webhook", PAYMENT_WEBHOOK_SECRET: "duplicate-payment-secret",
  PAYMENT_CHECKOUT_URL_TEMPLATE: "https://pay.example.test/checkout?order={orderId}&amount={amount}",
  ALLOW_DEMO_SUBSCRIPTION: "true", ALLOW_DEMO_ACCOUNT: "false",
});
const { closeDatabase, createApp } = await import("../server/app.js");
const api = createApp().listen(port, "127.0.0.1");
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.headers || {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { response, data: await response.json() };
  };
  const email = `payment-race-${Date.now()}@example.test`;
  const registered = await request("/api/auth/register", { method: "POST", body: { email, password: "password123", name: "Payment Race" } });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token: registered.data.token, body: { planId: plans.data.plans[0].id } });
  assert.equal(order.response.status, 201, JSON.stringify(order.data));
  const payload = JSON.stringify({ provider: "fixture", eventId: `evt-${Date.now()}`, orderId: order.data.order.id, status: "paid", amount: order.data.order.amount });
  const signature = crypto.createHmac("sha256", "duplicate-payment-secret").update(payload).digest("hex");
  const results = await Promise.all(Array.from({ length: 10 }, () => request("/api/webhooks/payment", { method: "POST", headers: { "x-cheapvpn-signature": signature }, body: JSON.parse(payload) })));
  assert.equal(results.filter((result) => result.response.status === 200).length, 10, JSON.stringify(results.map((result) => result.data)));
  assert.equal(results.filter((result) => !result.data.duplicate).length, 1, JSON.stringify(results.map((result) => result.data)));
  const subscription = await request("/api/subscription", { token: registered.data.token });
  assert.equal(subscription.response.status, 200, JSON.stringify(subscription.data));
  console.log("Duplicate payment E2E passed: ten concurrent identical webhooks yielded one active subscription");
} finally {
  await new Promise((resolve) => api.close(resolve));
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

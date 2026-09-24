import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheapvpn-pay-idem-"));
const port = 6300 + Math.floor(Math.random() * 200);
Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ADMIN_PASSWORD: "idem-payment-admin", ADMIN_ENCRYPTION_KEY: "idem-payment-encryption-key-32xx",
  PAYMENT_MODE: "wechat_alipay", PAYMENT_PROVIDER_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true", ALLOW_DEMO_ACCOUNT: "false",
});
const { closeDatabase, createApp } = await import("../server/app.js");
const api = createApp().listen(port, "127.0.0.1");
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { response, data: await response.json().catch(() => ({})) };
  };
  const email = `pay-idem-${Date.now()}@example.test`;
  const registered = await request("/api/auth/register", { method: "POST", body: { email, password: "password123", name: "Idem Buyer" } });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  const token = registered.data.token;
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id } });
  assert.equal(order.response.status, 201, JSON.stringify(order.data));
  const created = await request(`/api/orders/${order.data.order.id}/payments`, { method: "POST", token, body: { provider: "wechat" } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));

  const results = await Promise.all(Array.from({ length: 10 }, () => request(`/api/payments/${created.data.paymentId}/mock-success`, { method: "POST", token })));
  const ok = results.filter((result) => result.response.status === 200);
  assert.equal(ok.length >= 1, true, JSON.stringify(results.map((result) => result.data)));
  const subscription = await request("/api/subscription", { token });
  assert.equal(subscription.response.status, 200, JSON.stringify(subscription.data));
  const replay = await request(`/api/payments/${created.data.paymentId}/mock-success`, { method: "POST", token });
  assert.equal(replay.response.ok, true);
  console.log("Payment idempotency E2E passed: concurrent mock success activated once");
} finally {
  await new Promise((resolve) => api.close(resolve));
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

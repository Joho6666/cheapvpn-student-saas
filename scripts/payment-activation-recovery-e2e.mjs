import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheapvpn-pay-recover-"));
const port = 6400 + Math.floor(Math.random() * 200);
const providerPort = 6500 + Math.floor(Math.random() * 200);
let failUpstream = true;
const provider = createServer((req, res) => {
  if (failUpstream) {
    res.writeHead(503);
    res.end("upstream down");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("vless://uuid@example.test:443?security=tls#Recovered%20Node\n");
});
await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));

Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ADMIN_PASSWORD: "recover-admin-password", ADMIN_ENCRYPTION_KEY: "recover-admin-encryption-key-32",
  PAYMENT_MODE: "wechat_alipay", PAYMENT_PROVIDER_MODE: "mock",
  ALLOW_DEMO_SUBSCRIPTION: "false", ALLOW_DEMO_ACCOUNT: "false", ALLOW_PRIVATE_UPSTREAM_URLS: "true",
  UPSTREAM_SUBSCRIPTION_URL: `http://127.0.0.1:${providerPort}/sub`,
});
const { closeDatabase, createApp, db } = await import("../server/app.js");
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
  const admin = await request("/api/admin/auth/login", { method: "POST", body: { password: "recover-admin-password" } });
  assert.equal(admin.response.status, 200, JSON.stringify(admin.data));
  await request("/api/admin/sources", { method: "POST", token: admin.data.token, body: { name: "recover-source", url: `http://127.0.0.1:${providerPort}/sub` } });

  const email = `recover-${Date.now()}@example.test`;
  const registered = await request("/api/auth/register", { method: "POST", body: { email, password: "password123", name: "Recover Buyer" } });
  const token = registered.data.token;
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id } });
  const payment = await request(`/api/orders/${order.data.order.id}/payments`, { method: "POST", token, body: { provider: "wechat" } });
  const paid = await request(`/api/payments/${payment.data.paymentId}/mock-success`, { method: "POST", token });
  assert.equal(paid.response.ok, false, JSON.stringify(paid.data));

  const row = db.prepare("SELECT status, activation_status, amount FROM orders WHERE id = ?").get(order.data.order.id);
  assert.equal(row.status, "paid");
  assert.notEqual(row.activation_status, "active");

  failUpstream = false;
  const retried = await request(`/api/admin/orders/${order.data.order.id}/retry-activation`, { method: "POST", token: admin.data.token });
  assert.equal(retried.response.ok, true, JSON.stringify(retried.data));
  const subscription = await request("/api/subscription", { token });
  assert.equal(subscription.response.status, 200, JSON.stringify(subscription.data));
  console.log("Payment activation recovery E2E passed: paid order survived upstream failure and admin retry opened the subscription");
} finally {
  await new Promise((resolve) => api.close(resolve));
  closeDatabase();
  await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheapvpn-order-"));
const port = 5700 + Math.floor(Math.random() * 300);
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = "order-concurrency-admin";
process.env.ADMIN_ENCRYPTION_KEY = "order-concurrency-encryption-key";
process.env.PAYMENT_MODE = "mock";
process.env.ALLOW_DEMO_SUBSCRIPTION = "true";
process.env.ALLOW_DEMO_ACCOUNT = "false";
process.env.ALLOW_PRIVATE_UPSTREAM_URLS = "true";

const { closeDatabase, createApp } = await import("../server/app.js");
const api = createApp().listen(port, "127.0.0.1");
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { response, data: await response.json() };
  };
  const registered = await request("/api/auth/register", { method: "POST", body: { email: `order-${Date.now()}@example.test`, password: "password123", name: "Order Race" } });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.data));
  const plans = await request("/api/plans");
  const results = await Promise.all(Array.from({ length: 10 }, () => request("/api/orders", { method: "POST", token: registered.data.token, body: { planId: plans.data.plans[0].id } })));
  const created = results.filter((result) => result.response.status === 201);
  assert.equal(created.length, 1, JSON.stringify(results.map((result) => result.data)));
  assert.equal(results.filter((result) => result.response.status === 409).length, 9);
  console.log("Order concurrency E2E passed: ten simultaneous creates yielded one open order");
} finally {
  await new Promise((resolve) => api.close(resolve));
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

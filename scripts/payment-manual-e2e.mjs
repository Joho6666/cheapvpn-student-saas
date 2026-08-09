import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-manual-payment-"));
const apiPort = 4800 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${apiPort}`;
const email = `manual-${crypto.randomBytes(4).toString("hex")}@example.test`;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(apiPort), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "manual-admin-password", ADMIN_ENCRYPTION_KEY: "manual-encryption-key", PAYMENT_MODE: "manual",
    PAYMENT_MANUAL_INSTRUCTIONS: "请向客服提供订单号并完成转账。", ALLOW_DEMO_SUBSCRIPTION: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) server.kill();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Manual payment test server did not start: ${output}`);
}
async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}
function ok(result, message) { assert.equal(result.response.ok, true, `${message}: ${JSON.stringify(result.data)}`); return result.data; }

try {
  await waitForHealth();
  const customer = ok(await request("/api/auth/register", { method: "POST", body: { name: "Manual Buyer", email, password: "password123" } }), "register");
  const plans = ok(await request("/api/plans"), "plans");
  const payment = ok(await request("/api/payment/config", { token: customer.token }), "payment config");
  assert.equal(payment.mode, "manual");
  assert.match(payment.manualInstructions, /订单号/);
  const order = ok(await request("/api/orders", { method: "POST", token: customer.token, body: { planId: plans.plans[0].id } }), "create manual order");
  const customerConfirm = await request(`/api/orders/${order.order.id}/confirm`, { method: "POST", token: customer.token });
  assert.equal(customerConfirm.response.status, 409, "customer must not confirm a manual payment");
  const admin = ok(await request("/api/admin/auth/login", { method: "POST", body: { password: "manual-admin-password" } }), "admin login");
  const pendingOrders = ok(await request("/api/admin/orders", { token: admin.token }), "admin orders");
  assert.equal(pendingOrders.orders.find((item) => item.id === order.order.id)?.status, "pending");
  assert.equal(pendingOrders.pagination.total >= 1, true, "admin orders should expose pagination metadata");
  const pendingFiltered = ok(await request("/api/admin/orders?status=pending&q=manual", { token: admin.token }), "filtered admin orders");
  assert.equal(pendingFiltered.orders.some((item) => item.id === order.order.id), true, "admin orders should filter by customer and status");
  const paid = ok(await request(`/api/admin/orders/${order.order.id}/confirm`, { method: "POST", token: admin.token }), "admin confirm");
  assert.equal(paid.subscription.status, "active");
  const duplicate = ok(await request(`/api/admin/orders/${order.order.id}/confirm`, { method: "POST", token: admin.token }), "duplicate admin confirm");
  assert.equal(duplicate.alreadyPaid, true, "manual confirmation should be idempotent");
  const subscription = ok(await request("/api/subscription", { token: customer.token }), "customer subscription");
  assert.equal(subscription.subscription.status, "active");
  console.log("Manual payment E2E passed: instructions, customer order, admin confirmation, idempotency");
} finally {
  await stop();
}

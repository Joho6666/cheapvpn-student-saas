import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-payment-config-"));
const port = 5200 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "payment-config-admin", PAYMENT_MODE: "webhook", PAYMENT_CHECKOUT_URL_TEMPLATE: "https://pay.example.test/{orderId}",
    PAYMENT_WEBHOOK_SECRET: "", ALLOW_DEMO_SUBSCRIPTION: "true" },
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
  throw new Error(`Payment config test server did not start: ${output}`);
}
async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}

try {
  await waitForHealth();
  const registered = await request("/api/auth/register", { method: "POST", body: { name: "Config guard", email: "config-guard@example.test", password: "password123" } });
  assert.equal(registered.response.status, 201);
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token: registered.data.token, body: { planId: plans.data.plans[0].id } });
  assert.equal(order.response.status, 503, "an incomplete webhook configuration must block order creation");
  assert.equal(order.data.error.code, "PAYMENT_NOT_CONFIGURED");
  const admin = await request("/api/admin/auth/login", { method: "POST", body: { password: "payment-config-admin" } });
  assert.equal(admin.response.status, 200);
  const unsafeCheckout = await request("/api/admin/settings/payment", { method: "PUT", token: admin.data.token, body: { mode: "webhook", checkoutTemplate: "javascript:alert(1)", webhookSecret: "secret" } });
  assert.equal(unsafeCheckout.response.status, 400, "non-http checkout templates must be rejected");
  assert.equal(unsafeCheckout.data.error.code, "INVALID_CHECKOUT_URL");
  const manualConfig = await request("/api/admin/settings/payment", { method: "PUT", token: admin.data.token, body: { mode: "manual", manualInstructions: "" } });
  assert.equal(manualConfig.response.status, 200);
  const manualOrder = await request("/api/orders", { method: "POST", token: registered.data.token, body: { planId: plans.data.plans[0].id } });
  assert.equal(manualOrder.response.status, 503, "manual payment without instructions must block order creation");
  assert.equal(manualOrder.data.error.code, "PAYMENT_NOT_CONFIGURED");
  console.log("Payment config guard E2E passed: incomplete webhook/manual setup cannot create unpayable orders");
} finally {
  await stop();
}

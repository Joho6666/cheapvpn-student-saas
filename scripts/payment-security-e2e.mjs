import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPaymentUrl } from "../server/payments/httpClient.js";

const port = 4800 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-pay-sec-"));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "security-admin-password", ADMIN_ENCRYPTION_KEY: "security-admin-encryption-key32",
    PAYMENT_MODE: "wechat_alipay", PAYMENT_PROVIDER_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) {
    await new Promise((resolve) => { const timer = setTimeout(resolve, 3000); server.once("exit", () => { clearTimeout(timer); resolve(); }); server.kill(); });
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Payment security server did not start. ${output}`);
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
  assert.throws(() => assertPaymentUrl("http://127.0.0.1/secret"), /PAYMENT/);
  assert.throws(() => assertPaymentUrl("https://evil.example/pay"), /PAYMENT_HOST_NOT_ALLOWED/);
  assertPaymentUrl("https://api.mch.weixin.qq.com/v3/pay/transactions/native");

  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await request("/api/auth/register", { method: "POST", body: { name: "User A", email: `a-${suffix}@example.test`, password: "password123" } });
  const b = await request("/api/auth/register", { method: "POST", body: { name: "User B", email: `b-${suffix}@example.test`, password: "password123" } });
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token: a.data.token, body: { planId: plans.data.plans[0].id } });
  const payment = await request(`/api/orders/${order.data.order.id}/payments`, { method: "POST", token: a.data.token, body: { provider: "wechat" } });
  assert.equal(payment.response.status, 201, JSON.stringify(payment.data));
  assert.equal(JSON.stringify(payment.data).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(payment.data).includes("BEGIN"), false);

  const idor = await request(`/api/payments/${payment.data.paymentId}/status`, { token: b.data.token });
  assert.equal(idor.response.status, 404);

  const missing = await request("/api/payments/does-not-exist/status", { token: a.data.token });
  assert.equal(missing.response.status, 404);

  const liveReadyPort = port + 19;
  const liveReadyDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-pay-ready-"));
  const liveReady = spawn(process.execPath, ["server/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(liveReadyPort), DATA_DIR: liveReadyDir,
      PUBLIC_BASE_URL: `http://127.0.0.1:${liveReadyPort}`, ADMIN_PASSWORD: "security-admin-password",
      ADMIN_ENCRYPTION_KEY: "security-admin-encryption-key32", PAYMENT_MODE: "wechat_alipay",
      PAYMENT_PROVIDER_MODE: "live", ALLOW_DEMO_SUBSCRIPTION: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${liveReadyPort}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const ready = await fetch(`http://127.0.0.1:${liveReadyPort}/health/ready`).then(async (response) => ({ response, data: await response.json().catch(() => ({})) }));
  assert.equal(ready.response.status, 503);
  assert.equal(ready.data.checks.payment_provider_not_ready, false);
  liveReady.kill();
  await fs.rm(liveReadyDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

  const livePort = port + 17;
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-pay-live-"));
  const live = spawn(process.execPath, ["server/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(livePort), DATA_DIR: liveDir,
      PUBLIC_BASE_URL: `http://127.0.0.1:${livePort}`, ADMIN_PASSWORD: "security-admin-password",
      ADMIN_ENCRYPTION_KEY: "security-admin-encryption-key32", PAYMENT_MODE: "manual",
      PAYMENT_PROVIDER_MODE: "live", PAYMENT_MANUAL_INSTRUCTIONS: "pay support", ALLOW_DEMO_SUBSCRIPTION: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${livePort}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const mockBlocked = await fetch(`http://127.0.0.1:${livePort}/api/payments/x/mock-success`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.notEqual(mockBlocked.status, 200);
  live.kill();
  await fs.rm(liveDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });

  console.log("Payment security E2E passed: IDOR, host allowlist, no secrets in QR payload, ready gate, mock-success blocked in live mode");
} finally {
  await stop();
}

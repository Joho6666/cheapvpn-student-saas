import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signAlipayParams, verifyAlipaySignature } from "../server/payments/providers/alipay.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPrivate = privateKey.export({ type: "pkcs8", format: "pem" });
const alipayPublic = publicKey.export({ type: "spki", format: "pem" });

const port = 4700 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-alipay-"));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "alipay-admin-password", ADMIN_ENCRYPTION_KEY: "alipay-admin-encryption-key-32",
    PAYMENT_MODE: "wechat_alipay", PAYMENT_PROVIDER_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true",
    ALIPAY_ENABLED: "true", ALIPAY_APP_ID: "2021000000000001",
    ALIPAY_PRIVATE_KEY: appPrivate.replaceAll("\n", "\\n"),
    ALIPAY_PUBLIC_KEY: alipayPublic.replaceAll("\n", "\\n"),
    ALIPAY_GATEWAY: "https://openapi.alipay.com/gateway.do",
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
  throw new Error(`Alipay test server did not start. ${output}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": options.contentType || "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.headers || {}) },
    body: options.rawBody !== undefined ? options.rawBody : options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { response, data, text };
}

function signedForm(params) {
  const unsigned = { ...params };
  const sign = signAlipayParams(appPrivate, unsigned);
  return new URLSearchParams({ ...unsigned, sign, sign_type: "RSA2" }).toString();
}

try {
  await waitForHealth();
  const sample = { app_id: "2021000000000001", out_trade_no: "abc", trade_status: "TRADE_SUCCESS", total_amount: "9.90" };
  assert.equal(verifyAlipaySignature(alipayPublic, sample, signAlipayParams(appPrivate, sample)), true);

  const suffix = crypto.randomBytes(4).toString("hex");
  const registration = await request("/api/auth/register", { method: "POST", body: { name: "Alipay Buyer", email: `alipay-${suffix}@example.test`, password: "password123" } });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
  const token = registration.data.token;
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id } });
  assert.equal(order.response.status, 201, JSON.stringify(order.data));
  const created = await request(`/api/orders/${order.data.order.id}/payments`, { method: "POST", token, body: { provider: "alipay" } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.match(created.data.qrContent, /^cheapvpn:\/\/mock-payment\//);

  const form = signedForm({
    app_id: "2021000000000001",
    out_trade_no: created.data.paymentId,
    trade_no: `ali_${suffix}`,
    trade_status: "TRADE_SUCCESS",
    total_amount: Number(order.data.order.amount).toFixed(2),
    gmt_payment: "2026-09-04 12:00:00",
  });
  const paid = await request("/api/payments/alipay/notify", { method: "POST", rawBody: form, contentType: "application/x-www-form-urlencoded" });
  assert.equal(paid.response.status, 200, paid.text);
  assert.equal(paid.text, "success");

  const status = await request(`/api/payments/${created.data.paymentId}/status`, { token });
  assert.equal(status.data.status, "active", JSON.stringify(status.data));

  const duplicate = await request("/api/payments/alipay/notify", { method: "POST", rawBody: form, contentType: "application/x-www-form-urlencoded" });
  assert.equal(duplicate.response.status, 200, duplicate.text);

  const badForm = new URLSearchParams({ app_id: "2021000000000001", out_trade_no: created.data.paymentId, trade_no: "x", trade_status: "TRADE_SUCCESS", total_amount: "9.90", sign: "bad", sign_type: "RSA2" }).toString();
  const invalid = await request("/api/payments/alipay/notify", { method: "POST", rawBody: badForm, contentType: "application/x-www-form-urlencoded" });
  assert.equal(invalid.response.status, 500);

  const finishedOrder = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id, renewal: true } });
  const finishedPay = await request(`/api/orders/${finishedOrder.data.order.id}/payments`, { method: "POST", token, body: { provider: "alipay" } });
  const finishedForm = signedForm({
    app_id: "2021000000000001",
    out_trade_no: finishedPay.data.paymentId,
    trade_no: `ali_fin_${suffix}`,
    trade_status: "TRADE_FINISHED",
    total_amount: Number(finishedOrder.data.order.amount).toFixed(2),
  });
  const finished = await request("/api/payments/alipay/notify", { method: "POST", rawBody: finishedForm, contentType: "application/x-www-form-urlencoded" });
  assert.equal(finished.response.status, 200, finished.text);

  console.log("Alipay payment E2E passed: QR create, notify, TRADE_FINISHED, duplicate, bad signature");
} finally {
  await stop();
}

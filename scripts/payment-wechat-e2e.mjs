import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signWechatRequest, wechatNotifyMessage, decryptWechatResource } from "../server/payments/providers/wechatPay.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantPrivate = privateKey.export({ type: "pkcs8", format: "pem" });
const platformPublic = publicKey.export({ type: "spki", format: "pem" });
const apiV3Key = "a".repeat(32);
const serial = "PUBKEYIDTEST001";

const port = 4600 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-wechat-"));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "wechat-admin-password", ADMIN_ENCRYPTION_KEY: "wechat-admin-encryption-key-32",
    PAYMENT_MODE: "wechat_alipay", PAYMENT_PROVIDER_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true",
    WECHAT_PAY_ENABLED: "true", WECHAT_PAY_APP_ID: "wx123", WECHAT_PAY_MCH_ID: "1900000001",
    WECHAT_PAY_CERT_SERIAL_NO: serial, WECHAT_PAY_PRIVATE_KEY: merchantPrivate.replaceAll("\n", "\\n"),
    WECHAT_PAY_API_V3_KEY: apiV3Key, WECHAT_PAY_PUBLIC_KEY: platformPublic.replaceAll("\n", "\\n"),
    WECHAT_PAY_PUBLIC_KEY_ID: serial,
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`WeChat test server did not start. exit=${server.exitCode} ${output}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": options.contentType || "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.headers || {}) },
    body: options.rawBody !== undefined ? options.rawBody : options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function encryptResource(plain) {
  const nonce = "nonce12char!";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce, "utf8"));
  cipher.setAAD(Buffer.from("transaction", "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: "AEAD_AES_256_GCM", ciphertext: encrypted.toString("base64"), nonce, associated_data: "transaction" };
}

function signedNotify(bodyObject) {
  const body = JSON.stringify(bodyObject);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = "notify-nonce";
  const signature = signWechatRequest(merchantPrivate, wechatNotifyMessage({ timestamp, nonceStr, body }));
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonceStr,
      "Wechatpay-Signature": signature,
      "Wechatpay-Serial": serial,
    },
  };
}

try {
  await waitForHealth();
  const decrypted = decryptWechatResource(apiV3Key, encryptResource({ trade_state: "SUCCESS", amount: { total: 990, currency: "CNY" } }));
  assert.equal(decrypted.trade_state, "SUCCESS");

  const suffix = crypto.randomBytes(4).toString("hex");
  const registration = await request("/api/auth/register", { method: "POST", body: { name: "WeChat Buyer", email: `wechat-${suffix}@example.test`, password: "password123" } });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
  const token = registration.data.token;
  const plans = await request("/api/plans");
  const order = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id } });
  assert.equal(order.response.status, 201, JSON.stringify(order.data));
  const created = await request(`/api/orders/${order.data.order.id}/payments`, { method: "POST", token, body: { provider: "wechat" } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.match(created.data.qrContent, /^cheapvpn:\/\/mock-payment\//);
  assert.equal(created.data.status, "pending");

  const resource = {
    mchid: "1900000001", appid: "wx123", out_trade_no: created.data.paymentId,
    transaction_id: `wx_txn_${suffix}`, trade_state: "SUCCESS",
    amount: { total: 990, currency: "CNY" }, success_time: new Date().toISOString(),
  };
  const notifyBody = { id: `evt_${suffix}`, resource_type: "encrypt-resource", event_type: "TRANSACTION.SUCCESS", resource: encryptResource(resource) };
  const signed = signedNotify(notifyBody);
  const paid = await request("/api/payments/wechat/notify", { method: "POST", headers: signed.headers, rawBody: signed.body, contentType: "application/json" });
  assert.equal(paid.response.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.code, "SUCCESS");

  const status = await request(`/api/payments/${created.data.paymentId}/status`, { token });
  assert.equal(status.data.status, "active", JSON.stringify(status.data));

  const duplicate = await request("/api/payments/wechat/notify", { method: "POST", headers: signed.headers, rawBody: signed.body, contentType: "application/json" });
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.data));

  const bad = signedNotify(notifyBody);
  bad.headers["Wechatpay-Signature"] = "AAAA";
  const invalid = await request("/api/payments/wechat/notify", { method: "POST", headers: bad.headers, rawBody: bad.body, contentType: "application/json" });
  assert.equal(invalid.response.status, 401);

  const other = await request("/api/auth/register", { method: "POST", body: { name: "Other", email: `other-${suffix}@example.test`, password: "password123" } });
  const forbidden = await request(`/api/payments/${created.data.paymentId}/status`, { token: other.data.token });
  assert.equal(forbidden.response.status, 404);

  const mismatchOrder = await request("/api/orders", { method: "POST", token, body: { planId: plans.data.plans[0].id, renewal: true } });
  const mismatchPay = await request(`/api/orders/${mismatchOrder.data.order.id}/payments`, { method: "POST", token, body: { provider: "wechat" } });
  const badAmount = {
    ...resource, out_trade_no: mismatchPay.data.paymentId, transaction_id: `wx_bad_${suffix}`,
    amount: { total: 1, currency: "CNY" },
  };
  const mismatchSigned = signedNotify({ id: `evt_bad_${suffix}`, resource: encryptResource(badAmount) });
  const mismatch = await request("/api/payments/wechat/notify", { method: "POST", headers: mismatchSigned.headers, rawBody: mismatchSigned.body, contentType: "application/json" });
  assert.equal(mismatch.response.status, 409, JSON.stringify(mismatch.data));

  console.log("WeChat payment E2E passed: QR create, signed notify, duplicate, bad signature, IDOR, amount mismatch");
} finally {
  await stop();
}

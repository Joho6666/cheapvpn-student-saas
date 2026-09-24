import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheapvpn-reset-"));
const port = 6000 + Math.floor(Math.random() * 200);
Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
  ADMIN_PASSWORD: "password-reset-admin", ADMIN_ENCRYPTION_KEY: "password-reset-encryption-key",
  PAYMENT_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true", ALLOW_DEMO_ACCOUNT: "false",
  SMTP_URL: "smtp://fixture.example.test", EMAIL_FROM: "CheapVPN <noreply@example.test>",
});
let mail;
const { closeDatabase, createApp } = await import("../server/app.js");
const api = createApp({ mailer: { sendMail: async (message) => { mail = message; } } }).listen(port, "127.0.0.1");
const baseUrl = `http://127.0.0.1:${port}`;
try {
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { response, data: await response.json() };
  };
  const email = `reset-${Date.now()}@example.test`;
  assert.equal((await request("/api/auth/register", { method: "POST", body: { email, password: "oldpassword", name: "Reset User" } })).response.status, 201);
  const forgot = await request("/api/auth/password/forgot", { method: "POST", body: { email } });
  assert.equal(forgot.response.status, 200);
  assert.ok(mail?.text, "injected mailer should capture reset message");
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("reset");
  assert.ok(token, "reset URL should contain a token");
  const reset = await request("/api/auth/password/reset", { method: "POST", body: { token, newPassword: "newpassword" } });
  assert.equal(reset.response.status, 200, JSON.stringify(reset.data));
  assert.equal((await request("/api/auth/password/reset", { method: "POST", body: { token, newPassword: "thirdpassword" } })).response.status, 400);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { email, password: "oldpassword" } })).response.status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { email, password: "newpassword" } })).response.status, 200);
  console.log("Password reset E2E passed: injected email link, one-time token and session revocation");
} finally {
  await new Promise((resolve) => api.close(resolve));
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

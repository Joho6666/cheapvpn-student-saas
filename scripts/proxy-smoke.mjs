import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const managesServer = !process.env.APP_BASE_URL;
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const smokePort = 5600 + Math.floor(Math.random() * 100);
const baseUrl = String(process.env.APP_BASE_URL || `http://127.0.0.1:${smokePort}`).replace(/\/$/, "");
const email = process.env.SMOKE_EMAIL || "demo@cheapvpn.local";
const password = process.env.SMOKE_PASSWORD || "demo1234";
const baseHost = new URL(baseUrl).hostname;
const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(baseHost);
const isLoopbackUrl = (url) => ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
if (isLoopback) {
  // Node 24 can apply the machine proxy to loopback requests; smoke tests must hit Vite directly.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
}

function localRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, { method: options.method || "GET", headers: options.headers || {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode || 0, ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, text: async () => body });
      });
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function call(url, options = {}) {
  return isLoopbackUrl(url) ? localRequest(url, options) : fetch(url, options);
}

let smokeServer;
let smokeDataDir;
let smokeOutput = "";

async function startManagedServer() {
  if (!managesServer) return;
  smokeDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-smoke-"));
  smokeServer = spawn(process.execPath, ["server/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(smokePort),
      DATA_DIR: smokeDataDir,
      PUBLIC_BASE_URL: baseUrl,
      ADMIN_PASSWORD: "proxy-smoke-admin-password",
      ADMIN_ENCRYPTION_KEY: "proxy-smoke-encryption-key",
      PAYMENT_MODE: "mock",
      ALLOW_DEMO_SUBSCRIPTION: "true",
      ALLOW_DEMO_ACCOUNT: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  smokeServer.stdout.on("data", (chunk) => { smokeOutput += chunk; });
  smokeServer.stderr.on("data", (chunk) => { smokeOutput += chunk; });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (smokeServer.exitCode !== null) break;
    try {
      if ((await call(`${baseUrl}/health`)).ok) return;
    } catch { /* The isolated server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Smoke test server did not start. ${smokeOutput}`);
}

async function stopManagedServer() {
  if (smokeServer && smokeServer.exitCode === null && !smokeServer.killed) {
    smokeServer.kill();
    await new Promise((resolve) => smokeServer.once("exit", resolve));
  }
  if (smokeDataDir) await fs.rm(smokeDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function request(pathname, options = {}) {
  const response = await call(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* Keep an empty error payload. */ }
  return { response, data };
}

try {
  await startManagedServer();
  const frontend = await call(`${baseUrl}/`);
  assert.equal(frontend.ok, true, `frontend unavailable at ${baseUrl}`);
  const login = await request("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(login.response.ok, true, `login failed: ${JSON.stringify(login.data)}`);
  assert.ok(login.data.token, "login should return a session token");
  const token = login.data.token;
  const [plans, me, referral] = await Promise.all([
    request("/api/plans", { token }),
    request("/api/me", { token }),
    request("/api/referral", { token }),
  ]);
  assert.equal(plans.response.ok, true, "public plans should load through the frontend proxy");
  assert.ok(plans.data.plans?.length, "at least one active plan should be available");
  assert.equal(me.response.ok, true, "user profile should load through the frontend proxy");
  assert.equal(referral.response.ok, true, "referral status should load through the frontend proxy");
  assert.ok(referral.data.code, "referral code should be present");

  if (me.data.subscription?.status === "active") {
    const link = me.data.subscription.links?.universal;
    assert.ok(link?.startsWith("http"), "active subscription should expose a public URL");
    const subscriptionUrl = isLoopback ? `${baseUrl}${new URL(link).pathname}` : link;
    const subscription = await call(subscriptionUrl);
    assert.equal(subscription.status, 200, "public subscription URL should be reachable");
  }

  console.log(`Proxy smoke passed: ${baseUrl}, ${plans.data.plans.length} plan(s), referral ${referral.data.code}`);
} finally {
  await stopManagedServer();
}

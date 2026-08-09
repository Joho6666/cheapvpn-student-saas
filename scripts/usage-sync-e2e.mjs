import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-usage-"));
const apiPort = 4500 + Math.floor(Math.random() * 300);
const apiBase = `http://127.0.0.1:${apiPort}`;
let subscriptionRequests = 0;
let subscriptionDelayMs = 0;
let upstreamExpireSeconds = 4102444800;
const provider = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/usage") && req.headers.authorization !== "Bearer provider-secret") return res.writeHead(401).end();
  if (req.url?.startsWith("/subscription")) {
    subscriptionRequests += 1;
    if (subscriptionDelayMs) await new Promise((resolve) => setTimeout(resolve, subscriptionDelayMs));
    // Deliberately exceed the customer's 50GB plan: this is shared upstream
    // traffic and must not expire the individual customer subscription.
    res.setHeader("subscription-userinfo", `upload=0; download=64424509440; total=53687091200; expire=${upstreamExpireSeconds}`);
    if (req.url.includes("clash")) {
      // Simulate a supplier that ignores format flags and returns its generic
      // Base64 subscription for every URL variant.
      res.setHeader("Content-Type", "text/plain");
      return res.end(Buffer.from("vless://test@example.test:443?security=tls&type=ws&path=%2F#Singapore-node").toString("base64"));
    }
    if (req.url.includes("sb")) {
      res.setHeader("Content-Type", "text/plain");
      return res.end(Buffer.from("vless://test@example.test:443?security=tls&type=ws&path=%2F#Singapore-node").toString("base64"));
    }
    res.setHeader("Content-Type", "text/plain");
    return res.end("vless://test@example.test:443#Singapore-node");
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ records: [{ email: testEmail, usedGb: 3.5, totalGb: 50, expiresAt: new Date(upstreamExpireSeconds * 1000).toISOString() }] }));
});
let testEmail = `usage-${crypto.randomBytes(4).toString("hex")}@example.test`;
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(apiPort), DATA_DIR: dataDir, PUBLIC_BASE_URL: apiBase,
    ADMIN_PASSWORD: "usage-admin-password", PAYMENT_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true",
    UPSTREAM_SUBSCRIPTION_URL: `http://127.0.0.1:${providerPort}/subscription`, UPSTREAM_USAGE_API_URL: `http://127.0.0.1:${providerPort}/usage`, UPSTREAM_USAGE_API_TOKEN: "provider-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  provider.close();
  if (server.exitCode === null && !server.killed) server.kill();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${apiBase}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Usage test server did not start: ${output}`);
}
async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { response, data: await response.json().catch(() => ({})) };
}
function ok(result, message) { assert.equal(result.response.ok, true, `${message}: ${JSON.stringify(result.data)}`); return result.data; }

try {
  await waitForHealth();
  const registered = ok(await request("/api/auth/register", { method: "POST", body: { name: "Usage test", email: testEmail, password: "password123" } }), "register");
  const plans = ok(await request("/api/plans"), "plans");
  const admin = ok(await request("/api/admin/auth/login", { method: "POST", body: { password: "usage-admin-password" } }), "admin login");
  const savedUsageConfig = ok(await request("/api/admin/settings/usage", { method: "PUT", token: admin.token, body: { url: `http://127.0.0.1:${providerPort}/usage`, token: "provider-secret", syncIntervalMs: 300000 } }), "save usage API config");
  assert.equal(savedUsageConfig.apiConfigured, true, "admin usage API URL should be stored");
  assert.equal(savedUsageConfig.tokenConfigured, true, "admin usage API token should be stored");
  assert.equal(savedUsageConfig.syncIntervalMs, 300000, "admin should be able to set the usage sync interval");
  const clearedUsageConfig = ok(await request("/api/admin/settings/usage", { method: "PUT", token: admin.token, body: { clearUrl: true, clearToken: true, syncIntervalMs: 0 } }), "clear usage API config");
  assert.equal(clearedUsageConfig.apiConfigured, false, "clearing usage API should disable the environment fallback");
  assert.equal(clearedUsageConfig.tokenConfigured, false, "clearing usage token should disable the environment fallback");
  ok(await request("/api/admin/settings/usage", { method: "PUT", token: admin.token, body: { url: `http://127.0.0.1:${providerPort}/usage`, token: "provider-secret", syncIntervalMs: 300000 } }), "restore usage API config");
  const upstream = ok(await request("/api/admin/upstream", { token: admin.token }), "upstream source");
  const source = upstream.sources?.[0] || upstream.source;
  const sources = ok(await request("/api/admin/upstream", { token: admin.token }), "upstream source list");
  const sourceId = sources.sources?.[0]?.id;
  ok(await request(`/api/admin/sources/${sourceId}/node-rules`, { method: "PUT", token: admin.token, body: { rules: [{ match: "Singapore-node", name: "🇸🇬 新加坡 01" }] } }), "node rule");
  const order = ok(await request("/api/orders", { method: "POST", token: registered.token, body: { planId: plans.plans[0].id } }), "order");
  const confirmed = ok(await request(`/api/orders/${order.order.id}/confirm`, { method: "POST", token: registered.token }), "confirm");
  const requestsBeforeConcurrentSync = subscriptionRequests;
  const concurrentSyncs = await Promise.all([
    request("/api/subscription/sync", { method: "POST", token: registered.token }),
    request("/api/subscription/sync", { method: "POST", token: registered.token }),
  ]);
  concurrentSyncs.forEach((result) => ok(result, "concurrent subscription sync"));
  assert.equal(subscriptionRequests - requestsBeforeConcurrentSync, 3, "concurrent syncs should share one upstream format fetch");
  const aggregateUsage = ok(await request("/api/usage", { token: registered.token }), "aggregate customer usage");
  assert.equal(aggregateUsage.used, 0, "shared aggregate must not be reported as individual customer usage");
  assert.equal(aggregateUsage.remaining, 50, "shared aggregate should leave the individual plan quota unconsumed");
  assert.equal(aggregateUsage.quotaEnforced, false, "shared aggregate must not enforce individual quota");
  assert.equal(aggregateUsage.upstream.used, 60, "shared aggregate should remain visible for monitoring");
  assert.equal(aggregateUsage.usageSource, "upstream-aggregate", "aggregate usage should retain its source label");
  const subscriptionPath = new URL(confirmed.subscription.links.universal).pathname;
  const customerRows = ok(await request(`/api/admin/users?q=${encodeURIComponent(testEmail)}`, { token: admin.token }), "find customer for refresh test");
  subscriptionDelayMs = 250;
  const inFlightRefresh = request("/api/subscription/sync", { method: "POST", token: registered.token });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const manualOverride = ok(await request(`/api/admin/users/${customerRows.users[0].id}/usage`, { method: "PATCH", token: admin.token, body: { usedGb: 1.25 } }), "manual usage override during sync");
  assert.equal(manualOverride.usedGb, 1.25);
  ok(await inFlightRefresh, "sync after concurrent manual usage override");
  subscriptionDelayMs = 0;
  const preservedManualUsage = ok(await request("/api/usage", { token: registered.token }), "preserved manual usage");
  assert.equal(preservedManualUsage.used, 1.25, "an older upstream response must not overwrite a newer manual usage change");
  assert.equal(preservedManualUsage.usageSource, "manual", "manual usage source must remain authoritative after the race");
  ok(await request(`/api/admin/users/${customerRows.users[0].id}/source`, { method: "PUT", token: admin.token, body: { sourceId } }), "invalidate customer source cache");
  const requestsBeforeClientRefresh = subscriptionRequests;
  const clientRefresh = await fetch(`${apiBase}${subscriptionPath}`);
  assert.equal(clientRefresh.status, 200, "client subscription refresh should remain available");
  assert.equal(subscriptionRequests - requestsBeforeClientRefresh, 3, "stale public subscription refresh should fetch all formats once");
  await clientRefresh.text();
  const subscriptionResponse = await fetch(`${apiBase}${subscriptionPath}`);
  assert.equal(subscriptionResponse.headers.get("subscription-userinfo")?.includes("download=1342177280"), true, "public subscription should expose the customer manual usage after calibration");
  assert.match(await subscriptionResponse.text(), /Singapore-node|%F0%9F%87%B8%F0%9F%87%AC/);
  const clashPath = new URL(confirmed.subscription.links.clash).pathname;
  const clashText = await (await fetch(`${apiBase}${clashPath}`)).text();
  assert.match(clashText, /新加坡 01/);
  const singboxPath = new URL(confirmed.subscription.links.singbox).pathname;
  const singboxContent = await (await fetch(`${apiBase}${singboxPath}`)).json();
  assert.equal(singboxContent.outbounds[0].tag, "🇸🇬 新加坡 01", "node rules should apply to SingBox tags");
  const synced = ok(await request("/api/admin/usage/sync", { method: "POST", token: admin.token }), "usage sync");
  assert.equal(synced.updated.length, 1, "provider usage should update one customer");
  assert.equal(synced.updated[0].usedGb, 3.5, "provider usage should preserve decimal GB");
  const usage = ok(await request("/api/usage", { token: registered.token }), "customer usage");
  assert.equal(usage.used, 3.5, "customer should see provider usage");
  assert.equal(usage.usageSource, "provider-api", "usage source should identify provider API");
  assert.equal(usage.upstream.total, 50, "provider total quota should be retained");
  assert.ok(usage.upstream.expiresAt, "provider expiry should be retained");
  const overview = ok(await request("/api/admin/overview", { token: admin.token }), "admin overview usage");
  assert.equal(overview.metrics.usedGb, 3.5, "admin overview should use effective provider usage");
  const csvResponse = await fetch(`${apiBase}/api/admin/users/export.csv?q=${encodeURIComponent(testEmail)}`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(csvResponse.ok, true, "usage CSV export should succeed");
  const csv = await csvResponse.text();
  assert.match(csv, /3\.5/, "usage CSV should export effective provider usage");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  upstreamExpireSeconds = Math.floor(Date.now() / 1000) - 1;
  const upstreamExpired = await request("/api/subscription/sync", { method: "POST", token: registered.token });
  assert.equal(upstreamExpired.response.status, 410, "an expired upstream subscription should stop the customer subscription");
  console.log("Usage sync E2E passed: provider API, admin sync, customer usage");
} finally {
  await stop();
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = 4500 + Math.floor(Math.random() * 200);
const providerPort = 4800 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-resource-pool-"));
let healthySourcesOnline = true;

const provider = createServer((req, res) => {
  const bodies = {
    "/a": healthySourcesOnline ? "vless://user-a@a.example.test:443?security=tls#Alpha\nvless://shared@shared.example.test:443?security=tls#Shared%20A\n" : "<html>offline</html>",
    "/b": healthySourcesOnline ? "trojan://user-b@b.example.test:443?security=tls#Bravo\nvless://shared@shared.example.test:443?security=tls#Shared%20B\n" : "<html>offline</html>",
    "/broken": "<html>upstream unavailable</html>",
  };
  const body = bodies[req.url] || "not found";
  res.writeHead(req.url in bodies ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
});
await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "resource-pool-admin", ADMIN_ENCRYPTION_KEY: "resource-pool-encryption-key-change-me",
    PAYMENT_WEBHOOK_SECRET: "resource-pool-webhook-secret", PAYMENT_MODE: "mock",
    ALLOW_DEMO_SUBSCRIPTION: "false", ALLOW_DEMO_ACCOUNT: "false", ALLOW_PRIVATE_UPSTREAM_URLS: "true",
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
  await new Promise((resolve) => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Resource pool test server did not start. ${output}`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, data: await response.json().catch(() => ({})) };
}

function expectOk(result, label) {
  assert.equal(result.response.ok, true, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

try {
  await waitForHealth();
  const admin = expectOk(await request("/api/admin/auth/login", { method: "POST", body: { password: "resource-pool-admin" } }), "admin login");
  const sourceA = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Alpha", url: `http://127.0.0.1:${providerPort}/a` } }), "create Alpha source");
  const sourceB = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Bravo", url: `http://127.0.0.1:${providerPort}/b` } }), "create Bravo source");
  const broken = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Broken", url: `http://127.0.0.1:${providerPort}/broken` } }), "create broken source");

  const pool = expectOk(await request("/api/admin/pools", { method: "POST", token: admin.token, body: { name: "All healthy sources", sourceIds: [sourceA.source.id, sourceB.source.id, broken.source.id], isDefault: true } }), "create merged resource pool");
  assert.equal(pool.pool.memberCount, 3, "pool should include each configured source");
  const preview = expectOk(await request(`/api/admin/pools/${pool.pool.id}/preview`, { method: "POST", token: admin.token }), "resource pool preview");
  assert.equal(preview.summary.healthySources, 2, "preview should exclude a broken upstream");
  assert.equal(preview.summary.uniqueNodes, 3, "duplicate upstream nodes should be deduplicated");
  assert.equal(JSON.stringify(preview).includes("user-a"), false, "pool preview must not expose node credentials");

  const registered = expectOk(await request("/api/auth/register", { method: "POST", body: { name: "Pool user", email: "pool-user@example.test", password: "password123" } }), "register pool user");
  const plans = expectOk(await request("/api/plans"), "plans");
  const order = expectOk(await request("/api/orders", { method: "POST", token: registered.token, body: { planId: plans.plans[0].id } }), "create order");
  const paid = expectOk(await request(`/api/admin/orders/${order.order.id}/confirm`, { method: "POST", token: admin.token }), "confirm order");
  assert.equal(paid.subscription.status, "active", "pool subscription should activate");
  const universal = await fetch(paid.subscription.links.universal);
  const universalText = await universal.text();
  assert.equal(universal.status, 200, "merged universal subscription should be public");
  assert.match(universalText, /Alpha/, "merged content should include Alpha");
  assert.match(universalText, /Bravo/, "merged content should include Bravo");
  assert.equal((universalText.match(/shared\.example\.test/g) || []).length, 1, "merged content should contain the duplicate node once");
  const subscription = expectOk(await request("/api/subscription", { token: registered.token }), "read merged subscription");
  assert.equal(subscription.subscription.lastSyncStatus, "partial", "one failed source should produce a partial sync state");
  const assignments = expectOk(await request(`/api/admin/users/${registered.user.id}/pool`, { token: admin.token }), "read user pool assignment");
  assert.equal(assignments.assignment.sources.length, 3, "subscription should retain all pool members, including the failed source audit row");
  healthySourcesOnline = false;
  const stale = expectOk(await request("/api/subscription/sync", { method: "POST", token: registered.token }), "sync after all sources fail");
  assert.equal(stale.subscription.lastSyncStatus, "stale", "all source failures should preserve the prior subscription cache");
  const cachedUniversal = await (await fetch(stale.subscription.links.universal)).text();
  assert.equal(cachedUniversal, universalText, "all source failures must not replace a working cached subscription");

  console.log("Resource pool E2E passed: healthy sources merged, duplicates removed, broken source retained as partial audit state and full failure kept the cache");
} finally {
  await stop();
}

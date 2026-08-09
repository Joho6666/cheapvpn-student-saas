import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-production-start-"));
const apiPort = 5400 + Math.floor(Math.random() * 100);
const provider = createServer((req, res) => {
  if (req.url?.includes("clash")) {
    res.writeHead(200, { "content-type": "text/yaml" });
    return res.end("proxies:\n  - name: Production\n    type: ss\n    server: example.test\n    port: 443\n");
  }
  if (req.url?.includes("sb")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ outbounds: [{ type: "socks", tag: "Production", server: "example.test", server_port: 443 }] }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("vless://test@example.test:443#Production");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}/subscription`;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(apiPort), DATA_DIR: dataDir,
    PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`, ADMIN_PASSWORD: "production-start-password",
    ADMIN_ENCRYPTION_KEY: "production-start-encryption-key", PAYMENT_MODE: "manual",
    PAYMENT_MANUAL_INSTRUCTIONS: "请完成转账后提交订单号。", ALLOW_DEMO_SUBSCRIPTION: "false",
    ALLOW_DEMO_ACCOUNT: "false", UPSTREAM_SUBSCRIPTION_URL: providerUrl,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) server.kill();
  await new Promise((resolve) => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return;
    } catch { /* The production process is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production server did not start: ${output}`);
}

try {
  await waitForHealth();
  const ready = await fetch(`http://127.0.0.1:${apiPort}/health/ready`);
  assert.equal(ready.status, 200, `production readiness failed: ${await ready.text()}`);
  const page = await fetch(`http://127.0.0.1:${apiPort}/`);
  assert.equal(page.status, 200, "production server should serve the built frontend");
  assert.match(await page.text(), /CheapVPN/i, "built frontend should be reachable from production entrypoint");
  const plans = await fetch(`http://127.0.0.1:${apiPort}/api/plans`);
  assert.equal(plans.status, 200, "production API should expose plans");
  assert.ok((await plans.json()).plans.length > 0, "production API should expose an active plan");
  console.log("Production start E2E passed: built frontend, readiness gate, manual payment and real upstream");
} finally {
  await stop();
}

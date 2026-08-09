import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-production-guard-"));
const port = 5000 + Math.floor(Math.random() * 100);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir,
    PUBLIC_BASE_URL: baseUrl, ADMIN_PASSWORD: "production-guard-password", ADMIN_ENCRYPTION_KEY: "production-guard-key",
    PAYMENT_MODE: "mock", ALLOW_DEMO_SUBSCRIPTION: "true", ALLOW_DEMO_ACCOUNT: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { response, data: await response.json().catch(() => ({})) };
}
function ok(result, label) { assert.equal(result.response.ok, true, `${label}: ${JSON.stringify(result.data)}`); return result.data; }

try {
  const exitCode = await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve(server.exitCode);
    server.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 1, "production must refuse unsafe demo configuration");
  assert.match(output, /CheapVPN refused to start in production/i, "production refusal should explain the safety gate");
  assert.match(output, /ALLOW_DEMO_SUBSCRIPTION must be false/i, "production refusal should identify demo subscription configuration");
  assert.match(output, /ready manual or webhook payment configuration/i, "production refusal should identify payment configuration");
  console.log("Production guard E2E passed: unsafe demo configuration is rejected before the API starts");
} finally {
  await stop();
}

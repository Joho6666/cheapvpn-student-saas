import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = 4100 + Math.floor(Math.random() * 400);
const baseUrl = `http://127.0.0.1:${port}`;
const providerPort = 4700 + Math.floor(Math.random() * 300);
const providerUrl = `http://127.0.0.1:${providerPort}/sub?token=test-provider`;
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cheapvpn-mvp-"));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const provider = createServer((req, res) => {
  if (req.url?.startsWith("/sub")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("vless://uuid@example.test:443?security=tls#Test%20Provider%20Node\n");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: baseUrl,
    ADMIN_PASSWORD: "mvp-admin-password",
    ADMIN_ENCRYPTION_KEY: "mvp-admin-encryption-key-change-me",
    PAYMENT_WEBHOOK_SECRET: "mvp-webhook-secret",
    PAYMENT_MODE: "mock",
    ALLOW_DEMO_SUBSCRIPTION: "true",
    ALLOW_DEMO_ACCOUNT: "false",
    ALLOW_PRIVATE_UPSTREAM_URLS: "true",
    UPSTREAM_ASSIGNMENT_MODE: "round_robin",
     UPSTREAM_SUBSCRIPTION_URL: providerUrl,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function stop() {
  if (server.exitCode === null && !server.killed) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
      server.kill();
    });
  }
  await new Promise((resolve) => provider.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* The child process is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MVP test server did not start. ${output}`);
}

async function request(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.headers || {}) };
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function expectOk(result, message) {
  assert.equal(result.response.ok, true, `${message}: ${JSON.stringify(result.data)}`);
  return result.data;
}

try {
  await waitForHealth();
  const publicConfig = await fetch(`${baseUrl}/api/config`);
  assert.equal((await publicConfig.json()).demoAccount, false, "demo accounts must be disabled unless explicitly enabled");
  const disabledDemoLogin = await request("/api/auth/login", { method: "POST", body: { email: "demo@cheapvpn.local", password: "demo1234" } });
  assert.equal(disabledDemoLogin.response.status, 401, "disabled demo account must not be usable");
  const suffix = crypto.randomBytes(4).toString("hex");
  const referrerEmail = `referrer-${suffix}@example.test`;
  const inviteeEmail = `invitee-${suffix}@example.test`;

  const referrer = expectOk(await request("/api/auth/register", { method: "POST", body: { name: "Referrer", email: referrerEmail, password: "password123" } }), "referrer registration");
  assert.ok(referrer.user.referralCode, "registration should create a referral code");
  const invitee = expectOk(await request("/api/auth/register", { method: "POST", body: { name: "Invitee", email: inviteeEmail, password: "password123", referralCode: referrer.user.referralCode } }), "invitee registration");
  const profile = expectOk(await request("/api/me/profile", { method: "PATCH", token: invitee.token, body: { name: "Updated Invitee" } }), "profile update");
  assert.equal(profile.user.name, "Updated Invitee", "profile name should update");
  expectOk(await request("/api/auth/password", { method: "POST", token: invitee.token, body: { currentPassword: "password123", newPassword: "password456" } }), "password change");
  const newLogin = expectOk(await request("/api/auth/login", { method: "POST", body: { email: inviteeEmail, password: "password456" } }), "login with changed password");
  assert.equal(newLogin.user.email, inviteeEmail, "changed password should allow login");
  const revoked = expectOk(await request("/api/auth/sessions/revoke-others", { method: "POST", token: invitee.token }), "revoke other sessions");
  assert.equal(revoked.revoked, 1, "explicit session revocation should remove the other login");
  const revokedByButton = await request("/api/me", { token: newLogin.token });
  assert.equal(revokedByButton.response.status, 401, "explicit session revocation must invalidate the other session");
  const passwordSession = expectOk(await request("/api/auth/login", { method: "POST", body: { email: inviteeEmail, password: "password456" } }), "login for password revocation");
  expectOk(await request("/api/auth/password", { method: "POST", token: invitee.token, body: { currentPassword: "password456", newPassword: "password789" } }), "second password change");
  const revokedSession = await request("/api/me", { token: passwordSession.token });
  assert.equal(revokedSession.response.status, 401, "password change must revoke cached sessions on other devices");

  const plans = expectOk(await request("/api/plans"), "public plans");
  assert.ok(plans.plans.length > 0, "at least one active plan is required");
  const planId = plans.plans[0].id;

  const concurrentInviteeOrders = await Promise.all([
    request("/api/orders", { method: "POST", token: invitee.token, body: { planId, renewal: false } }),
    request("/api/orders", { method: "POST", token: invitee.token, body: { planId, renewal: false } }),
  ]);
  assert.equal(concurrentInviteeOrders.filter((result) => result.response.status === 201).length, 1, "concurrent customer order attempts should create one order");
  assert.equal(concurrentInviteeOrders.filter((result) => result.response.status === 409).length, 1, "a second concurrent order should be rejected while one is pending");
  const inviteeOrder = concurrentInviteeOrders.find((result) => result.response.status === 201).data;
  const pendingOrderDetail = expectOk(await request(`/api/orders/${inviteeOrder.order.id}`, { token: invitee.token }), "pending order detail");
  assert.equal(pendingOrderDetail.order.status, "pending", "customer should be able to query one order status");
  const processingDb = new Database(path.join(dataDir, "cheapvpn.sqlite"));
  processingDb.prepare("UPDATE orders SET status = 'processing', created_at = ? WHERE id = ?").run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), inviteeOrder.order.id);
  processingDb.close();
  const recoveredOrderDetail = expectOk(await request(`/api/orders/${inviteeOrder.order.id}`, { token: invitee.token }), "recover interrupted order");
  assert.equal(recoveredOrderDetail.order.status, "pending", "stale processing orders should recover to pending");
  const inviteePaid = expectOk(await request(`/api/orders/${inviteeOrder.order.id}/confirm`, { method: "POST", token: invitee.token }), "invitee mock payment");
  assert.equal(inviteePaid.subscription.status, "active");
  assert.match(inviteePaid.subscription.links.universal, /\/s\//);
  assert.ok(inviteePaid.subscription.links.universal.startsWith(baseUrl), "subscription links should use the configured public origin");
  const forwardedOriginSubscription = expectOk(await request("/api/subscription", { token: invitee.token, headers: { "X-Forwarded-Host": "malicious.example" } }), "subscription origin hardening");
  assert.ok(forwardedOriginSubscription.subscription.links.universal.startsWith(baseUrl), "untrusted forwarded host must not change public subscription links");
  const initialUsage = expectOk(await request("/api/usage", { token: invitee.token }), "initial customer usage");
  assert.equal(initialUsage.total, plans.plans[0].dataTotal, "customer usage should expose plan quota");
  const customerUsageHistory = expectOk(await request("/api/usage/history", { token: invitee.token }), "customer usage history");
  assert.ok(customerUsageHistory.history.some((snapshot) => snapshot.usedGb === 0), "customer usage history should include activation snapshot");
  const subscriptionContent = await request(new URL(inviteePaid.subscription.links.universal).pathname);
  assert.equal(subscriptionContent.response.status, 200, "active subscription URL should be readable");
  assert.ok(inviteePaid.subscription.links.clash, "generic subscriptions should expose a converted Clash link");
  const convertedClash = await request(new URL(inviteePaid.subscription.links.clash).pathname);
  assert.equal(convertedClash.response.status, 200, "converted Clash output should be available");
  const convertedClashText = await (await fetch(inviteePaid.subscription.links.clash)).text();
  assert.match(convertedClashText, /proxy-groups:/, "converted Clash output should include a selectable proxy group");
  assert.equal(subscriptionContent.response.headers.get("x-robots-tag"), "noindex, nofollow", "subscription content should not be indexed");
  assert.equal(subscriptionContent.response.headers.get("referrer-policy"), "no-referrer", "subscription content should not leak its token as a referrer");
  const userInfoHeader = subscriptionContent.response.headers.get("subscription-userinfo") || "";
  assert.match(userInfoHeader, /total=\d+; expire=\d+/i, "subscription should expose standard quota headers");
  assert.ok(userInfoHeader.includes(`total=${Math.round(plans.plans[0].dataTotal * 1024 ** 3)}`), "subscription quota header should use the plan quota");
  const cachedSubscription = await request(new URL(inviteePaid.subscription.links.universal).pathname, { headers: { "If-None-Match": subscriptionContent.response.headers.get("etag") || "" } });
  assert.equal(cachedSubscription.response.status, 304, "unchanged subscription should support conditional requests");

  const expiredOrder = expectOk(await request("/api/orders", { method: "POST", token: invitee.token, body: { planId, renewal: true } }), "expiring order creation");
  const testDb = new Database(path.join(dataDir, "cheapvpn.sqlite"));
  testDb.prepare("UPDATE orders SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), expiredOrder.order.id);
  testDb.close();
  const expiredConfirmation = await request(`/api/orders/${expiredOrder.order.id}/confirm`, { method: "POST", token: invitee.token });
  assert.equal(expiredConfirmation.response.status, 409, "expired order must not be confirmed");

  const referral = expectOk(await request("/api/referral", { token: referrer.token }), "referral status");
  assert.equal(referral.successfulInvites, 1, "first paid invite should qualify referral");

  const admin = expectOk(await request("/api/admin/auth/login", { method: "POST", body: { password: "mvp-admin-password" } }), "admin login");
  expectOk(await request("/api/admin/upstream", { method: "PUT", token: admin.token, body: { url: providerUrl } }), "legacy upstream save");
  expectOk(await request("/api/admin/upstream", { method: "PUT", token: admin.token, body: { url: providerUrl } }), "legacy upstream repeat save");
  const legacySources = expectOk(await request("/api/admin/upstream", { token: admin.token }), "legacy upstream source list");
  assert.equal(legacySources.sources.filter((source) => source.isDefault).length, 1, "repeated legacy saves must keep one default source");
  expectOk(await request("/api/admin/auth/password", { method: "POST", token: admin.token, body: { currentPassword: "mvp-admin-password", newPassword: "mvp-admin-password-rotated" } }), "admin password change");
  const oldAdminLogin = await request("/api/admin/auth/login", { method: "POST", body: { password: "mvp-admin-password" } });
  assert.equal(oldAdminLogin.response.status, 401, "old admin password must stop working");
  const newAdminLogin = expectOk(await request("/api/admin/auth/login", { method: "POST", body: { password: "mvp-admin-password-rotated" } }), "new admin password login");
  admin.token = newAdminLogin.token;
  const system = expectOk(await request("/api/admin/system", { token: admin.token }), "admin system readiness");
  assert.equal(system.payment.mode, "mock", "isolated MVP should report mock payment mode");
  const paymentSettings = expectOk(await request("/api/admin/settings/payment", { token: admin.token }), "payment settings read");
  assert.equal(paymentSettings.mode, "mock", "payment settings should inherit the environment mode");
  const savedPaymentSettings = expectOk(await request("/api/admin/settings/payment", { method: "PUT", token: admin.token, body: { mode: "manual", manualInstructions: "请付款后提交订单号。" } }), "payment settings save");
  assert.equal(savedPaymentSettings.mode, "manual", "admin should be able to switch to manual payment");
  expectOk(await request("/api/admin/settings/payment", { method: "PUT", token: admin.token, body: { mode: "mock", manualInstructions: "" } }), "restore payment settings");
  const readiness = await fetch(`${baseUrl}/health/ready`);
  assert.equal(readiness.status, 503, "demo payment must not report production readiness");
  const readinessBody = await readiness.json();
  assert.equal(readinessBody.checks.payment, false, "mock payment must fail the production readiness gate");
  assert.equal(JSON.stringify(system).includes("token"), false, "system readiness must not expose credentials");
  const editedPlan = expectOk(await request(`/api/admin/plans/${planId}`, { method: "PUT", token: admin.token, body: { name: "Student Plan Updated", slug: plans.plans[0].slug, firstMonth: plans.plans[0].firstMonth, renewal: plans.plans[0].renewal, dataTotal: plans.plans[0].dataTotal, devices: plans.plans[0].devices, active: true } }), "plan edit");
  assert.equal(editedPlan.plan.name, "Student Plan Updated", "admin should be able to edit a plan");
  const invalidSource = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Health endpoint", url: `${baseUrl}/health` } }), "invalid source creation");
  const invalidSourceTest = expectOk(await request(`/api/admin/sources/${invalidSource.source.id}/test`, { method: "POST", token: admin.token }), "invalid source test");
  assert.equal(invalidSourceTest.ok, false, "non-subscription upstream content must not be reported as usable");
  assert.equal(invalidSourceTest.formats.find((format) => format.format === "universal").ok, false, "universal validation must require supported nodes");
  await request(`/api/admin/sources/${invalidSource.source.id}`, { method: "DELETE", token: admin.token });
  const orderKey = `mvp-order-${suffix}`;
  const referrerOrder = expectOk(await request("/api/orders", { method: "POST", token: referrer.token, headers: { "Idempotency-Key": orderKey }, body: { planId, renewal: false } }), "referrer order creation");
  const replayedReferrerOrder = expectOk(await request("/api/orders", { method: "POST", token: referrer.token, headers: { "Idempotency-Key": orderKey }, body: { planId, renewal: false } }), "replayed referrer order creation");
  assert.equal(replayedReferrerOrder.replayed, true, "repeating an order request should replay the original order");
  assert.equal(replayedReferrerOrder.order.id, referrerOrder.order.id, "replayed order should keep the original id");
  expectOk(await request(`/api/orders/${referrerOrder.order.id}/confirm`, { method: "POST", token: referrer.token }), "referrer mock payment");
  const referrerUsers = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(referrerEmail)}`, { token: admin.token }), "find referrer for usage check");
  await request(`/api/admin/users/${referrerUsers.users[0].id}/usage`, { method: "PATCH", token: admin.token, body: { usedGb: 4.25 } });
  const renewalSource = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Renewal source", url: providerUrl } }), "renewal source creation");
  const updatedSource = expectOk(await request(`/api/admin/sources/${renewalSource.source.id}`, { method: "PUT", token: admin.token, body: { name: "Renewal source updated", enabled: true, isDefault: renewalSource.source.isDefault } }), "upstream source edit");
  assert.equal(updatedSource.source.name, "Renewal source updated", "admin should be able to edit a source");
  assert.equal(JSON.stringify(updatedSource).includes("token=test"), false, "source responses must not expose upstream tokens");
  const formatSource = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Format source", url: `${baseUrl}/health`, clashUrl: `${baseUrl}/?clash`, singboxUrl: `${baseUrl}/?sb` } }), "format source creation");
  const clearedFormatSource = expectOk(await request(`/api/admin/sources/${formatSource.source.id}`, { method: "PUT", token: admin.token, body: { clashUrl: null } }), "clear optional source format");
  assert.equal(clearedFormatSource.source.formatUrls.clash, "", "admin should be able to clear an obsolete format URL");
  await request(`/api/admin/sources/${formatSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: false } });
  const secondSource = expectOk(await request("/api/admin/sources", { method: "POST", token: admin.token, body: { name: "Second working source", url: providerUrl } }), "second working source creation");
  assert.equal(secondSource.source.enabled, true, "a valid source should be enabled by default");
  expectOk(await request(`/api/admin/sources/${secondSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true, isDefault: true } }), "promote second source");
  await request(`/api/admin/sources/${secondSource.source.id}`, { method: "PUT", token: admin.token, body: { isDefault: false } });
  const explicitDefaultClear = expectOk(await request("/api/admin/upstream", { token: admin.token }), "clear explicit default source");
  assert.equal(explicitDefaultClear.sources.find((source) => source.id === secondSource.source.id).isDefault, false, "explicit isDefault false must clear the default flag");
  assert.equal(explicitDefaultClear.sources.filter((source) => source.enabled && source.isDefault).length, 1, "clearing a default must promote another enabled source");
  await request(`/api/admin/sources/${secondSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true, isDefault: true } });
  await request(`/api/admin/sources/${secondSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: false } });
  const reassignedDefaultSources = expectOk(await request("/api/admin/upstream", { token: admin.token }), "read reassigned default source");
  assert.equal(reassignedDefaultSources.sources.find((source) => source.id === secondSource.source.id).isDefault, false, "disabled source must not remain default");
  assert.equal(reassignedDefaultSources.sources.filter((source) => source.enabled && source.isDefault).length, 1, "an enabled replacement source should become default");
  await request(`/api/admin/sources/${secondSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true } });
  const restoredDefaultSources = expectOk(await request("/api/admin/upstream", { token: admin.token }), "read restored default source");
  assert.equal(restoredDefaultSources.sources.find((source) => source.id === secondSource.source.id).isDefault, false, "an enabled non-default source must not displace the current default");
  await request(`/api/admin/sources/${renewalSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: false } });
  const routing = expectOk(await request("/api/admin/settings/routing", { method: "PUT", token: admin.token, body: { assignmentMode: "round_robin" } }), "save source assignment mode");
  assert.equal(routing.assignmentMode, "round_robin", "admin should be able to change source assignment mode");
  const routedBuyers = [];
  for (const label of ["A", "B"]) {
    const routed = expectOk(await request("/api/auth/register", { method: "POST", body: { name: `Routed ${label}`, email: `routed-${label.toLowerCase()}-${suffix}@example.test`, password: "password123" } }), `routed ${label} registration`);
    const routedOrder = expectOk(await request("/api/orders", { method: "POST", token: routed.token, body: { planId, renewal: false } }), `routed ${label} order`);
    expectOk(await request(`/api/orders/${routedOrder.order.id}/confirm`, { method: "POST", token: routed.token }), `routed ${label} payment`);
    const routedUsers = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(`routed-${label.toLowerCase()}-${suffix}@example.test`)}`, { token: admin.token }), `find routed ${label}`);
    routedBuyers.push({ sourceName: routedUsers.users[0].sourceName, id: routedUsers.users[0].id });
  }
  assert.notEqual(routedBuyers[0].sourceName, routedBuyers[1].sourceName, "round-robin assignment should distribute consecutive new customers");
  for (const routedBuyer of routedBuyers) {
    expectOk(await request(`/api/admin/users/${routedBuyer.id}/subscription`, { method: "PATCH", token: admin.token, body: { action: "expire" } }), "expire routed test customer");
  }
  await request(`/api/admin/sources/${renewalSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true } });
  expectOk(await request(`/api/admin/users/${referrerUsers.users[0].id}/source`, { method: "PUT", token: admin.token, body: { sourceId: renewalSource.source.id } }), "bind renewal source");
  expectOk(await request(`/api/admin/sources/${renewalSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: false } }), "disable renewal source");
  const renewal = expectOk(await request("/api/orders", { method: "POST", token: referrer.token, body: { planId, renewal: true } }), "discounted renewal creation");
  assert.equal(renewal.order.discountPercent, 10, "qualified referral should apply renewal discount");
  assert.equal(renewal.order.amount, 17.91, "10% discount should be calculated in cents");
  expectOk(await request(`/api/admin/sources/${renewalSource.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true } }), "re-enable renewal source");
  const referrerSubscriptionBeforeRenewal = expectOk(await request("/api/subscription", { token: referrer.token }), "subscription before renewal");
  const renewed = expectOk(await request(`/api/orders/${renewal.order.id}/confirm`, { method: "POST", token: referrer.token }), "discounted renewal payment");
  assert.equal(renewed.subscription.links.universal, referrerSubscriptionBeforeRenewal.subscription.links.universal, "renewal should preserve the existing subscription URL");
  const resetUsage = expectOk(await request("/api/usage", { token: referrer.token }), "renewed customer usage");
  assert.equal(resetUsage.used, 0, "renewal should start a fresh usage cycle");
  expectOk(await request(`/api/admin/users/${referrerUsers.users[0].id}/source`, { method: "PUT", token: admin.token, body: { sourceId: null } }), "unbind renewal source");

  const users = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(inviteeEmail)}`, { token: admin.token }), "admin customer search");
  assert.equal(users.pagination.total, 1, "admin should find the customer");
  const inviteeId = users.users[0].id;
  const csvResponse = await fetch(`${baseUrl}/api/admin/users/export.csv?q=${encodeURIComponent(inviteeEmail)}`, { headers: { Authorization: `Bearer ${admin.token}` } });
  const csv = await csvResponse.text();
  assert.equal(csvResponse.status, 200, "admin customer export should succeed");
  assert.match(csv, /email/);
  assert.match(csv, new RegExp(inviteeEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const usage = expectOk(await request(`/api/admin/users/${inviteeId}/usage`, { method: "PATCH", token: admin.token, body: { usedGb: 4.25 } }), "admin usage update");
  assert.equal(usage.usedGb, 4.25);
  const usageHistory = expectOk(await request(`/api/admin/users/${inviteeId}/usage/history`, { token: admin.token }), "admin usage history");
  assert.ok(usageHistory.history.some((snapshot) => snapshot.usedGb === 4.25 && snapshot.source === "manual"), "manual usage updates should be recorded in history");
  const unsafePlanEdit = await request(`/api/admin/plans/${planId}`, { method: "PUT", token: admin.token, body: { name: "Unsafe quota", slug: plans.plans[0].slug, firstMonth: plans.plans[0].firstMonth, renewal: plans.plans[0].renewal, dataTotal: 1, devices: plans.plans[0].devices, active: true } });
  assert.equal(unsafePlanEdit.response.status, 409, "plan quota must not be lowered below active customer usage");

  const source = renewalSource;
  expectOk(await request(`/api/admin/sources/${source.source.id}`, { method: "PUT", token: admin.token, body: { enabled: false } }), "disable source");
  const disabledBinding = await request(`/api/admin/users/${inviteeId}/source`, { method: "PUT", token: admin.token, body: { sourceId: source.source.id } });
  assert.equal(disabledBinding.response.status, 409, "disabled source must not be assigned");
  expectOk(await request(`/api/admin/sources/${source.source.id}`, { method: "PUT", token: admin.token, body: { enabled: true } }), "re-enable source");
  expectOk(await request(`/api/admin/users/${referrerUsers.users[0].id}/source`, { method: "PUT", token: admin.token, body: { sourceId: source.source.id } }), "bind second active customer to source");
  expectOk(await request(`/api/admin/users/${inviteeId}/source`, { method: "PUT", token: admin.token, body: { sourceId: source.source.id } }), "customer source binding");
  const sourceSync = expectOk(await request(`/api/admin/sources/${source.source.id}/sync`, { method: "POST", token: admin.token }), "source customer sync");
  assert.equal(sourceSync.total, 2, "source sync should include both bound active customers");
  assert.equal(sourceSync.errors, 0, "source sync should report no customer sync errors");
  const inviteeAfterSharedSync = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(inviteeEmail)}`, { token: admin.token }), "read invitee sync state");
  expectOk(await request(`/api/admin/users/${referrerUsers.users[0].id}/source`, { method: "PUT", token: admin.token, body: { sourceId: secondSource.source.id } }), "move one customer to another source");
  const inviteeAfterUnrelatedMove = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(inviteeEmail)}`, { token: admin.token }), "read unaffected invitee sync state");
  assert.equal(inviteeAfterUnrelatedMove.users[0].lastSyncAt, inviteeAfterSharedSync.users[0].lastSyncAt, "moving one customer must not invalidate another customer's source cache");
  const deleteBound = await request(`/api/admin/sources/${source.source.id}`, { method: "DELETE", token: admin.token });
  assert.equal(deleteBound.response.status, 409, "bound source should not be deleted");

  await request(`/api/admin/users/${inviteeId}/usage`, { method: "PATCH", token: admin.token, body: { usedGb: plans.plans[0].dataTotal } });
  const exhaustedUsage = await request("/api/usage", { token: invitee.token });
  assert.equal(exhaustedUsage.response.status, 410, "reaching the data quota should stop the subscription");
  const exhaustedPublic = await request(new URL(inviteePaid.subscription.links.universal).pathname);
  assert.equal(exhaustedPublic.response.status, 410, "public subscription should stop after the data quota is exhausted");

  const revived = expectOk(await request(`/api/admin/users/${inviteeId}/subscription`, { method: "PATCH", token: admin.token, body: { action: "extend" } }), "extend exhausted customer subscription");
  assert.equal(revived.subscription.status, "active", "extending an exhausted subscription should start a new active cycle");
  const revivedUsage = expectOk(await request("/api/usage", { token: invitee.token }), "usage after admin extension");
  assert.equal(revivedUsage.used, 0, "a revived exhausted subscription should reset its cycle usage");
  const resetToken = expectOk(await request(`/api/admin/users/${inviteeId}/subscription`, { method: "PATCH", token: admin.token, body: { action: "reset" } }), "admin subscription token reset");
  assert.notEqual(resetToken.subscription.links.universal, inviteePaid.subscription.links.universal, "token reset should generate a new subscription URL");
  const oldTokenLink = await request(new URL(inviteePaid.subscription.links.universal).pathname);
  assert.equal(oldTokenLink.response.status, 404, "resetting a subscription token must invalidate the old URL");
  const newTokenLink = await request(new URL(resetToken.subscription.links.universal).pathname);
  assert.equal(newTokenLink.response.status, 200, "the new subscription URL must remain usable");

  expectOk(await request(`/api/admin/users/${inviteeId}/subscription`, { method: "PATCH", token: admin.token, body: { action: "expire" } }), "admin subscription expiry");
  const expiredLink = await request(new URL(resetToken.subscription.links.universal).pathname);
  assert.equal(expiredLink.response.status, 410, "expired subscription URL should stop serving content");
  const overview = expectOk(await request("/api/admin/overview", { token: admin.token }), "admin overview after expiry");
  assert.equal(overview.metrics.totalGb, plans.plans[0].dataTotal, "overview quota should only include active subscriptions");
  const annualPlan = expectOk(await request("/api/admin/plans", { method: "POST", token: admin.token, body: {
    slug: `annual-${suffix}`, name: "Annual Student Plan", firstMonth: 99, renewal: 99, periodMonths: 12, dataTotal: 600, devices: 3,
  } }), "annual plan creation");
  assert.equal(annualPlan.plan.periodMonths, 12, "annual plan should expose a 12-month billing period");
  const annualUser = expectOk(await request("/api/auth/register", { method: "POST", body: { name: "Annual Buyer", email: `annual-${suffix}@example.test`, password: "password123" } }), "annual buyer registration");
  const annualOrder = expectOk(await request("/api/orders", { method: "POST", token: annualUser.token, body: { planId: annualPlan.plan.id } }), "annual order creation");
  const annualPaid = expectOk(await request(`/api/orders/${annualOrder.order.id}/confirm`, { method: "POST", token: annualUser.token }), "annual order confirmation");
  assert.ok(Date.parse(annualPaid.subscription.expiresAt) - Date.now() > 300 * 24 * 60 * 60 * 1000, "annual subscription should expire roughly twelve months later");
  const annualAdminUser = expectOk(await request(`/api/admin/users?q=${encodeURIComponent(`annual-${suffix}@example.test`)}`, { token: admin.token }), "find annual customer");
  const annualBeforeExtend = Date.parse(annualPaid.subscription.expiresAt);
  const annualExtended = expectOk(await request(`/api/admin/users/${annualAdminUser.users[0].id}/subscription`, { method: "PATCH", token: admin.token, body: { action: "extend" } }), "annual admin extension");
  assert.ok(Date.parse(annualExtended.subscription.expiresAt) - annualBeforeExtend > 300 * 24 * 60 * 60 * 1000, "admin extension should follow the annual plan period");

  console.log("MVP E2E passed: registration, referral, purchase, renewal discount, admin usage, source binding, expiry");
} finally {
  await stop();
}

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import nodemailer from "nodemailer";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db/database.js";
import {
  adminPassword, allowDemoAccount, allowDemoSubscription, allowPrivateUpstreamUrls,
  configuredCorsOrigins, dataDir, emailFromDefault, host, nodeGeoTimeout,
  nodeProbeTimeout, nodeTestConcurrency, paymentCheckoutTemplateDefault,
  paymentManualInstructionsDefault, paymentMethodCatalog, paymentModeDefault,
  paymentWebhookSecretDefault, port, productionRuntime, publicBaseUrl,
  smtpUrlDefault, trustProxyHeaders, upstreamAssignmentDefault, upstreamSyncConcurrency,
  upstreamTimeout, upstreamUsageApiTokenDefault, upstreamUsageApiUrlDefault,
  upstreamUsageSyncIntervalDefault,
} from "./config/env.js";
import { GenericSubscriptionProvider } from "./providers/generic-subscription.provider.js";
import { validateRemoteUrl } from "./security/remote-fetch.js";
import { logEvent } from "./observability/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let database = createDatabase({ dataDir });
const db = new Proxy({}, {
  get(_target, property) {
    const value = database[property];
    return typeof value === "function" ? value.bind(database) : value;
  },
});
let subscriptionProvider = new GenericSubscriptionProvider({
  timeoutMs: upstreamTimeout,
  allowPrivate: allowPrivateUpstreamUrls && !productionRuntime,
});
let injectedMailer = null;
const sessions = new Map();
const adminSessions = new Map();
const geoMemoryCache = new Map();
const nodeDiscoveryCache = new Map();
const syncLocks = new Set();
// Reuse an in-flight sync when several client endpoints refresh together.
const subscriptionSyncPromises = new Map();
const subscriptionSyncCooldownMs = 1500;

const now = () => new Date().toISOString();
const randomId = () => crypto.randomUUID();
const subscriptionToken = () => `cvpn_${crypto.randomBytes(18).toString("base64url")}`;
const referralCode = () => `STU${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
const normalizeReferralCode = (value) => String(value || "").trim().toUpperCase().slice(0, 32);
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const processingRecoveryMs = 10 * 60 * 1000;
const sessionHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const passwordResetLifetimeMs = 30 * 60 * 1000;
const toCents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (value) => Number(value || 0) / 100;

function paymentIsReady(config = currentPaymentConfig()) {
  return (config.mode === "mock" && !productionRuntime)
    || (config.mode === "manual" && Boolean(config.manualInstructions))
    || (config.mode === "webhook" && Boolean(config.webhookSecret) && validCheckoutTemplate(config.checkoutTemplate));
}

function isPlaceholderSecret(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || normalized.startsWith("replace-with-")
    || normalized.startsWith("change-me")
    || normalized.startsWith("your-")
    || normalized.startsWith("example-");
}

function hasProductionSecret(value, minimumLength = 32) {
  const secret = String(value || "").trim();
  return secret.length >= minimumLength && !isPlaceholderSecret(secret);
}

function encryptionKeyIsStrong() {
  return hasProductionSecret(process.env.ADMIN_ENCRYPTION_KEY);
}

function paymentIsReadyForProduction(config) {
  return paymentIsReady(config)
    && (config.mode !== "webhook" || hasProductionSecret(config.webhookSecret));
}

function validCheckoutTemplate(value) {
  if (!String(value || "").trim()) return false;
  const probe = String(value).trim().replaceAll("{orderId}", "order-probe").replaceAll("{amount}", "19.90");
  try {
    const parsed = new URL(probe);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function storedAdminPasswordHash() {
  return db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get()?.value || "";
}

function adminPasswordMatches(password) {
  const stored = storedAdminPasswordHash();
  return stored ? bcrypt.compareSync(password, stored) : password === adminPassword;
}

function adminPasswordIsStrong() {
  return Boolean(storedAdminPasswordHash())
    || (adminPassword.length >= 12
      && !["123", "change-me-now"].includes(adminPassword)
      && !isPlaceholderSecret(adminPassword));
}

function checkoutUrlFor(order) {
  const config = currentPaymentConfig();
  if (!validCheckoutTemplate(config.checkoutTemplate) || !order?.id) return null;
  const value = config.checkoutTemplate
    .replaceAll("{orderId}", encodeURIComponent(order.id))
    .replaceAll("{amount}", encodeURIComponent(Number(order.amount).toFixed(2)));
  try { return new URL(value).toString(); } catch { return null; }
}

db.prepare(`INSERT OR IGNORE INTO plans
  (slug, name, first_month_price, renewal_price, data_total_gb, device_limit, billing_period_months)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run("student", "CheapVPN Student Plan", 9.9, 19.9, 50, 2, 1);

const demoEmail = "demo@cheapvpn.local";
if (allowDemoAccount && !db.prepare("SELECT id FROM users WHERE email = ?").get(demoEmail)) {
  db.prepare(`INSERT INTO users (email, name, password_hash, referral_code, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(demoEmail, "Maya Chen", bcrypt.hashSync("demo1234", 10), "MAYA2026", now());
}

function apiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function expirationMillis(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const text = String(value);
  // Legacy rows stored a date only; keep them valid through that calendar day.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function addBillingPeriods(value, periods) {
  // CheapVPN billing periods are fixed 30-day cycles in both deployments.
  // This keeps Docker/SQLite and Cloudflare/D1 expiry behavior identical.
  const days = Number(periods || 0) * 30;
  return new Date(new Date(value).getTime() + days * 24 * 60 * 60 * 1000);
}

function expireSubscriptions() {
  const cutoff = Date.now();
  const active = db.prepare(`SELECT s.id, s.expires_at, s.upstream_expires_at, s.data_used_gb, s.upstream_used_gb, s.usage_source,
    p.data_total_gb FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`).all();
  const expired = active.filter((subscription) => {
    const timeExpired = expirationMillis(subscription.expires_at) <= cutoff;
    const upstreamExpired = subscription.upstream_expires_at && expirationMillis(subscription.upstream_expires_at) <= cutoff;
    const quota = Number(subscription.data_total_gb || 0);
    // A shared upstream token reports the aggregate traffic of all customers.
    // It cannot safely consume an individual customer's plan quota.
    const quotaExhausted = quota > 0 && subscription.usage_source !== "upstream-aggregate"
      && effectiveUsedGb(subscription) >= quota;
    return timeExpired || upstreamExpired || quotaExhausted;
  });
  if (!expired.length) return 0;
  const timestamp = now();
  const update = db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'");
  db.transaction(() => expired.forEach((subscription) => update.run(timestamp, subscription.id)))();
  return expired.length;
}

function expirePendingOrders() {
  const recoveryCutoff = new Date(Date.now() - processingRecoveryMs).toISOString();
  db.prepare("UPDATE orders SET status = 'pending' WHERE status = 'processing' AND created_at <= ?")
    .run(recoveryCutoff);
  return db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
    .run(now()).changes;
}

function activeSubscriptionOrError(userId) {
  expireSubscriptions();
  const subscription = currentSubscription(userId);
  if (!subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "No subscription found", 404);
  if (subscription.status !== "active") throw apiError("SUBSCRIPTION_EXPIRED", "Subscription has expired", 410);
  return subscription;
}

function safeUser(user) {
  return { id: user.id, email: user.email, name: user.name, referralCode: user.referral_code };
}

function ticketView(ticket) {
  return {
    id: ticket.id, subject: ticket.subject, device: ticket.device || "", client: ticket.client || "",
    description: ticket.description, status: ticket.status, createdAt: ticket.created_at,
    updatedAt: ticket.updated_at, resolvedAt: ticket.resolved_at || null,
    user: ticket.email ? { name: ticket.user_name, email: ticket.email } : undefined,
  };
}

function planView(plan) {
  return {
    id: plan.id, slug: plan.slug, name: plan.name, firstMonth: plan.first_month_price,
    renewal: plan.renewal_price, dataTotal: plan.data_total_gb, devices: plan.device_limit,
    periodMonths: plan.billing_period_months || 1, active: Boolean(plan.active),
  };
}

function planInput(body, existing = {}) {
  const slug = String(body?.slug ?? existing.slug ?? "").trim().toLowerCase();
  const name = String(body?.name ?? existing.name ?? "").trim().slice(0, 100);
  const firstMonth = Number(body?.firstMonth ?? body?.first_month_price ?? existing.first_month_price);
  const renewal = Number(body?.renewal ?? body?.renewal_price ?? existing.renewal_price);
  const dataTotal = Number(body?.dataTotal ?? body?.data_total_gb ?? existing.data_total_gb);
  const devices = Number(body?.devices ?? body?.device_limit ?? existing.device_limit);
  const periodMonths = Number(body?.periodMonths ?? body?.billing_period_months ?? existing.billing_period_months ?? 1);
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(slug)) throw apiError("INVALID_PLAN_SLUG", "Plan slug must use lowercase letters, numbers or hyphens");
  if (!name) throw apiError("INVALID_PLAN_NAME", "Plan name is required");
  if (![firstMonth, renewal, dataTotal].every((value) => Number.isFinite(value) && value >= 0)) throw apiError("INVALID_PLAN_PRICE", "Plan prices and data must be non-negative numbers");
  if (!Number.isInteger(devices) || devices < 1 || devices > 100) throw apiError("INVALID_PLAN_DEVICES", "Device limit must be an integer from 1 to 100");
  if (!Number.isInteger(periodMonths) || periodMonths < 1 || periodMonths > 24) throw apiError("INVALID_PLAN_PERIOD", "Billing period must be an integer from 1 to 24 months");
  return { slug, name, firstMonth, renewal, dataTotal, devices, periodMonths };
}

function currentSubscription(userId) {
  return db.prepare(`SELECT s.*, p.slug, p.name, p.first_month_price, p.renewal_price,
    p.data_total_gb, p.device_limit, p.billing_period_months FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.user_id = ?`).get(userId);
}

expireSubscriptions();
expirePendingOrders();
setInterval(() => { expireSubscriptions(); expirePendingOrders(); }, 60 * 1000).unref();

function currentPlan(subscription) {
  return { id: subscription.plan_id, slug: subscription.slug, name: subscription.name,
    first_month_price: subscription.first_month_price, renewal_price: subscription.renewal_price,
    data_total_gb: subscription.data_total_gb, device_limit: subscription.device_limit, billing_period_months: subscription.billing_period_months };
}

function effectiveUsedGb(subscription) {
  const planTotal = Math.max(0, Number(subscription?.data_total_gb || 0));
  const providerUsed = Number(subscription?.upstream_used_gb);
  const manualUsed = Number(subscription?.data_used_gb || 0);
  const raw = subscription?.usage_source === "upstream-aggregate" && Number.isFinite(providerUsed) ? providerUsed : manualUsed;
  return Math.min(planTotal, Math.max(0, Number.isFinite(raw) ? raw : 0));
}

function quotaUsageGb(subscription) {
  if (subscription?.usage_source === "upstream-aggregate") {
    return Math.min(Math.max(0, Number(subscription?.data_total_gb || 0)), Math.max(0, Number(subscription?.data_used_gb || 0)));
  }
  return effectiveUsedGb(subscription);
}

function quotaIsEnforced(subscription) {
  return subscription?.usage_source !== "upstream-aggregate";
}

function recordUsageSnapshot(subscription, capturedAt = now()) {
  if (!subscription?.id || !subscription?.user_id) return;
  db.prepare(`INSERT INTO usage_snapshots
    (subscription_id, user_id, used_gb, total_gb, source, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(subscription.id, subscription.user_id, effectiveUsedGb(subscription), Number(subscription.data_total_gb || 0), subscription.usage_source || "manual", capturedAt);
}

function recordUsageSnapshotValues(subscriptionId, userId, usedGb, totalGb, source, capturedAt = now()) {
  db.prepare(`INSERT INTO usage_snapshots
    (subscription_id, user_id, used_gb, total_gb, source, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(subscriptionId, userId, Math.max(0, Number(usedGb) || 0), Math.max(0, Number(totalGb) || 0), source || "manual", capturedAt);
}

function normalizeUsageExpiry(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function subscriptionView(subscription, plan, baseUrl = publicBaseUrl) {
  const formatLink = (format, field) => subscription.status === "active" && subscription[field]
    ? `${baseUrl}/s/${format === "universal" ? "" : `${format}/`}${subscription.token}` : null;
  return {
    status: subscription.status,
    token: `${subscription.token.slice(0, 12)}****${subscription.token.slice(-4)}`,
    links: subscription.status === "active" ? {
      universal: formatLink("universal", "universal_content"),
      clash: formatLink("clash", "clash_content"),
      singbox: formatLink("singbox", "singbox_content"),
    } : null,
    expiresAt: subscription.expires_at, lastSyncAt: subscription.last_sync_at,
    lastSyncStatus: subscription.last_sync_status, lastSyncError: subscription.last_sync_error,
    plan: planView(plan),
  };
}

function requestOrigin(req) {
  // The Vite proxy changes the backend Host header to port 4000. Prefer the
  // explicitly configured public origin so copied links remain reachable on phones.
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  if (trustProxyHeaders && forwardedHost && /^[a-z0-9.-]+(?::\d+)?$/i.test(forwardedHost)) {
    const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    return `${protocol}://${forwardedHost}`;
  }
  return publicBaseUrl;
}

function auth(req, _res, next) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const cached = sessions.get(bearer);
  const cachedUserId = cached && expirationMillis(cached.expiresAt) > Date.now() ? cached.userId : null;
  if (cached && !cachedUserId) sessions.delete(bearer);
  const stored = !cachedUserId && bearer ? db.prepare(`SELECT user_id, expires_at FROM user_sessions
    WHERE token_hash = ?`).get(sessionHash(bearer)) : null;
  const userId = cachedUserId || (stored && expirationMillis(stored.expires_at) > Date.now() ? stored.user_id : null);
  if (!userId) return next(apiError("UNAUTHORIZED", "Please sign in first", 401));
  if (stored) {
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now(), sessionHash(bearer));
    sessions.set(bearer, { userId, expiresAt: stored.expires_at });
  }
  req.user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!req.user) return next(apiError("UNAUTHORIZED", "User no longer exists", 401));
  req.sessionToken = bearer;
  next();
}

function createSession(userId) {
  const session = crypto.randomBytes(32).toString("hex");
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  db.prepare(`INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)`).run(sessionHash(session), userId, expiresAt, timestamp, timestamp);
  sessions.set(session, { userId, expiresAt });
  return session;
}

function createAdminSession() {
  const session = crypto.randomBytes(32).toString("hex");
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  db.prepare(`INSERT INTO admin_sessions (token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)`).run(sessionHash(session), expiresAt, timestamp, timestamp);
  adminSessions.set(session, { expiresAt });
  return session;
}

function encryptionKey() {
  return crypto.createHash("sha256").update(process.env.ADMIN_ENCRYPTION_KEY || adminPassword).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decrypt(value) {
  const [ivText, tagText, encryptedText] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function storedSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || "";
}

function encryptedSetting(key, fallback = "") {
  const value = storedSetting(key);
  if (!value) return fallback;
  try { return decrypt(value); } catch { return fallback; }
}

function currentPaymentConfig() {
  const storedMode = storedSetting("payment_mode");
  const mode = ["mock", "manual", "webhook"].includes(storedMode) ? storedMode : paymentModeDefault;
  let methodIds = ["wechat_pay", "alipay", "card"];
  try {
    const storedMethods = JSON.parse(storedSetting("payment_method_ids"));
    if (Array.isArray(storedMethods)) methodIds = storedMethods;
  } catch { /* Use the customer-friendly defaults until an admin customizes them. */ }
  return {
    mode,
    webhookSecret: encryptedSetting("payment_webhook_secret_encrypted", paymentWebhookSecretDefault),
    checkoutTemplate: encryptedSetting("payment_checkout_template_encrypted", paymentCheckoutTemplateDefault),
    manualInstructions: encryptedSetting("payment_manual_instructions_encrypted", paymentManualInstructionsDefault).slice(0, 2000),
    methods: paymentMethodCatalog.filter((method) => methodIds.includes(method.id)).length
      ? paymentMethodCatalog.filter((method) => methodIds.includes(method.id))
      : paymentMethodCatalog.filter((method) => ["wechat_pay", "alipay", "card"].includes(method.id)),
  };
}

function currentUsageApiConfig() {
  const storedUrl = db.prepare("SELECT value FROM settings WHERE key = 'usage_api_url_encrypted'").get()?.value;
  const storedToken = db.prepare("SELECT value FROM settings WHERE key = 'usage_api_token_encrypted'").get()?.value;
  let url = storedSetting("usage_api_url_disabled") === "1" ? "" : upstreamUsageApiUrlDefault;
  let token = storedSetting("usage_api_token_disabled") === "1" ? "" : upstreamUsageApiTokenDefault;
  try { if (storedUrl && storedSetting("usage_api_url_disabled") !== "1") url = decrypt(storedUrl); } catch { /* Fall back to the environment default if the stored value is unreadable. */ }
  try { if (storedToken && storedSetting("usage_api_token_disabled") !== "1") token = decrypt(storedToken); } catch { /* Fall back to the environment default if the stored value is unreadable. */ }
  return { url, token };
}

function currentEmailConfig() {
  return {
    smtpUrl: encryptedSetting("smtp_url_encrypted", smtpUrlDefault),
    from: encryptedSetting("email_from_encrypted", emailFromDefault).slice(0, 180),
  };
}

function validSmtpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["smtp:", "smtps:"].includes(url.protocol) && Boolean(url.hostname);
  } catch { return false; }
}

async function sendPasswordResetEmail(user, rawToken) {
  const email = currentEmailConfig();
  if (!validSmtpUrl(email.smtpUrl) || !email.from) return false;
  const resetUrl = `${publicBaseUrl}/?reset=${encodeURIComponent(rawToken)}`;
  const transport = injectedMailer || nodemailer.createTransport(email.smtpUrl);
  await transport.sendMail({
    from: email.from,
    to: user.email,
    subject: "Reset your CheapVPN password",
    text: `Hello ${user.name},\n\nUse this link within 30 minutes to reset your CheapVPN password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
  });
  return true;
}

function currentUsageSyncInterval() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'usage_sync_interval_ms'").get()?.value;
  const value = stored === undefined ? upstreamUsageSyncIntervalDefault : Number(stored);
  return Number.isFinite(value) && value >= 30 * 1000 ? value : 0;
}

function configuredUpstreamUrl() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'upstream_subscription_url'").get();
  if (setting) {
    try { return decrypt(setting.value); } catch { return ""; }
  }
  return process.env.UPSTREAM_SUBSCRIPTION_URL || "";
}

function maskUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? "?token=••••••" : ""}`;
  } catch {
    return "已配置（地址格式待检查）";
  }
}

function sourceById(sourceId) {
  return sourceId ? db.prepare("SELECT * FROM upstream_sources WHERE id = ?").get(sourceId) : null;
}

function ensureEnabledDefaultSource() {
  db.prepare("UPDATE upstream_sources SET is_default = 0 WHERE enabled = 0").run();
  const current = db.prepare("SELECT id FROM upstream_sources WHERE enabled = 1 AND is_default = 1 ORDER BY id LIMIT 1").get();
  if (current) {
    db.prepare("UPDATE upstream_sources SET is_default = 0 WHERE enabled = 1 AND id != ?").run(current.id);
    return current.id;
  }
  const replacement = db.prepare("SELECT id FROM upstream_sources WHERE enabled = 1 ORDER BY id LIMIT 1").get();
  if (!replacement) return null;
  db.prepare("UPDATE upstream_sources SET is_default = 1 WHERE id = ?").run(replacement.id);
  return replacement.id;
}

function invalidateSourceSubscriptions(sourceId) {
  if (!sourceId) return;
  const boundSubscriptions = db.prepare(`SELECT DISTINCT s.id FROM subscriptions s
    LEFT JOIN subscription_source_assignments a ON a.subscription_id = s.id
    WHERE s.status = 'active' AND (s.source_id = ? OR a.source_id = ?)`).all(sourceId, sourceId);
  boundSubscriptions.forEach(({ id }) => subscriptionSyncPromises.delete(id));
  const timestamp = now();
  const invalidate = db.prepare("UPDATE subscriptions SET last_sync_at = NULL, last_sync_status = 'pending', last_sync_error = NULL, updated_at = ? WHERE id = ?");
  db.transaction(() => boundSubscriptions.forEach(({ id }) => invalidate.run(timestamp, id)))();
}

function defaultSource() {
  return db.prepare("SELECT * FROM upstream_sources WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1").get();
}

function currentUpstreamAssignmentMode() {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'upstream_assignment_mode'").get()?.value;
  return ["default", "round_robin"].includes(stored) ? stored : upstreamAssignmentDefault;
}

function sourceForNewSubscription(userId) {
  const sources = db.prepare("SELECT * FROM upstream_sources WHERE enabled = 1 ORDER BY is_default DESC, id ASC").all();
  if (!sources.length) return null;
  if (currentUpstreamAssignmentMode() !== "round_robin") return sources[0];
  return sources[Math.abs(Number(userId) || 0) % sources.length];
}

function sourceView(source) {
  const universal = source.universal_url_encrypted ? decrypt(source.universal_url_encrypted) : decrypt(source.url_encrypted);
  const clash = source.clash_url_encrypted ? decrypt(source.clash_url_encrypted) : "";
  const singbox = source.singbox_url_encrypted ? decrypt(source.singbox_url_encrypted) : "";
  return {
    id: source.id,
    name: source.name,
    enabled: Boolean(source.enabled),
    isDefault: Boolean(source.is_default),
    maskedUrl: maskUrl(universal),
    formatUrls: { universal: maskUrl(universal), clash: maskUrl(clash), singbox: maskUrl(singbox) },
    nodeRules: parseNodeRules(source.node_rules_json),
    lastSyncAt: source.last_sync_at || "-",
    lastSyncStatus: source.last_sync_status || "-",
    lastSyncError: source.last_sync_error || null,
    createdAt: source.created_at,
  };
}

function parseNodeRules(value) {
  try {
    const rules = JSON.parse(value || "[]");
    return Array.isArray(rules) ? rules.filter((rule) => rule && rule.match && rule.name).slice(0, 200) : [];
  } catch {
    return [];
  }
}

function nodeRulesFor(source) {
  return parseNodeRules(source?.node_rules_json);
}

function applyNodeRules(content, source, format) {
  const rules = nodeRulesFor(source);
  if (!rules.length || !content) return content;
  const rename = (name) => {
    // Later rules override earlier broad rules, making manual verification easy.
    const rule = [...rules].reverse().find((candidate) => name.includes(candidate.match));
    return rule ? rule.name : name;
  };

  if (format === "universal") {
    const compact = content.replace(/\s+/g, "");
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      const isEncoded = /(?:^|\n)(?:vless|vmess|trojan|ss|ssr|hysteria|hysteria2|tuic|wireguard):\/\//im.test(decoded);
      const source = isEncoded ? decoded : content;
      if (/(?:^|\n)(?:vless|vmess|trojan|ss|ssr|hysteria|hysteria2|tuic|wireguard):\/\//im.test(source)) {
        const rewritten = source.split(/\r?\n/).map((line) => {
          const hash = line.indexOf("#");
          if (hash < 0) return line;
          let current = line.slice(hash + 1);
          try { current = decodeURIComponent(current); } catch { /* Keep an already readable node name. */ }
          return `${line.slice(0, hash)}#${encodeURIComponent(rename(current))}`;
        }).join("\n");
        return isEncoded ? Buffer.from(rewritten).toString("base64") : rewritten;
      }
    } catch { return content; }
    return content;
  }

  if (format === "singbox") {
    try {
      const json = JSON.parse(content);
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (typeof value.tag === "string") value.tag = rename(value.tag);
        Object.values(value).forEach(visit);
      };
      visit(json);
      return JSON.stringify(json, null, 2);
    } catch { return content; }
  }

  return content.replace(/(^\s*[-]?\s*name\s*:\s*)(["']?)([^"'\r\n]+)\2/gm, (_all, prefix, quote, name) => `${prefix}${quote}${rename(name.trim())}${quote}`);
}

function subscriptionChangedSinceSyncStarted(subscription) {
  const current = db.prepare("SELECT updated_at FROM subscriptions WHERE id = ?").get(subscription.id);
  return !current || current.updated_at !== subscription.updated_at;
}

function formatLooksUsable(content, format) {
  if (format === "universal") return parseUniversalNodes(content).length > 0;
  if (format === "clash") return /(^|\n)\s*proxies\s*:/i.test(content) && /(^|\n)\s*-\s*(name|type)\s*:/i.test(content);
  if (format === "singbox") {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed?.outbounds) && parsed.outbounds.length > 0;
    } catch { return false; }
  }
  return false;
}

function flagForCountryCode(code) {
  return /^[A-Z]{2}$/.test(code || "") ? [...code].map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join("") : "🌐";
}

function countryHintFromName(name) {
  const hints = [
    [/(新加坡|singapore|\bsg\b)/i, "Singapore", "SG"],
    [/(日本|japan|\bjp\b)/i, "Japan", "JP"],
    [/(英国|英國|uk|united kingdom|london)/i, "United Kingdom", "GB"],
    [/(美国|美國|usa|united states|\bus\b)/i, "United States", "US"],
    [/(香港|hong kong|\bhk\b)/i, "Hong Kong", "HK"],
    [/(台湾|台灣|taiwan|\btw\b)/i, "Taiwan", "TW"],
    [/(韩国|韓國|korea|\bkr\b)/i, "South Korea", "KR"],
    [/(德国|德國|germany|\bde\b)/i, "Germany", "DE"],
  ];
  const match = hints.find(([pattern]) => pattern.test(name));
  return match ? { country: match[1], countryCode: match[2], confidence: "name" } : null;
}

function parseUniversalNodes(content) {
  try {
    const supported = /^(?:vless|vmess|trojan|ss|ssr|hysteria|hysteria2|tuic|wireguard):\/\//i;
    const encoded = content.replace(/\s+/g, "");
    const decodedCandidate = Buffer.from(encoded, "base64").toString("utf8");
    const decoded = /(?:^|\n)(?:vless|vmess|trojan|ss|ssr|hysteria|hysteria2|tuic|wireguard):\/\//im.test(decodedCandidate) ? decodedCandidate : content;
    const decodeBase64 = (value) => {
      try {
        const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
        return Buffer.from(normalized, "base64").toString("utf8");
      } catch { return ""; }
    };
    const parseEndpoint = (line) => {
      const protocol = line.slice(0, line.indexOf(":")).toLowerCase();
      if (protocol === "vmess") {
        const payload = decodeBase64(line.slice("vmess://".length));
        try {
          const config = JSON.parse(payload);
          return { host: String(config.add || config.address || ""), port: Number(config.port || 443) };
        } catch { return null; }
      }
      if (protocol === "ss") {
        const encoded = line.slice("ss://".length).split("#", 1)[0];
        const decodedPart = encoded.includes("@") ? encoded : decodeBase64(encoded);
        const at = decodedPart.lastIndexOf("@");
        const endpoint = at >= 0 ? decodedPart.slice(at + 1) : decodedPart;
        const match = endpoint.match(/^\[?([^\]]+)\]?(?::(\d+))?$/);
        if (match) return { host: match[1], port: Number(match[2] || 443) };
      }
      try {
        const url = new URL(line);
        if (url.hostname) return { host: url.hostname, port: Number(url.port || 443) };
      } catch { return null; }
      return null;
    };
    return decoded.split(/\r?\n/).map((line, index) => {
      const trimmed = line.trim();
      if (!supported.test(trimmed)) return null;
      const endpoint = parseEndpoint(trimmed);
      if (!endpoint?.host) return null;
      let rawName = `Node ${index + 1}`;
      try { rawName = decodeURIComponent(new URL(trimmed).hash.slice(1)) || rawName; } catch { /* Encoded VMess/SS names are optional. */ }
      return { index, protocol: trimmed.slice(0, trimmed.indexOf(":")).toLowerCase(), rawName, ...endpoint };
    }).filter(Boolean).slice(0, 100);
  } catch { return []; }
}

function universalLines(content) {
  const raw = String(content || "").trim();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, "");
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    if (/(?:^|\n)(?:vless|vmess|trojan|ss|ssr|hysteria|hysteria2|tuic|wireguard):\/\//im.test(decoded)) {
      return decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  } catch { /* Keep plain-text subscriptions below. */ }
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function nodeNameFromUri(uri, fallback) {
  const hash = uri.indexOf("#");
  if (hash < 0) return fallback;
  try { return decodeURIComponent(uri.slice(hash + 1)) || fallback; } catch { return uri.slice(hash + 1) || fallback; }
}

function decodeUrlBase64(value) {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch { return ""; }
}

function universalNodeConfigs(content) {
  return universalLines(content).map((line, index) => {
    const uri = line.split("#", 1)[0];
    const name = nodeNameFromUri(line, `Node ${index + 1}`);
    try {
      if (/^vmess:\/\//i.test(uri)) {
        const config = JSON.parse(decodeUrlBase64(uri.slice("vmess://".length)));
        return { name, type: "vmess", server: config.add || config.address, port: Number(config.port || 443), uuid: config.id, alterId: Number(config.aid || 0), cipher: "auto", network: config.net || "tcp", path: config.path, host: config.host, tls: String(config.tls || "").toLowerCase() === "tls", sni: config.sni || config.host };
      }
      const parsed = new URL(line);
      const server = parsed.hostname;
      const port = Number(parsed.port || 443);
      if (!server || !Number.isFinite(port)) return null;
      const network = parsed.searchParams.get("type") || parsed.searchParams.get("network") || "tcp";
      const tls = parsed.searchParams.get("security") === "tls" || parsed.protocol.toLowerCase() === "trojan:" || parsed.searchParams.get("tls") === "1";
      const config = { name, server, port, network, path: parsed.searchParams.get("path") || "", host: parsed.searchParams.get("host") || "", tls, sni: parsed.searchParams.get("sni") || parsed.searchParams.get("peer") || server };
      if (parsed.protocol.toLowerCase() === "vless:") return { ...config, type: "vless", uuid: decodeURIComponent(parsed.username || "") };
      if (parsed.protocol.toLowerCase() === "trojan:") return { ...config, type: "trojan", password: decodeURIComponent(parsed.username || "") };
      if (parsed.protocol.toLowerCase() === "hysteria2:") return { ...config, type: "hysteria2", password: decodeURIComponent(parsed.username || parsed.password || "") };
      if (parsed.protocol.toLowerCase() === "ss:") {
        const userInfo = decodeURIComponent(parsed.username || "");
        const separator = userInfo.indexOf(":");
        return { ...config, type: "ss", cipher: separator >= 0 ? userInfo.slice(0, separator) : "aes-128-gcm", password: separator >= 0 ? userInfo.slice(separator + 1) : userInfo };
      }
    } catch { return null; }
    return null;
  }).filter((node) => node?.server && node?.port).slice(0, 100);
}

function convertUniversalToClash(content) {
  const nodes = universalNodeConfigs(content);
  if (!nodes.length) return "";
  const quote = (value) => JSON.stringify(String(value ?? ""));
  const lines = ["proxies:"];
  const names = [];
  nodes.forEach((node) => {
    names.push(node.name);
    lines.push(`  - name: ${quote(node.name)}`, `    type: ${node.type}`, `    server: ${quote(node.server)}`, `    port: ${node.port}`);
    if (node.type === "vmess") lines.push(`    uuid: ${quote(node.uuid)}`, `    alterId: ${node.alterId}`, `    cipher: ${node.cipher}`, `    tls: ${Boolean(node.tls)}`);
    if (node.type === "vless") lines.push(`    uuid: ${quote(node.uuid)}`, `    tls: ${Boolean(node.tls)}`);
    if (node.type === "trojan" || node.type === "hysteria2") lines.push(`    password: ${quote(node.password)}`, `    tls: true`);
    if (node.type === "ss") lines.push(`    cipher: ${quote(node.cipher)}`, `    password: ${quote(node.password)}`);
    if (node.sni && node.tls) lines.push(`    servername: ${quote(node.sni)}`);
    if (node.network === "ws") {
      lines.push("    network: ws", "    ws-opts:", `      path: ${quote(node.path || "/")}`);
      if (node.host) lines.push("      headers:", `        Host: ${quote(node.host)}`);
    }
  });
  // Clash clients commonly show selectable nodes through proxy groups rather
  // than the raw proxies list. Include a default group so imported profiles
  // are immediately usable on mobile clients.
  lines.push("proxy-groups:", "  - name: CheapVPN", "    type: select", "    proxies:");
  names.forEach((name) => lines.push(`      - ${quote(name)}`));
  lines.push("      - DIRECT", "rules:", "  - MATCH,CheapVPN");
  return lines.join("\n") + "\n";
}

function ensureClashProxyGroup(content) {
  const text = String(content || "");
  if (!formatLooksUsable(text, "clash") || /(^|\n)proxy-groups\s*:/i.test(text)) return text;
  const names = [...text.matchAll(/^\s{2}-\s+name:\s*(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
  if (!names.length) return text;
  return `${text.trimEnd()}\nproxy-groups:\n  - name: CheapVPN\n    type: select\n    proxies:\n${names.map((name) => `      - ${name}`).join("\n")}\n      - DIRECT\nrules:\n  - MATCH,CheapVPN\n`;
}

function convertUniversalToSingBox(content) {
  const nodes = universalNodeConfigs(content);
  if (!nodes.length) return "";
  const outbounds = nodes.map((node) => {
    const result = { type: node.type, tag: node.name, server: node.server, server_port: node.port };
    if (node.type === "vmess" || node.type === "vless") result.uuid = node.uuid;
    if (node.type === "trojan" || node.type === "hysteria2") result.password = node.password;
    if (node.type === "ss") { result.method = node.cipher; result.password = node.password; }
    if (node.tls) result.tls = { enabled: true, server_name: node.sni || node.server };
    if (node.network === "ws") result.transport = { type: "ws", path: node.path || "/", headers: node.host ? { Host: node.host } : undefined };
    return result;
  });
  return JSON.stringify({ outbounds }, null, 2);
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(nodeProbeTimeout, () => finish({ reachable: false, latencyMs: null }));
    socket.once("connect", () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once("error", () => finish({ reachable: false, latencyMs: null }));
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function geoLookup(host) {
  const originalHost = String(host).trim().toLowerCase();
  const cachedHost = geoMemoryCache.get(originalHost);
  if (cachedHost && cachedHost.expiresAt > Date.now()) return cachedHost.result;
  let address = originalHost;
  const rawOctets = address.split(".").map(Number);
  const rawIsIpv4 = rawOctets.length === 4 && rawOctets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  if (!rawIsIpv4) {
    try {
      address = (await dns.lookup(originalHost, { family: 4 })).address;
    } catch {
      const result = { country: "", countryCode: "" };
      geoMemoryCache.set(originalHost, { result, expiresAt: Date.now() + 30 * 1000 });
      return result;
    }
  }
  const octets = address.split(".").map(Number);
  const isIpv4 = octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  const isPrivate = isIpv4 && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (!isIpv4 || isPrivate) return { country: "", countryCode: "" };
  const cached = geoMemoryCache.get(address);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  try {
    const response = await fetch(`https://ipwho.is/${address}?fields=success,country,country_code`, { signal: AbortSignal.timeout(nodeGeoTimeout) });
    const data = await response.json();
    const result = data.success ? { country: data.country || "", countryCode: String(data.country_code || "").toUpperCase() } : { country: "", countryCode: "" };
    geoMemoryCache.set(originalHost, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
    geoMemoryCache.set(address, { result, expiresAt: Date.now() + 10 * 60 * 1000 });
    return result;
  } catch {
    const result = { country: "", countryCode: "" };
    // Shorter negative caching lets a temporary geo-provider failure recover quickly.
    geoMemoryCache.set(originalHost, { result, expiresAt: Date.now() + 30 * 1000 });
    geoMemoryCache.set(address, { result, expiresAt: Date.now() + 30 * 1000 });
    return result;
  }
}

function sourceUrl(source, format = "universal") {
  const encrypted = format === "clash" ? source.clash_url_encrypted : format === "singbox" ? source.singbox_url_encrypted : source.universal_url_encrypted;
  const universal = source.universal_url_encrypted ? decrypt(source.universal_url_encrypted) : decrypt(source.url_encrypted);
  if (encrypted) return decrypt(encrypted);
  if (format === "universal") return universal;

  // Many subscription providers expose format variants through query flags.
  // Keep this fallback server-side so the customer never sees the upstream URL.
  try {
    const parsed = new URL(universal);
    parsed.searchParams.delete("b64");
    parsed.searchParams.delete("clash");
    parsed.searchParams.delete("sb");
    parsed.searchParams.set(format === "clash" ? "clash" : "sb", "");
    return parsed.toString();
  } catch {
    return universal;
  }
}

function migrateLegacySource() {
  if (db.prepare("SELECT id FROM upstream_sources LIMIT 1").get()) return;
  const legacyUrl = configuredUpstreamUrl();
  if (!legacyUrl) return;
  const timestamp = now();
  db.prepare(`INSERT INTO upstream_sources
    (name, url_encrypted, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?)`).run("默认货源", encrypt(legacyUrl), timestamp, timestamp);
}

migrateLegacySource();
migrateResourcePools();

function demoContent() {
  return "# CheapVPN demo subscription\n# Configure UPSTREAM_SUBSCRIPTION_URL for a real server-side source.\n";
}

async function fetchUpstream(sourceId, format = "universal") {
  const selectedSource = sourceById(sourceId) || defaultSource();
  const hasExplicitFormatUrl = Boolean(selectedSource && (format === "clash"
    ? selectedSource.clash_url_encrypted
    : format === "singbox" ? selectedSource.singbox_url_encrypted : selectedSource.universal_url_encrypted));
  // Do not invent ?clash or ?sb requests when the supplier only provided one
  // generic URL. Fetch the generic subscription once and convert it locally.
  const upstreamUrl = selectedSource && format !== "universal" && !hasExplicitFormatUrl
    ? sourceUrl(selectedSource, "universal")
    : selectedSource ? sourceUrl(selectedSource, format) : configuredUpstreamUrl();
  if (!upstreamUrl) {
    if (allowDemoSubscription && !productionRuntime) return { content: demoContent(), source: "demo", sourceId: null };
    throw apiError("UPSTREAM_NOT_CONFIGURED", "Configure a real upstream source before serving subscriptions", 503);
  }
  try {
    const result = await subscriptionProvider.getSubscription(upstreamUrl, { format });
    const response = result.response;
    if (!response.ok) throw apiError("UPSTREAM_FETCH_FAILED", `Upstream responded with ${response.status}`, 502);
    const raw = result.content;
    const trimmed = raw.trim();
    if (!trimmed || /^<!doctype html|^<html[\s>]/i.test(trimmed)) {
      throw apiError("UPSTREAM_INVALID_CONTENT", `${format} subscription returned empty or HTML content`, 502);
    }
    let content = raw;
    if (format === "clash" && !formatLooksUsable(trimmed, format)) content = convertUniversalToClash(trimmed);
    if (format === "singbox" && !formatLooksUsable(trimmed, format)) content = convertUniversalToSingBox(trimmed);
    if (format === "clash") content = ensureClashProxyGroup(content);
    if (upstreamUrl && !formatLooksUsable(content.trim(), format)) {
      const labels = { universal: "supported nodes", clash: "Clash proxies", singbox: "SingBox outbounds" };
      throw apiError("UPSTREAM_INVALID_CONTENT", `${format} subscription contains no ${labels[format] || "usable configuration"}`, 502);
    }
    return { content: applyNodeRules(content, selectedSource, format), source: "upstream", sourceId: selectedSource?.id || null, usage: format === "universal" ? parseUpstreamUsage(response.headers) : null };
  } catch (error) {
    logEvent("upstream.fetch", { sourceId: selectedSource?.id || null, format, code: error.code || "UPSTREAM_FETCH_FAILED", success: false }, "warn");
    throw error;
  }
}

function defaultPool() {
  return db.prepare("SELECT * FROM upstream_pools WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1").get();
}

function poolById(poolId) {
  return poolId ? db.prepare("SELECT * FROM upstream_pools WHERE id = ?").get(Number(poolId)) : null;
}

function poolMembers(poolId, { onlyHealthyCandidates = false } = {}) {
  if (!poolId) return [];
  const enabledClause = onlyHealthyCandidates ? "AND pm.enabled = 1 AND s.enabled = 1" : "";
  return db.prepare(`SELECT s.*, pm.enabled AS pool_member_enabled, pm.priority AS pool_priority
    FROM upstream_pool_members pm JOIN upstream_sources s ON s.id = pm.source_id
    WHERE pm.pool_id = ? ${enabledClause} ORDER BY pm.priority ASC, s.id ASC`).all(Number(poolId));
}

function poolView(pool, { includeMembers = true } = {}) {
  const members = includeMembers ? poolMembers(pool.id).map((source) => ({
    id: source.id, name: source.name, enabled: Boolean(source.enabled && source.pool_member_enabled),
    sourceEnabled: Boolean(source.enabled), priority: source.pool_priority,
    lastSyncAt: source.last_sync_at || "-", lastSyncStatus: source.last_sync_status || "-",
  })) : [];
  return {
    id: pool.id, name: pool.name, enabled: Boolean(pool.enabled), isDefault: Boolean(pool.is_default),
    deliveryMode: pool.delivery_mode, memberCount: members.length, members,
    createdAt: pool.created_at, updatedAt: pool.updated_at,
  };
}

function ensureDefaultResourcePool() {
  const timestamp = now();
  let pool = defaultPool();
  if (!pool) {
    const inserted = db.prepare(`INSERT INTO upstream_pools (name, enabled, is_default, delivery_mode, created_at, updated_at)
      VALUES ('默认资源池', 1, 1, 'merge_all', ?, ?)`).run(timestamp, timestamp);
    pool = poolById(inserted.lastInsertRowid);
  }
  const sources = db.prepare("SELECT id FROM upstream_sources ORDER BY id ASC").all();
  const attach = db.prepare(`INSERT OR IGNORE INTO upstream_pool_members
    (pool_id, source_id, enabled, priority, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`);
  const highestPriority = db.prepare("SELECT COALESCE(MAX(priority), -1) AS value FROM upstream_pool_members WHERE pool_id = ?").get(pool.id).value;
  db.transaction(() => sources.forEach((source, index) => attach.run(pool.id, source.id, Number(highestPriority) + index + 1, timestamp, timestamp)))();
  return poolById(pool.id);
}

function migrateResourcePools() {
  const pool = ensureDefaultResourcePool();
  const timestamp = now();
  const subscriptions = db.prepare("SELECT id, source_id, pool_id FROM subscriptions").all();
  const insertAssignment = db.prepare(`INSERT OR IGNORE INTO subscription_source_assignments
    (subscription_id, source_id, state, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`);
  const updatePool = db.prepare("UPDATE subscriptions SET pool_id = ? WHERE id = ? AND pool_id IS NULL");
  db.transaction(() => subscriptions.forEach((subscription) => {
    if (subscription.source_id) insertAssignment.run(subscription.id, subscription.source_id, timestamp, timestamp);
    if (subscription.source_id && !subscription.pool_id) updatePool.run(pool.id, subscription.id);
  }))();
}

function poolForNewSubscription() {
  const pool = ensureDefaultResourcePool();
  return pool?.enabled ? pool : null;
}

function assignedPoolSources(subscription) {
  const assigned = db.prepare(`SELECT s.*, a.state AS assignment_state, a.last_sync_at AS assignment_last_sync_at,
    a.last_sync_status AS assignment_last_sync_status, a.last_sync_error AS assignment_last_sync_error
    FROM subscription_source_assignments a JOIN upstream_sources s ON s.id = a.source_id
    WHERE a.subscription_id = ? ORDER BY s.id ASC`).all(subscription.id);
  if (assigned.length) return assigned;
  if (subscription.pool_id) return poolMembers(subscription.pool_id);
  return subscription.source_id ? [sourceById(subscription.source_id)].filter(Boolean) : [];
}

function ensureSubscriptionSourceAssignments(subscriptionId, poolId, fallbackSourceId = null) {
  const timestamp = now();
  const sources = poolId ? poolMembers(poolId, { onlyHealthyCandidates: true }) : (fallbackSourceId ? [sourceById(fallbackSourceId)].filter(Boolean) : []);
  const insert = db.prepare(`INSERT OR IGNORE INTO subscription_source_assignments
    (subscription_id, source_id, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`);
  db.transaction(() => sources.forEach((source) => insert.run(subscriptionId, source.id, timestamp, timestamp)))();
  return assignedPoolSources({ id: subscriptionId, pool_id: poolId, source_id: fallbackSourceId });
}

function validateUpstreamUrl(value) {
  try {
    validateRemoteUrl(value, { allowPrivate: allowPrivateUpstreamUrls && !productionRuntime });
  } catch (error) {
    throw apiError(error.code || "INVALID_UPSTREAM_URL", error.message, error.status || 400);
  }
}

function parseUpstreamUsage(headers) {
  const value = headers.get("subscription-userinfo");
  if (!value) return null;
  const fields = Object.fromEntries(value.split(/[;,]/).map((part) => {
    const [key, raw] = part.trim().split("=", 2);
    return [key, Number(raw)];
  }).filter(([key, number]) => key && Number.isFinite(number)));
  const usedBytes = (fields.upload || 0) + (fields.download || 0);
  const totalBytes = fields.total || 0;
  if (!usedBytes && !totalBytes && !fields.expire) return null;
  return {
    usedGb: usedBytes / 1024 ** 3,
    totalGb: totalBytes ? totalBytes / 1024 ** 3 : null,
    expiresAt: fields.expire ? new Date(fields.expire * 1000).toISOString() : null,
  };
}

async function fetchSubscriptionFormats(sourceId, previous = null) {
  const results = await Promise.allSettled([
    fetchUpstream(sourceId, "universal"),
    fetchUpstream(sourceId, "clash"),
    fetchUpstream(sourceId, "singbox"),
  ]);
  if (results[0].status === "rejected") throw results[0].reason;
  const universal = results[0].value;
  const warnings = [];
  const fallback = (result, field, label, format) => {
    if (result.status === "fulfilled" && formatLooksUsable(result.value.content, format)) return result.value;
    warnings.push(`${label}: ${result.reason?.message || "fetch failed"}`);
    if (previous?.[field] && formatLooksUsable(previous[field], format)) {
      return { content: previous[field], source: "stale", sourceId: universal.sourceId };
    }
    return { content: format === "universal" ? universal.content : "", source: "stale", sourceId: universal.sourceId };
  };
  return {
    universal,
    clash: fallback(results[1], "clash_content", "Clash", "clash"),
    singbox: fallback(results[2], "singbox_content", "SingBox", "singbox"),
    warnings,
  };
}

function nodeFingerprint(line) {
  const withoutName = String(line || "").trim().split("#", 1)[0];
  if (!withoutName) return "";
  if (/^vmess:\/\//i.test(withoutName)) {
    try {
      const config = JSON.parse(decodeUrlBase64(withoutName.slice("vmess://".length)));
      return crypto.createHash("sha256").update(JSON.stringify({
        type: "vmess", server: config.add || config.address, port: String(config.port || 443),
        id: config.id, network: config.net || "tcp", host: config.host || "", path: config.path || "", tls: config.tls || "", sni: config.sni || "",
      })).digest("hex");
    } catch { /* Fall through to the opaque line hash. */ }
  }
  try {
    const parsed = new URL(withoutName);
    const query = [...parsed.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    return crypto.createHash("sha256").update(JSON.stringify({
      protocol: parsed.protocol.toLowerCase(), host: parsed.hostname.toLowerCase(), port: parsed.port || "443",
      username: decodeURIComponent(parsed.username || ""), password: decodeURIComponent(parsed.password || ""), query,
    })).digest("hex");
  } catch {
    return crypto.createHash("sha256").update(withoutName).digest("hex");
  }
}

function mergeUniversalContents(contents) {
  const lines = [];
  const fingerprints = new Set();
  let totalNodes = 0;
  for (const content of contents) {
    for (const line of universalLines(content)) {
      totalNodes += 1;
      const fingerprint = nodeFingerprint(line);
      if (!fingerprint || fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      lines.push(line);
    }
  }
  return { content: lines.join("\n") + (lines.length ? "\n" : ""), totalNodes, uniqueNodes: lines.length };
}

function protocolCounts(content) {
  const counts = {};
  universalLines(content).forEach((line) => {
    const protocol = String(line).split(":", 1)[0].toLowerCase() || "unknown";
    counts[protocol] = (counts[protocol] || 0) + 1;
  });
  return counts;
}

async function collectPoolSubscriptionFormats(pool, sources = poolMembers(pool?.id, { onlyHealthyCandidates: true })) {
  if (!pool || !pool.enabled) throw apiError("POOL_NOT_CONFIGURED", "Configure an enabled resource pool before activating a subscription", 503);
  if (!sources.length) throw apiError("POOL_EMPTY", "The resource pool has no enabled sources", 503);
  const settled = await Promise.allSettled(sources.map((source) => fetchUpstream(source.id, "universal")));
  const sourceResults = settled.map((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled") return { sourceId: source.id, sourceName: source.name, ok: true, content: result.value.content, usage: result.value.usage || null };
    return { sourceId: source.id, sourceName: source.name, ok: false, code: result.reason?.code || "UPSTREAM_FETCH_FAILED" };
  });
  const successful = sourceResults.filter((result) => result.ok);
  if (!successful.length) throw apiError("POOL_SYNC_FAILED", "No healthy upstream source is available", 502);
  const merged = mergeUniversalContents(successful.map((result) => result.content));
  if (!formatLooksUsable(merged.content, "universal")) throw apiError("POOL_INVALID_CONTENT", "Healthy upstream sources produced no supported nodes", 502);
  const clashContent = convertUniversalToClash(merged.content);
  const singboxContent = convertUniversalToSingBox(merged.content);
  const warnings = sourceResults.filter((result) => !result.ok).map((result) => `${result.sourceName}: ${result.code}`);
  return {
    // A single healthy source keeps the existing aggregate usage signal. Once
    // several sources are merged, summing their shared counters would invent a
    // customer quota, so no aggregate usage is reported.
    universal: { content: merged.content, source: "upstream", sourceId: successful[0].sourceId, usage: successful.length === 1 ? successful[0].usage : null },
    clash: { content: clashContent, source: "upstream", sourceId: successful[0].sourceId },
    singbox: { content: singboxContent, source: "upstream", sourceId: successful[0].sourceId },
    warnings, sourceResults, stats: { healthySources: successful.length, failedSources: sourceResults.length - successful.length, totalNodes: merged.totalNodes, uniqueNodes: merged.uniqueNodes, protocols: protocolCounts(merged.content) },
  };
}

function persistPoolSourceStates(subscriptionId, sourceResults, timestamp = now()) {
  const assignment = db.prepare(`UPDATE subscription_source_assignments SET state = ?, last_sync_at = ?,
    last_sync_status = ?, last_sync_error = ?, updated_at = ? WHERE subscription_id = ? AND source_id = ?`);
  const sourceUpdate = db.prepare("UPDATE upstream_sources SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => sourceResults.forEach((result) => {
    const status = result.ok ? "ok" : "stale";
    const error = result.ok ? null : result.code;
    assignment.run(result.ok ? "active" : "stale", timestamp, status, error, timestamp, subscriptionId, result.sourceId);
    sourceUpdate.run(timestamp, status, error, timestamp, result.sourceId);
  }))();
}

function recordPoolSyncRun({ poolId, subscriptionId = null, status, stats = {}, error = null, startedAt }) {
  db.prepare(`INSERT INTO upstream_sync_runs
    (pool_id, subscription_id, status, healthy_sources, failed_sources, total_nodes, unique_nodes, error, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(poolId || null, subscriptionId, status, Number(stats.healthySources || 0), Number(stats.failedSources || 0), Number(stats.totalNodes || 0), Number(stats.uniqueNodes || 0), error, startedAt, now());
}

async function syncPoolSubscriptionInternal(subscription) {
  const startedAt = now();
  const pool = poolById(subscription.pool_id);
  try {
    const sources = ensureSubscriptionSourceAssignments(subscription.id, pool?.id, subscription.source_id)
      .filter((source) => source.enabled && source.pool_member_enabled !== 0);
    const result = await collectPoolSubscriptionFormats(pool, sources);
    if (subscriptionChangedSinceSyncStarted(subscription)) return currentSubscription(subscription.user_id);
    const syncError = result.warnings.length ? result.warnings.join("; ") : null;
    db.prepare(`UPDATE subscriptions SET universal_content = ?, clash_content = ?, singbox_content = ?, source_id = ?,
      last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, usage_source = ?, upstream_used_gb = ?,
      upstream_total_gb = ?, upstream_expires_at = ?, upstream_synced_at = ?, updated_at = ? WHERE id = ?`)
      .run(result.universal.content, result.clash.content, result.singbox.content, result.universal.sourceId, startedAt,
        syncError ? "partial" : "upstream", syncError,
        result.universal.usage ? "upstream-aggregate" : subscription.usage_source || "manual",
        result.universal.usage?.usedGb ?? subscription.upstream_used_gb,
        result.universal.usage?.totalGb ?? subscription.upstream_total_gb,
        result.universal.usage?.expiresAt ?? subscription.upstream_expires_at,
        result.universal.usage ? startedAt : subscription.upstream_synced_at, startedAt, subscription.id);
    persistPoolSourceStates(subscription.id, result.sourceResults, startedAt);
    recordPoolSyncRun({ poolId: pool.id, subscriptionId: subscription.id, status: syncError ? "partial" : "ok", stats: result.stats, startedAt });
  } catch (error) {
    if (subscriptionChangedSinceSyncStarted(subscription)) return currentSubscription(subscription.user_id);
    db.prepare(`UPDATE subscriptions SET last_sync_at = ?, last_sync_status = 'stale', last_sync_error = ?, updated_at = ? WHERE id = ?`)
      .run(startedAt, error.code || "POOL_SYNC_FAILED", startedAt, subscription.id);
    recordPoolSyncRun({ poolId: subscription.pool_id, subscriptionId: subscription.id, status: "stale", error: error.code || "POOL_SYNC_FAILED", startedAt });
  }
  expireSubscriptions();
  const updated = currentSubscription(subscription.user_id);
  recordUsageSnapshot(updated, startedAt);
  return updated;
}

async function syncSubscriptionInternal(subscription) {
  if (subscription.pool_id) return syncPoolSubscriptionInternal(subscription);
  const fetchedAt = now();
  try {
    const { universal, clash, singbox, warnings } = await fetchSubscriptionFormats(subscription.source_id, subscription);
    // A manual usage/source change may happen while the upstream request is in
    // flight. Never let that older response overwrite the newer admin state.
    if (subscriptionChangedSinceSyncStarted(subscription)) return currentSubscription(subscription.user_id);
    const syncWarning = warnings.length ? warnings.join("; ") : null;
    db.prepare(`UPDATE subscriptions SET universal_content = ?, clash_content = ?, singbox_content = ?,
      source_id = ?, last_sync_at = ?, last_sync_status = ?, last_sync_error = ?,
      usage_source = ?, upstream_used_gb = ?, upstream_total_gb = ?, upstream_expires_at = ?, upstream_synced_at = ?, updated_at = ? WHERE id = ?`)
      .run(universal.content, clash.content, singbox.content, universal.sourceId, fetchedAt, syncWarning ? "partial" : universal.source, syncWarning,
        universal.usage ? "upstream-aggregate" : subscription.usage_source || "manual", universal.usage?.usedGb ?? subscription.upstream_used_gb,
        universal.usage?.totalGb ?? subscription.upstream_total_gb, universal.usage?.expiresAt ?? subscription.upstream_expires_at,
        universal.usage ? fetchedAt : subscription.upstream_synced_at, fetchedAt, subscription.id);
    if (universal.sourceId) db.prepare("UPDATE upstream_sources SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, updated_at = ? WHERE id = ?").run(fetchedAt, syncWarning ? "partial" : "ok", syncWarning, fetchedAt, universal.sourceId);
  } catch (error) {
    if (subscriptionChangedSinceSyncStarted(subscription)) return currentSubscription(subscription.user_id);
    db.prepare(`UPDATE subscriptions SET last_sync_at = ?, last_sync_status = 'stale',
      last_sync_error = ?, updated_at = ? WHERE id = ?`)
      .run(fetchedAt, error.message, fetchedAt, subscription.id);
    if (subscription.source_id) db.prepare("UPDATE upstream_sources SET last_sync_at = ?, last_sync_status = 'stale', last_sync_error = ?, updated_at = ? WHERE id = ?").run(fetchedAt, error.message, fetchedAt, subscription.source_id);
  }
  expireSubscriptions();
  const updated = currentSubscription(subscription.user_id);
  recordUsageSnapshot(updated, fetchedAt);
  return updated;
}

async function syncSubscription(subscription) {
  const existing = subscriptionSyncPromises.get(subscription.id);
  if (existing) return existing;

  // Keep the promise registered until the upstream request really settles.
  // A short timer allowed slow suppliers to receive duplicate refreshes when
  // several clients requested the same subscription at once.
  const promise = syncSubscriptionInternal(subscription).finally(() => {
    // Keep a tiny post-completion cooldown so near-simultaneous fast responses
    // do not start a second three-format fetch after the first promise settles.
    const cleanup = setTimeout(() => {
      if (subscriptionSyncPromises.get(subscription.id) === promise) subscriptionSyncPromises.delete(subscription.id);
    }, subscriptionSyncCooldownMs);
    cleanup.unref?.();
  });
  subscriptionSyncPromises.set(subscription.id, promise);
  return promise;
}

function needsSync(subscription) {
  return !subscription.last_sync_at || Date.now() - Date.parse(subscription.last_sync_at) > 5 * 60 * 1000;
}

function adminAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const cached = adminSessions.get(bearer);
  const cachedValid = cached && expirationMillis(cached.expiresAt) > Date.now();
  if (cached && !cachedValid) adminSessions.delete(bearer);
  const stored = !cachedValid && bearer ? db.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?").get(sessionHash(bearer)) : null;
  const valid = Boolean(cachedValid || (stored && expirationMillis(stored.expires_at) > Date.now()));
  if (!valid) return next(apiError("ADMIN_UNAUTHORIZED", "Admin sign-in required", 401));
  if (stored) {
    db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now(), sessionHash(bearer));
    adminSessions.set(bearer, { expiresAt: stored.expires_at });
  }
  next();
}

function cleanExpiredSessions() {
  const cutoff = now();
  db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(cutoff);
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(cutoff);
  // The database cleanup above is authoritative. The in-memory caches only
  // need expiry checks here; avoiding one SELECT per cached token keeps the
  // hourly maintenance pass cheap when many customers are online.
  const timestamp = Date.now();
  for (const [token, session] of sessions) {
    if (expirationMillis(session.expiresAt) <= timestamp) sessions.delete(token);
  }
  for (const [token, session] of adminSessions) {
    if (expirationMillis(session.expiresAt) <= timestamp) adminSessions.delete(token);
  }
}

cleanExpiredSessions();
setInterval(cleanExpiredSessions, 60 * 60 * 1000).unref();

const app = express();
app.use(cors({ origin: (origin, callback) => {
  // Native clients and same-origin requests do not send an Origin header.
  if (!origin) return callback(null, true);
  if (configuredCorsOrigins.length > 0) return callback(null, configuredCorsOrigins.includes(origin) ? origin : false);
  // Keep local development/LAN testing frictionless; production must declare an allowlist.
  if (!productionRuntime) return callback(null, origin);
  return callback(null, origin === publicBaseUrl ? origin : false);
} }));
// Usage imports can contain hundreds of customer records, while payment
// webhook bodies remain small. Keep a bounded request size without rejecting
// normal batch usage updates.
app.use(express.json({ limit: "256kb", verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://cdn.tailwindcss.com 'unsafe-inline'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  if (productionRuntime) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.get("/health", (_req, res) => res.json({ ok: true, service: "cheapvpn-api" }));
app.get("/health/live", (_req, res) => res.json({ ok: true, service: "cheapvpn-api" }));
app.get("/health/ready", (_req, res) => {
  const payment = currentPaymentConfig();
  const sourceCount = db.prepare("SELECT COUNT(*) AS count FROM upstream_sources WHERE enabled = 1").get().count;
  const checks = {
    database: true,
    upstream: Boolean(sourceCount || configuredUpstreamUrl() || (allowDemoSubscription && !productionRuntime)),
    payment: payment.mode !== "mock" && (productionRuntime ? paymentIsReadyForProduction(payment) : paymentIsReady(payment)),
    encryption: productionRuntime ? encryptionKeyIsStrong() : Boolean(process.env.ADMIN_ENCRYPTION_KEY),
    adminPassword: adminPasswordIsStrong(),
    demoAccountDisabled: !allowDemoAccount,
  };
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ ok: ready, service: "cheapvpn-api", checks, mode: payment.mode });
});

const rateLimitBuckets = new Map();

function requestAddress(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 100);
}

function rateLimit({ name, max, windowMs }) {
  return (req, res, next) => {
    const key = `${name}:${requestAddress(req)}`;
    const current = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || current - bucket.startedAt >= windowMs) {
      bucket = { startedAt: current, count: 0 };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + windowMs - current) / 1000));
      res.set("Retry-After", String(retryAfter));
      return next(apiError("RATE_LIMITED", "Too many requests. Try again later.", 429));
    }
    next();
  };
}

function cleanRateLimitBuckets() {
  const current = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (current - bucket.startedAt >= 15 * 60 * 1000) rateLimitBuckets.delete(key);
  }
}

setInterval(cleanRateLimitBuckets, 5 * 60 * 1000).unref();

app.post("/api/admin/auth/login", rateLimit({ name: "admin-login", max: 10, windowMs: 15 * 60 * 1000 }), (req, res, next) => {
  try {
    if (!adminPasswordMatches(String(req.body?.password || ""))) {
      logEvent("admin.login_failed", { success: false, reason: "invalid_credentials" }, "warn");
      throw apiError("INVALID_ADMIN_CREDENTIALS", "Admin password is incorrect", 401);
    }
    logEvent("admin.login", { success: true });
    res.json({ token: createAdminSession() });
  } catch (error) { next(error); }
});

app.post("/api/admin/auth/password", adminAuth, (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!adminPasswordMatches(currentPassword)) throw apiError("INVALID_ADMIN_CREDENTIALS", "Current admin password is incorrect", 401);
    if (newPassword.length < 12 || ["123", "change-me-now"].includes(newPassword.toLowerCase())) {
      throw apiError("WEAK_ADMIN_PASSWORD", "Admin password must be at least 12 characters and not a default password");
    }
    if (newPassword === currentPassword) throw apiError("PASSWORD_UNCHANGED", "New admin password must be different");
    const timestamp = now();
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('admin_password_hash', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(bcrypt.hashSync(newPassword, 12), timestamp);
    const bearer = String(req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    const currentHash = bearer ? sessionHash(bearer) : "";
    db.prepare("DELETE FROM admin_sessions WHERE token_hash != ?").run(currentHash);
    for (const token of adminSessions.keys()) if (token !== bearer) adminSessions.delete(token);
    res.json({ ok: true, message: "Admin password changed. Other sessions were signed out." });
  } catch (error) { next(error); }
});

app.get("/api/admin/overview", adminAuth, (_req, res) => {
  expireSubscriptions();
  expirePendingOrders();
  const activeSubscriptions = db.prepare(`SELECT s.data_used_gb, s.upstream_used_gb, s.usage_source, p.data_total_gb
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'`).all();
  const totals = {
    users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    active_subscriptions: activeSubscriptions.length,
    used_gb: activeSubscriptions.reduce((sum, subscription) => sum + effectiveUsedGb(subscription), 0),
    total_gb: activeSubscriptions.reduce((sum, subscription) => sum + Number(subscription.data_total_gb || 0), 0),
  };
  const sources = db.prepare("SELECT * FROM upstream_sources ORDER BY is_default DESC, id ASC").all();
  res.json({
    metrics: { users: totals.users, activeSubscriptions: totals.active_subscriptions, usedGb: totals.used_gb, totalGb: totals.total_gb },
    upstream: { configured: sources.some((source) => Boolean(source.enabled)), count: sources.length, source: sources.some((source) => Boolean(source.enabled)) ? "configured" : "demo" },
    sources: sources.map(sourceView),
  });
});

app.get("/api/admin/system", adminAuth, (_req, res) => {
  const payment = currentPaymentConfig();
  const sourceCount = db.prepare("SELECT COUNT(*) AS count FROM upstream_sources").get().count;
  const enabledSourceCount = db.prepare("SELECT COUNT(*) AS count FROM upstream_sources WHERE enabled = 1").get().count;
  res.json({
    publicBaseUrl,
    payment: { mode: payment.mode, ready: paymentIsReady(payment), productionReady: payment.mode !== "mock" && paymentIsReady(payment), checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret), manualInstructionsConfigured: Boolean(payment.manualInstructions) },
    upstream: { configured: sourceCount > 0, total: sourceCount, enabled: enabledSourceCount, assignmentMode: currentUpstreamAssignmentMode() },
    usage: { apiConfigured: Boolean(currentUsageApiConfig().url), automaticSync: Boolean(currentUsageApiConfig().url && currentUsageSyncInterval() >= 30 * 1000), syncIntervalMs: currentUsageSyncInterval() },
    email: { configured: validSmtpUrl(currentEmailConfig().smtpUrl) && Boolean(currentEmailConfig().from) },
    security: { encryptionKeyConfigured: Boolean(process.env.ADMIN_ENCRYPTION_KEY), adminPasswordStrong: adminPasswordIsStrong() },
  });
});

app.put("/api/admin/settings/routing", adminAuth, (req, res, next) => {
  try {
    const mode = String(req.body?.assignmentMode || "").trim();
    if (!["default", "round_robin"].includes(mode)) throw apiError("INVALID_ASSIGNMENT_MODE", "Assignment mode must be default or round_robin");
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('upstream_assignment_mode', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(mode, now());
    res.json({ ok: true, assignmentMode: mode });
  } catch (error) { next(error); }
});

app.get("/api/admin/settings/usage", adminAuth, (_req, res) => {
  const config = currentUsageApiConfig();
  res.json({ apiConfigured: Boolean(config.url), url: config.url ? maskUrl(config.url) : "", tokenConfigured: Boolean(config.token), syncIntervalMs: currentUsageSyncInterval() });
});

app.put("/api/admin/settings/usage", adminAuth, (req, res, next) => {
  try {
    const current = currentUsageApiConfig();
    const hasUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "url");
    const hasToken = Object.prototype.hasOwnProperty.call(req.body || {}, "token");
    const url = hasUrl ? String(req.body.url || "").trim() : current.url;
    const token = hasToken ? String(req.body.token || "").trim() : current.token;
    const interval = req.body?.syncIntervalMs === undefined || req.body?.syncIntervalMs === "" ? null : Number(req.body.syncIntervalMs);
    if (url) {
      try { validateRemoteUrl(url, { allowPrivate: allowPrivateUpstreamUrls && !productionRuntime }); }
      catch (error) { throw apiError("INVALID_USAGE_API_URL", error.message, error.status || 400); }
    }
    if (interval !== null && (!Number.isInteger(interval) || (interval !== 0 && interval < 30 * 1000))) throw apiError("INVALID_USAGE_INTERVAL", "Sync interval must be 0 or at least 30 seconds");
    const timestamp = now();
    const save = db.transaction(() => {
      if (req.body?.clearUrl) {
        db.prepare("DELETE FROM settings WHERE key = 'usage_api_url_encrypted'").run();
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('usage_api_url_disabled', '1', ?)
          ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`).run(timestamp);
      } else if (hasUrl && url) {
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('usage_api_url_encrypted', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(url), timestamp);
        db.prepare("DELETE FROM settings WHERE key = 'usage_api_url_disabled'").run();
      }
      if (req.body?.clearToken) {
        db.prepare("DELETE FROM settings WHERE key = 'usage_api_token_encrypted'").run();
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('usage_api_token_disabled', '1', ?)
          ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`).run(timestamp);
      } else if (hasToken && token) {
        db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('usage_api_token_encrypted', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(token), timestamp);
        db.prepare("DELETE FROM settings WHERE key = 'usage_api_token_disabled'").run();
      }
      if (interval === null) db.prepare("DELETE FROM settings WHERE key = 'usage_sync_interval_ms'").run();
      else db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('usage_sync_interval_ms', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(interval), timestamp);
    });
    save();
    const configured = currentUsageApiConfig();
    scheduleProviderUsageSync();
    res.json({ ok: true, apiConfigured: Boolean(configured.url), tokenConfigured: Boolean(configured.token), syncIntervalMs: currentUsageSyncInterval() });
  } catch (error) { next(error); }
});

app.get("/api/admin/settings/email", adminAuth, (_req, res) => {
  const config = currentEmailConfig();
  res.json({ configured: validSmtpUrl(config.smtpUrl) && Boolean(config.from), smtpConfigured: Boolean(config.smtpUrl), from: config.from || "" });
});

app.put("/api/admin/settings/email", adminAuth, (req, res, next) => {
  try {
    const current = currentEmailConfig();
    const hasSmtp = Object.prototype.hasOwnProperty.call(req.body || {}, "smtpUrl");
    const hasFrom = Object.prototype.hasOwnProperty.call(req.body || {}, "from");
    const smtpUrl = hasSmtp ? String(req.body.smtpUrl || "").trim() : current.smtpUrl;
    const from = hasFrom ? String(req.body.from || "").trim().slice(0, 180) : current.from;
    if (smtpUrl && !validSmtpUrl(smtpUrl)) throw apiError("INVALID_SMTP_URL", "SMTP URL must start with smtp:// or smtps://");
    if (from && !/^.+<\S+@\S+>$|^\S+@\S+$/.test(from)) throw apiError("INVALID_EMAIL_FROM", "Sender must be an email address or Name <email@example.com>");
    const timestamp = now();
    db.transaction(() => {
      if (req.body?.clearSmtp) db.prepare("DELETE FROM settings WHERE key = 'smtp_url_encrypted'").run();
      else if (hasSmtp) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('smtp_url_encrypted', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(smtpUrl), timestamp);
      if (req.body?.clearFrom) db.prepare("DELETE FROM settings WHERE key = 'email_from_encrypted'").run();
      else if (hasFrom) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('email_from_encrypted', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(from), timestamp);
    })();
    const saved = currentEmailConfig();
    res.json({ ok: true, configured: validSmtpUrl(saved.smtpUrl) && Boolean(saved.from), smtpConfigured: Boolean(saved.smtpUrl), from: saved.from || "" });
  } catch (error) { next(error); }
});

app.get("/api/admin/settings/payment", adminAuth, (_req, res) => {
  const payment = currentPaymentConfig();
  res.json({ mode: payment.mode, checkoutTemplate: payment.checkoutTemplate, manualInstructions: payment.manualInstructions, methods: payment.methods, checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret), manualInstructionsConfigured: Boolean(payment.manualInstructions) });
});

app.get("/api/admin/metrics", adminAuth, (_req, res) => {
  expireSubscriptions();
  expirePendingOrders();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const paidRevenue = (period) => db.prepare(`SELECT COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS orders
    FROM orders WHERE status = 'paid' AND substr(COALESCE(confirmed_at, created_at), 1, ${period === "month" ? 7 : 10}) = ?`).get(period === "month" ? month : today);
  const todayTotals = paidRevenue("day");
  const monthTotals = paidRevenue("month");
  const paymentEvents = db.prepare(`SELECT
    SUM(CASE WHEN status IN ('paid', 'succeeded') THEN 1 ELSE 0 END) AS successful,
    COUNT(*) AS total FROM payment_events WHERE created_at >= ?`).get(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const expiringAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const expiringSubscriptions = db.prepare(`SELECT COUNT(*) AS count FROM subscriptions
    WHERE status = 'active' AND expires_at > ? AND expires_at <= ?`).get(new Date().toISOString(), expiringAt).count;
  const syncFailures = db.prepare(`SELECT COUNT(*) AS count FROM upstream_sources
    WHERE last_sync_status IN ('error', 'failed')`).get().count;
  const openTickets = db.prepare("SELECT COUNT(*) AS count FROM support_tickets WHERE status = 'open'").get().count;
  res.json({
    utcDate: today,
    today: { newUsers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE substr(created_at, 1, 10) = ?").get(today).count, orders: todayTotals.orders, revenue: todayTotals.revenue, revenueCents: Math.round(Number(todayTotals.revenue) * 100) },
    month: { revenue: monthTotals.revenue, revenueCents: Math.round(Number(monthTotals.revenue) * 100) },
    activeSubscriptions: db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'").get().count,
    expiringSubscriptions7d: expiringSubscriptions,
    paymentSuccessRate30d: paymentEvents.total ? Number((paymentEvents.successful / paymentEvents.total).toFixed(4)) : null,
    paymentEvents30d: { successful: paymentEvents.successful || 0, total: paymentEvents.total || 0 },
    upstreamSyncFailures: syncFailures,
    openTickets,
  });
});

app.put("/api/admin/settings/payment", adminAuth, (req, res, next) => {
  try {
    const current = currentPaymentConfig();
    const mode = String(req.body?.mode ?? current.mode).trim();
    const hasTemplate = Object.prototype.hasOwnProperty.call(req.body || {}, "checkoutTemplate");
    const hasSecret = Object.prototype.hasOwnProperty.call(req.body || {}, "webhookSecret");
    const checkoutTemplate = hasTemplate ? String(req.body.checkoutTemplate || "").trim() : current.checkoutTemplate;
    const webhookSecret = hasSecret ? String(req.body.webhookSecret || "").trim() : current.webhookSecret;
    const manualInstructions = Object.prototype.hasOwnProperty.call(req.body || {}, "manualInstructions")
      ? String(req.body.manualInstructions || "").trim().slice(0, 2000) : current.manualInstructions;
    const methodIds = Array.isArray(req.body?.methodIds)
      ? [...new Set(req.body.methodIds.map((value) => String(value)).filter((value) => paymentMethodCatalog.some((method) => method.id === value)))].slice(0, paymentMethodCatalog.length)
      : current.methods.map((method) => method.id);
    if (!["mock", "manual", "webhook"].includes(mode)) throw apiError("INVALID_PAYMENT_MODE", "Payment mode must be mock, manual or webhook");
    if (!methodIds.length) throw apiError("PAYMENT_METHOD_REQUIRED", "Select at least one payment method");
    if (checkoutTemplate && !validCheckoutTemplate(checkoutTemplate)) {
      throw apiError("INVALID_CHECKOUT_URL", "Checkout URL template must be a valid http or https URL");
    }
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('payment_mode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(mode, timestamp);
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('payment_checkout_template_encrypted', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(checkoutTemplate), timestamp);
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('payment_manual_instructions_encrypted', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(manualInstructions), timestamp);
      if (req.body?.clearWebhookSecret) db.prepare("DELETE FROM settings WHERE key = 'payment_webhook_secret_encrypted'").run();
      else if (hasSecret) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('payment_webhook_secret_encrypted', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(encrypt(webhookSecret), timestamp);
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('payment_method_ids', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(methodIds), timestamp);
    })();
    const saved = currentPaymentConfig();
    res.json({ ok: true, mode: saved.mode, methods: saved.methods, ready: paymentIsReady(saved), checkoutConfigured: Boolean(saved.checkoutTemplate), webhookConfigured: Boolean(saved.webhookSecret), manualInstructionsConfigured: Boolean(saved.manualInstructions) });
  } catch (error) { next(error); }
});

app.get("/api/admin/plans", adminAuth, (_req, res) => {
  res.json({ plans: db.prepare("SELECT * FROM plans ORDER BY active DESC, id ASC").all().map(planView) });
});

app.post("/api/admin/plans", adminAuth, (req, res, next) => {
  try {
    const plan = planInput(req.body);
    const timestamp = now();
    const result = db.prepare(`INSERT INTO plans
      (slug, name, first_month_price, renewal_price, data_total_gb, device_limit, billing_period_months, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(plan.slug, plan.name, plan.firstMonth, plan.renewal, plan.dataTotal, plan.devices, plan.periodMonths);
    res.status(201).json({ plan: planView(db.prepare("SELECT * FROM plans WHERE id = ?").get(result.lastInsertRowid)), createdAt: timestamp });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return next(apiError("PLAN_SLUG_EXISTS", "Plan slug is already in use", 409));
    next(error);
  }
});

app.post("/api/admin/auth/logout", (req, res) => {
  const bearer = String(req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (bearer) {
    adminSessions.delete(bearer);
    db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sessionHash(bearer));
  }
  res.json({ ok: true });
});

app.put("/api/admin/plans/:id", adminAuth, (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM plans WHERE id = ?").get(Number(req.params.id));
    if (!existing) throw apiError("PLAN_NOT_FOUND", "Plan was not found", 404);
    const plan = planInput(req.body, existing);
    const usage = db.prepare(`SELECT COALESCE(MAX(CASE WHEN usage_source = 'upstream-aggregate'
      THEN 0 ELSE data_used_gb END), 0) AS max_used
      FROM subscriptions WHERE plan_id = ? AND status = 'active'`).get(existing.id);
    if (plan.dataTotal < usage.max_used) {
      throw apiError("PLAN_QUOTA_BELOW_USAGE", `Data quota cannot be lower than the highest active usage (${usage.max_used} GB)`, 409);
    }
    const active = req.body?.active === undefined ? Boolean(existing.active) : Boolean(req.body.active);
    db.prepare(`UPDATE plans SET slug = ?, name = ?, first_month_price = ?, renewal_price = ?,
      data_total_gb = ?, device_limit = ?, billing_period_months = ?, active = ? WHERE id = ?`)
      .run(plan.slug, plan.name, plan.firstMonth, plan.renewal, plan.dataTotal, plan.devices, plan.periodMonths, active ? 1 : 0, existing.id);
    res.json({ plan: planView(db.prepare("SELECT * FROM plans WHERE id = ?").get(existing.id)) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return next(apiError("PLAN_SLUG_EXISTS", "Plan slug is already in use", 409));
    next(error);
  }
});

app.delete("/api/admin/plans/:id", adminAuth, (req, res, next) => {
  try {
    const existing = db.prepare("SELECT * FROM plans WHERE id = ?").get(Number(req.params.id));
    if (!existing) throw apiError("PLAN_NOT_FOUND", "Plan was not found", 404);
    const activeCount = db.prepare("SELECT COUNT(*) AS count FROM plans WHERE active = 1").get().count;
    if (existing.active && activeCount <= 1) throw apiError("LAST_ACTIVE_PLAN", "Keep at least one active plan", 409);
    db.prepare("UPDATE plans SET active = 0 WHERE id = ?").run(existing.id);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/admin/users", adminAuth, (req, res) => {
  expireSubscriptions();
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const where = q ? "WHERE lower(u.name) LIKE ? OR lower(u.email) LIKE ?" : "";
  const queryParams = q ? [`%${q}%`, `%${q}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...queryParams).count;
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.referral_code, u.created_at,
    s.status AS subscription_status, s.token, s.data_used_gb, s.usage_source, s.upstream_used_gb,
    s.upstream_total_gb, s.upstream_expires_at, s.upstream_synced_at, s.expires_at,
    s.last_sync_at, s.last_sync_status, us.name AS source_name, p.name AS plan_name, p.data_total_gb,
    p.device_limit, p.billing_period_months FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN upstream_sources us ON us.id = s.source_id
    ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).all(...queryParams, pageSize, (page - 1) * pageSize).map((user) => ({
      id: user.id, name: user.name, email: user.email, referralCode: user.referral_code,
      createdAt: user.created_at, subscriptionStatus: user.subscription_status || "inactive",
      token: user.token ? `${user.token.slice(0, 10)}****${user.token.slice(-4)}` : "-",
      usedGb: effectiveUsedGb({ data_total_gb: user.data_total_gb, data_used_gb: user.data_used_gb, upstream_used_gb: user.upstream_used_gb, usage_source: user.usage_source }), totalGb: user.data_total_gb || 0,
      remainingGb: Math.max(0, (user.data_total_gb || 0) - effectiveUsedGb({ data_total_gb: user.data_total_gb, data_used_gb: user.data_used_gb, upstream_used_gb: user.upstream_used_gb, usage_source: user.usage_source })),
      usageSource: user.usage_source || "manual", upstreamUsedGb: user.upstream_used_gb,
      upstreamTotalGb: user.upstream_total_gb, upstreamExpiresAt: user.upstream_expires_at || "-",
      upstreamSyncedAt: user.upstream_synced_at || "-",
      expiresAt: user.expires_at || "-", devices: user.device_limit || 0, periodMonths: user.billing_period_months || 1,
      lastSyncAt: user.last_sync_at || "-", lastSyncStatus: user.last_sync_status || "-",
      planName: user.plan_name || "-", sourceName: user.source_name || "自动默认货源",
    }));
  res.json({ users, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize), query: q } });
});

app.get("/api/admin/users/export.csv", adminAuth, (req, res) => {
  expireSubscriptions();
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const where = q ? "WHERE lower(u.name) LIKE ? OR lower(u.email) LIKE ?" : "";
  const queryParams = q ? [`%${q}%`, `%${q}%`] : [];
  const rows = db.prepare(`SELECT u.name, u.email, u.created_at, s.status, s.data_used_gb,
    s.upstream_used_gb, s.usage_source, p.data_total_gb, s.expires_at FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN plans p ON p.id = s.plan_id
    ${where} ORDER BY u.created_at DESC`).all(...queryParams);
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["name", "email", "subscription_status", "used_gb", "total_gb", "remaining_gb", "expires_at", "usage_source", "created_at"].map(csvCell).join(","),
    ...rows.map((row) => {
      const usedGb = effectiveUsedGb(row);
      return [row.name, row.email, row.status || "inactive", usedGb, row.data_total_gb || 0,
        Math.max(0, (row.data_total_gb || 0) - usedGb), row.expires_at || "", row.usage_source || "manual", row.created_at].map(csvCell).join(",");
    }),
  ];
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="cheapvpn-users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\ufeff${lines.join("\r\n")}\r\n`);
});

app.patch("/api/admin/users/:id/usage", adminAuth, (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const subscription = db.prepare(`SELECT s.id, p.data_total_gb
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.status = 'active'`).get(userId);
    if (!subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "User has no subscription", 404);
    const usedGb = Number(req.body?.usedGb);
    if (!Number.isFinite(usedGb) || usedGb < 0 || usedGb > subscription.data_total_gb) {
      throw apiError("INVALID_USAGE", `Used data must be between 0 and ${subscription.data_total_gb} GB`);
    }
    db.prepare("UPDATE subscriptions SET data_used_gb = ?, usage_source = 'manual', updated_at = ? WHERE id = ?")
      .run(usedGb, now(), subscription.id);
    subscriptionSyncPromises.delete(subscription.id);
    recordUsageSnapshot({ ...subscription, user_id: userId, data_used_gb: usedGb, usage_source: "manual" });
    res.json({ ok: true, usedGb, totalGb: subscription.data_total_gb });
  } catch (error) { next(error); }
});

app.get("/api/admin/users/:id/usage/history", adminAuth, (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
    if (!user) throw apiError("USER_NOT_FOUND", "User was not found", 404);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const history = db.prepare(`SELECT used_gb, total_gb, source, captured_at
      FROM usage_snapshots WHERE user_id = ? ORDER BY captured_at DESC LIMIT ?`).all(userId, limit).map((snapshot) => ({
        usedGb: snapshot.used_gb, totalGb: snapshot.total_gb, source: snapshot.source, capturedAt: snapshot.captured_at,
      }));
    res.json({ user: { id: user.id, name: user.name, email: user.email }, history });
  } catch (error) { next(error); }
});

app.post("/api/admin/usage/import", adminAuth, (req, res, next) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records.slice(0, 500) : [];
    if (!records.length) throw apiError("EMPTY_USAGE_IMPORT", "Provide a non-empty records array");
    res.json({ ok: true, ...applyUsageRecords(records, "provider-import") });
  } catch (error) { next(error); }
});

function applyUsageRecords(records, source = "provider-import") {
    const updated = [];
    const rejected = [];
    const apply = db.transaction(() => records.forEach((record, index) => {
      const user = record?.userId
        ? db.prepare("SELECT id, email FROM users WHERE id = ?").get(Number(record.userId))
        : db.prepare("SELECT id, email FROM users WHERE email = ?").get(String(record?.email || record?.userEmail || "").trim().toLowerCase());
      const usedGb = Number(record?.usedGb ?? record?.used_gb ?? record?.used);
      if (!user || !Number.isFinite(usedGb) || usedGb < 0) {
        rejected.push({ index, reason: !user ? "USER_NOT_FOUND" : "INVALID_USED_GB" });
        return;
      }
      const subscription = db.prepare(`SELECT s.id, p.data_total_gb FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? AND s.status = 'active'`).get(user.id);
      if (!subscription || usedGb > subscription.data_total_gb) {
        rejected.push({ index, reason: !subscription ? "SUBSCRIPTION_NOT_FOUND" : "USED_GB_EXCEEDS_PLAN" });
        return;
      }
      const totalValue = record?.totalGb ?? record?.total_gb ?? record?.upstreamTotalGb;
      const upstreamTotalGb = totalValue === undefined || totalValue === null || totalValue === "" ? null : Number(totalValue);
      if (upstreamTotalGb !== null && (!Number.isFinite(upstreamTotalGb) || upstreamTotalGb < 0)) {
        rejected.push({ index, reason: "INVALID_TOTAL_GB" });
        return;
      }
      const expiryValue = record?.expiresAt ?? record?.expires_at ?? record?.upstreamExpiresAt ?? record?.expireAt;
      const upstreamExpiresAt = normalizeUsageExpiry(expiryValue);
      if (expiryValue !== undefined && expiryValue !== null && expiryValue !== "" && !upstreamExpiresAt) {
        rejected.push({ index, reason: "INVALID_EXPIRES_AT" });
        return;
      }
      const capturedAt = now();
      db.prepare(`UPDATE subscriptions SET data_used_gb = ?, usage_source = ?,
        upstream_used_gb = ?, upstream_total_gb = COALESCE(?, upstream_total_gb),
        upstream_expires_at = COALESCE(?, upstream_expires_at), upstream_synced_at = ?, updated_at = ? WHERE id = ?`)
        .run(usedGb, source, usedGb, upstreamTotalGb, upstreamExpiresAt, capturedAt, capturedAt, subscription.id);
      subscriptionSyncPromises.delete(subscription.id);
      recordUsageSnapshotValues(subscription.id, user.id, usedGb, subscription.data_total_gb, source, capturedAt);
      updated.push({ userId: user.id, email: user.email, usedGb, totalGb: subscription.data_total_gb, upstreamTotalGb, upstreamExpiresAt });
    }));
    apply();
    expireSubscriptions();
    return { updated, rejected };
}

async function fetchProviderUsageRecords() {
  const usageConfig = currentUsageApiConfig();
  if (!usageConfig.url) throw apiError("USAGE_API_NOT_CONFIGURED", "Usage API is not configured", 503);
  try {
    const result = await subscriptionProvider.getUsage(usageConfig.url, { token: usageConfig.token });
    const response = result.response;
    if (!response.ok) throw apiError("USAGE_API_FAILED", `Usage API responded with ${response.status}`, 502);
    const payload = result.payload;
    const records = Array.isArray(payload) ? payload : payload?.records;
    if (!Array.isArray(records) || !records.length) throw apiError("EMPTY_USAGE_API_RESPONSE", "Usage API returned no records", 502);
    return records.slice(0, 500);
  } catch (error) {
    logEvent("upstream.usage_fetch", { code: error.code || "USAGE_API_FAILED", success: false }, "warn");
    throw error;
  }
}

app.post("/api/admin/usage/sync", adminAuth, async (_req, res, next) => {
  try {
    const records = await fetchProviderUsageRecords();
    res.json({ ok: true, source: "provider-api", ...applyUsageRecords(records, "provider-api") });
  } catch (error) { next(error); }
});

let providerUsageSyncInFlight = false;
let providerUsageSyncTimer = null;
async function syncProviderUsageInBackground() {
  if (!currentUsageApiConfig().url || providerUsageSyncInFlight) return;
  providerUsageSyncInFlight = true;
  try {
    const records = await fetchProviderUsageRecords();
    const result = applyUsageRecords(records, "provider-api");
    logEvent("upstream.usage_sync", { count: result.updated.length, success: true });
  } catch (error) {
    logEvent("upstream.usage_sync", { code: error.code || "USAGE_SYNC_FAILED", success: false }, "warn");
  } finally {
    providerUsageSyncInFlight = false;
  }
}

function scheduleProviderUsageSync() {
  if (providerUsageSyncTimer) clearInterval(providerUsageSyncTimer);
  providerUsageSyncTimer = null;
  const interval = currentUsageSyncInterval();
  if (currentUsageApiConfig().url && interval >= 30 * 1000) {
    providerUsageSyncTimer = setInterval(syncProviderUsageInBackground, interval);
    providerUsageSyncTimer.unref();
  }
}

let resourcePoolSyncInFlight = false;
let resourcePoolSyncTimer = null;
async function syncResourcePoolsInBackground() {
  if (resourcePoolSyncInFlight || syncLocks.has("all")) return;
  resourcePoolSyncInFlight = true;
  try {
    const pools = db.prepare("SELECT * FROM upstream_pools WHERE enabled = 1").all();
    let synchronized = 0;
    for (const pool of pools) {
      const subscriptions = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND pool_id = ?").all(pool.id);
      const results = await mapWithConcurrency(subscriptions, upstreamSyncConcurrency, async (subscription) => syncSubscription(subscription));
      synchronized += results.length;
    }
    if (pools.length) logEvent("upstream.pool_sync", { pools: pools.length, subscriptions: synchronized, success: true });
  } catch (error) {
    logEvent("upstream.pool_sync", { code: error.code || "POOL_SYNC_FAILED", success: false }, "warn");
  } finally {
    resourcePoolSyncInFlight = false;
  }
}

function scheduleResourcePoolSync() {
  if (resourcePoolSyncTimer) clearInterval(resourcePoolSyncTimer);
  resourcePoolSyncTimer = setInterval(syncResourcePoolsInBackground, 5 * 60 * 1000);
  resourcePoolSyncTimer.unref();
}

app.patch("/api/admin/users/:id/subscription", adminAuth, (req, res, next) => {
  try {
    expireSubscriptions();
    const userId = Number(req.params.id);
    const subscription = db.prepare(`SELECT s.id, s.status, s.expires_at, p.billing_period_months
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?`).get(userId);
    if (!subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "User has no subscription", 404);
    const action = String(req.body?.action || "").toLowerCase();
    if (action === "expire") {
      db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now(), subscription.id);
    } else if (action === "reset") {
      if (subscription.status !== "active") throw apiError("SUBSCRIPTION_NOT_ACTIVE", "Only an active subscription can reset its token", 409);
      db.prepare("UPDATE subscriptions SET token = ?, updated_at = ? WHERE id = ?")
        .run(subscriptionToken(), now(), subscription.id);
    } else if (action === "extend") {
      const requestedMonths = req.body?.months === undefined ? subscription.billing_period_months : Number(req.body.months);
      const months = Math.min(24, Math.max(1, Number(requestedMonths) || 1));
      const base = new Date(Math.max(Date.now(), expirationMillis(subscription.expires_at)));
      const extended = addBillingPeriods(base, months);
      // An administrator extension starts a fresh cycle. This also revives
      // quota- or upstream-expired accounts instead of immediately expiring
      // them again because of stale usage fields.
      db.prepare(`UPDATE subscriptions SET status = 'active', expires_at = ?,
        data_used_gb = 0, usage_source = 'manual', upstream_used_gb = NULL,
        upstream_total_gb = NULL, upstream_expires_at = NULL, upstream_synced_at = NULL,
        last_sync_at = NULL, last_sync_status = 'pending', last_sync_error = NULL,
        updated_at = ? WHERE id = ?`)
        .run(extended.toISOString(), now(), subscription.id);
      subscriptionSyncPromises.delete(subscription.id);
    } else {
      throw apiError("INVALID_SUBSCRIPTION_ACTION", "Action must be extend or expire");
    }
    const updated = currentSubscription(userId);
    recordUsageSnapshot(updated);
    res.json({ subscription: subscriptionView(updated, currentPlan(updated)) });
  } catch (error) { next(error); }
});

app.get("/api/admin/orders", adminAuth, (req, res) => {
  expirePendingOrders();
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const requestedStatus = String(req.query.status || "").trim().toLowerCase();
  const status = ["pending", "processing", "paid", "failed", "cancelled", "expired"].includes(requestedStatus) ? requestedStatus : "";
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  const clauses = [];
  const params = [];
  if (q) { clauses.push("(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(o.id) LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { clauses.push("o.status = ?"); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS count FROM orders o JOIN users u ON u.id = o.user_id ${where}`).get(...params).count;
  const orders = db.prepare(`SELECT o.id, o.amount, o.status, o.kind, o.discount_percent, o.expires_at, o.created_at, o.confirmed_at,
    u.email, u.name, p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at FROM orders o
    JOIN users u ON u.id = o.user_id JOIN plans p ON p.id = o.plan_id
    LEFT JOIN payment_submissions ps ON ps.order_id = o.id
    ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map((order) => ({
      id: order.id, amount: order.amount, status: order.status, kind: order.kind, discountPercent: order.discount_percent, expiresAt: order.expires_at,
      user: { name: order.name, email: order.email }, planName: order.plan_name,
      createdAt: order.created_at, confirmedAt: order.confirmed_at,
      paymentSubmission: order.submitted_at ? { method: order.payment_method, reference: order.payment_reference, note: order.customer_note || "", submittedAt: order.submitted_at } : null,
    }));
  res.json({ orders, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize), query: q, status } });
});

app.get("/api/admin/tickets", adminAuth, (_req, res) => {
  const tickets = db.prepare(`SELECT t.*, u.name AS user_name, u.email FROM support_tickets t
    JOIN users u ON u.id = t.user_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 300`)
    .all().map(ticketView);
  res.json({ tickets });
});

app.patch("/api/admin/tickets/:id", adminAuth, (req, res, next) => {
  try {
    const status = String(req.body?.status || "").toLowerCase();
    if (!["open", "in_progress", "resolved", "closed"].includes(status)) throw apiError("INVALID_TICKET_STATUS", "Status must be open, in_progress, resolved or closed");
    const timestamp = now();
    const result = db.prepare(`UPDATE support_tickets SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?`)
      .run(status, timestamp, ["resolved", "closed"].includes(status) ? timestamp : null, req.params.id);
    if (result.changes !== 1) throw apiError("TICKET_NOT_FOUND", "Ticket was not found", 404);
    res.json({ ticket: ticketView(db.prepare(`SELECT t.*, u.name AS user_name, u.email FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(req.params.id)) });
  } catch (error) { next(error); }
});

app.post("/api/admin/orders/:id/confirm", adminAuth, async (req, res, next) => {
  let claimedOrderId = null;
  try {
    expirePendingOrders();
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    if (order.status === "paid") return res.json({ ok: true, alreadyPaid: true, orderId: order.id });
    if (order.status !== "pending") throw apiError("ORDER_NOT_CONFIRMABLE", "Only pending orders can be confirmed", 409);
    const claim = db.prepare("UPDATE orders SET status = 'processing' WHERE id = ? AND status = 'pending'").run(order.id);
    if (claim.changes !== 1) throw apiError("ORDER_PROCESSING", "Order confirmation is already in progress", 409);
    claimedOrderId = order.id;
    const result = await completeOrder(order, requestOrigin(req));
    res.json({ ok: true, ...result });
  } catch (error) {
    if (claimedOrderId) db.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'").run(claimedOrderId);
    next(error);
  }
});

app.post("/api/admin/orders/:id/cancel", adminAuth, (req, res, next) => {
  try {
    const result = db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(req.params.id);
    if (result.changes !== 1) throw apiError("ORDER_NOT_CANCELLABLE", "Only pending orders can be cancelled", 409);
    res.json({ ok: true, orderId: req.params.id, status: "cancelled" });
  } catch (error) { next(error); }
});

app.get("/api/admin/upstream", adminAuth, (_req, res) => {
  const sources = db.prepare("SELECT * FROM upstream_sources ORDER BY is_default DESC, id ASC").all();
  const enabled = sources.some((source) => Boolean(source.enabled));
  const pools = db.prepare("SELECT * FROM upstream_pools ORDER BY is_default DESC, id ASC").all();
  res.json({ sources: sources.map(sourceView), pools: pools.map(poolView), configured: enabled, source: enabled ? "configured" : "demo" });
});

function validPoolSourceIds(sourceIds) {
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).map(Number).filter(Number.isInteger).filter((id) => id > 0))];
  if (!ids.length) throw apiError("POOL_EMPTY", "Select at least one upstream source for the resource pool");
  const found = db.prepare(`SELECT id FROM upstream_sources WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((source) => source.id);
  if (found.length !== ids.length) throw apiError("SOURCE_NOT_FOUND", "One or more upstream sources were not found", 404);
  return ids;
}

function replacePoolMembers(poolId, sourceIds) {
  const timestamp = now();
  const remove = db.prepare("DELETE FROM upstream_pool_members WHERE pool_id = ?");
  const insert = db.prepare(`INSERT INTO upstream_pool_members (pool_id, source_id, enabled, priority, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)`);
  db.transaction(() => {
    remove.run(poolId);
    sourceIds.forEach((sourceId, index) => insert.run(poolId, sourceId, index, timestamp, timestamp));
  })();
}

app.get("/api/admin/pools", adminAuth, (_req, res) => {
  const pools = db.prepare("SELECT * FROM upstream_pools ORDER BY is_default DESC, id ASC").all();
  res.json({ pools: pools.map(poolView) });
});

app.post("/api/admin/pools", adminAuth, (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 80);
    const sourceIds = validPoolSourceIds(req.body?.sourceIds);
    const isDefault = req.body?.isDefault === undefined ? !defaultPool() : Boolean(req.body.isDefault);
    if (!name) throw apiError("INVALID_POOL_NAME", "Resource pool name is required");
    const timestamp = now();
    if (isDefault) db.prepare("UPDATE upstream_pools SET is_default = 0 WHERE is_default = 1").run();
    const result = db.prepare(`INSERT INTO upstream_pools (name, enabled, is_default, delivery_mode, created_at, updated_at)
      VALUES (?, 1, ?, 'merge_all', ?, ?)`).run(name, isDefault ? 1 : 0, timestamp, timestamp);
    replacePoolMembers(result.lastInsertRowid, sourceIds);
    res.status(201).json({ pool: poolView(poolById(result.lastInsertRowid)) });
  } catch (error) { next(error); }
});

app.put("/api/admin/pools/:id", adminAuth, (req, res, next) => {
  try {
    const pool = poolById(Number(req.params.id));
    if (!pool) throw apiError("POOL_NOT_FOUND", "Resource pool was not found", 404);
    const name = String(req.body?.name ?? pool.name).trim().slice(0, 80);
    const enabled = req.body?.enabled === undefined ? Boolean(pool.enabled) : Boolean(req.body.enabled);
    const isDefault = req.body?.isDefault === undefined ? Boolean(pool.is_default) : Boolean(req.body.isDefault);
    const sourceIds = Object.prototype.hasOwnProperty.call(req.body || {}, "sourceIds") ? validPoolSourceIds(req.body.sourceIds) : poolMembers(pool.id).map((source) => source.id);
    if (!name) throw apiError("INVALID_POOL_NAME", "Resource pool name is required");
    if (isDefault && !enabled) throw apiError("DEFAULT_POOL_DISABLED", "The default resource pool must be enabled", 409);
    if (isDefault) db.prepare("UPDATE upstream_pools SET is_default = 0 WHERE id != ?").run(pool.id);
    db.prepare("UPDATE upstream_pools SET name = ?, enabled = ?, is_default = ?, updated_at = ? WHERE id = ?")
      .run(name, enabled ? 1 : 0, isDefault ? 1 : 0, now(), pool.id);
    if (!enabled) db.prepare("UPDATE upstream_pools SET is_default = 0 WHERE id = ?").run(pool.id);
    replacePoolMembers(pool.id, sourceIds);
    res.json({ pool: poolView(poolById(pool.id)) });
  } catch (error) { next(error); }
});

app.post("/api/admin/pools/:id/preview", adminAuth, async (req, res, next) => {
  try {
    const pool = poolById(Number(req.params.id));
    if (!pool) throw apiError("POOL_NOT_FOUND", "Resource pool was not found", 404);
    const result = await collectPoolSubscriptionFormats(pool);
    res.json({ pool: poolView(pool), summary: result.stats, sources: result.sourceResults.map((source) => ({
      id: source.sourceId, name: source.sourceName, status: source.ok ? "healthy" : "failed", code: source.ok ? undefined : source.code,
    })) });
  } catch (error) { next(error); }
});

app.post("/api/admin/pools/:id/sync", adminAuth, async (req, res, next) => {
  const poolId = Number(req.params.id);
  const lockKey = `pool:${poolId}`;
  if (syncLocks.has(lockKey) || syncLocks.has("all")) return next(apiError("SYNC_IN_PROGRESS", "A synchronization is already in progress", 409));
  syncLocks.add(lockKey);
  try {
    const pool = poolById(poolId);
    if (!pool) throw apiError("POOL_NOT_FOUND", "Resource pool was not found", 404);
    const subscriptions = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND pool_id = ?").all(pool.id);
    const results = await mapWithConcurrency(subscriptions, upstreamSyncConcurrency, async (subscription) => syncSubscription(subscription));
    res.json({ pool: poolView(pool), total: subscriptions.length,
      success: results.filter((item) => item.last_sync_status === "upstream").length,
      partial: results.filter((item) => item.last_sync_status === "partial").length,
      stale: results.filter((item) => item.last_sync_status === "stale").length, syncedAt: now() });
  } catch (error) { next(error); } finally { syncLocks.delete(lockKey); }
});

app.post("/api/admin/sources", adminAuth, (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 80);
    const url = String(req.body?.url || req.body?.universalUrl || "").trim();
    const clashUrl = String(req.body?.clashUrl || "").trim();
    const singboxUrl = String(req.body?.singboxUrl || "").trim();
    if (!name) throw apiError("INVALID_SOURCE_NAME", "Source name is required");
    if (!url) throw apiError("INVALID_UPSTREAM_URL", "Upstream URL is required");
    validateUpstreamUrl(url);
    if (clashUrl) validateUpstreamUrl(clashUrl);
    if (singboxUrl) validateUpstreamUrl(singboxUrl);
    const hasDefault = db.prepare("SELECT id FROM upstream_sources WHERE is_default = 1 AND enabled = 1 LIMIT 1").get();
    const timestamp = now();
    const result = db.prepare(`INSERT INTO upstream_sources
      (name, url_encrypted, universal_url_encrypted, clash_url_encrypted, singbox_url_encrypted, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(name, encrypt(url), encrypt(url), clashUrl ? encrypt(clashUrl) : null, singboxUrl ? encrypt(singboxUrl) : null, hasDefault ? 0 : 1, timestamp, timestamp);
    ensureEnabledDefaultSource();
    ensureDefaultResourcePool();
    res.status(201).json({ source: sourceView(db.prepare("SELECT * FROM upstream_sources WHERE id = ?").get(result.lastInsertRowid)) });
  } catch (error) { next(error); }
});

app.put("/api/admin/sources/:id", adminAuth, (req, res, next) => {
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const name = String(req.body?.name ?? source.name).trim().slice(0, 80);
    const url = String(req.body?.url || req.body?.universalUrl || "").trim();
    const hasClashUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "clashUrl");
    const hasSingboxUrl = Object.prototype.hasOwnProperty.call(req.body || {}, "singboxUrl");
    const clashUrl = hasClashUrl ? String(req.body.clashUrl || "").trim() : "";
    const singboxUrl = hasSingboxUrl ? String(req.body.singboxUrl || "").trim() : "";
    const enabled = req.body?.enabled === undefined ? Boolean(source.enabled) : Boolean(req.body.enabled);
    const hasDefaultFlag = Object.prototype.hasOwnProperty.call(req.body || {}, "isDefault");
    const makeDefault = hasDefaultFlag ? Boolean(req.body.isDefault) : Boolean(source.is_default && enabled);
    if (!name) throw apiError("INVALID_SOURCE_NAME", "Source name is required");
    if (url) validateUpstreamUrl(url);
    if (clashUrl) validateUpstreamUrl(clashUrl);
    if (singboxUrl) validateUpstreamUrl(singboxUrl);
    if (makeDefault && !enabled) throw apiError("DEFAULT_SOURCE_DISABLED", "The default source must be enabled", 409);
    const timestamp = now();
    if (makeDefault) db.prepare("UPDATE upstream_sources SET is_default = 0 WHERE id != ?").run(source.id);
    const universal = url || sourceUrl(source, "universal");
    const clash = hasClashUrl ? (clashUrl ? encrypt(clashUrl) : null) : source.clash_url_encrypted;
    const singbox = hasSingboxUrl ? (singboxUrl ? encrypt(singboxUrl) : null) : source.singbox_url_encrypted;
    db.prepare(`UPDATE upstream_sources SET name = ?, url_encrypted = ?, universal_url_encrypted = ?,
      clash_url_encrypted = ?, singbox_url_encrypted = ?, enabled = ?, is_default = ?, updated_at = ? WHERE id = ?`)
      .run(name, encrypt(universal), encrypt(universal), clash, singbox, enabled ? 1 : 0, makeDefault ? 1 : 0, timestamp, source.id);
    ensureEnabledDefaultSource();
    invalidateSourceSubscriptions(source.id);
    res.json({ source: sourceView(sourceById(source.id)) });
  } catch (error) { next(error); }
});

app.put("/api/admin/sources/:id/node-rules", adminAuth, (req, res, next) => {
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
    const normalized = rules.map((rule) => ({
      match: String(rule?.match || "").trim().slice(0, 120),
      name: String(rule?.name || "").trim().slice(0, 120),
    })).filter((rule) => rule.match && rule.name).slice(0, 200);
    db.prepare("UPDATE upstream_sources SET node_rules_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(normalized), now(), source.id);
    invalidateSourceSubscriptions(source.id);
    res.json({ source: sourceView(sourceById(source.id)) });
  } catch (error) { next(error); }
});

app.post("/api/admin/sources/:id/node-discovery", adminAuth, async (req, res, next) => {
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const cacheKey = `${source.id}:${source.updated_at}`;
    const cached = nodeDiscoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
      return res.json({ ...cached.result, cached: true });
    }
    let subscription = db.prepare("SELECT universal_content FROM subscriptions WHERE status = 'active' AND source_id = ? AND universal_content IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(source.id);
    const content = subscription?.universal_content || (await fetchUpstream(source.id, "universal")).content;
    const nodes = parseUniversalNodes(content);
    const countryCache = new Map();
    // Names supplied by the provider are usually the strongest signal. Avoid
    // unnecessary geo lookups for those nodes and reserve IP geo for unknown names.
    const uniqueHosts = [...new Set(nodes.filter((node) => !countryHintFromName(node.rawName)).map((node) => node.host))];
    const geoResults = await mapWithConcurrency(uniqueHosts, nodeTestConcurrency, async (host) => [host, await geoLookup(host)]);
    geoResults.forEach(([host, geo]) => countryCache.set(host, geo));
    const inspected = await mapWithConcurrency(nodes, nodeTestConcurrency, async (node) => {
      const [probe, geo] = await Promise.all([probeTcp(node.host, node.port), Promise.resolve(countryCache.get(node.host) || { country: "", countryCode: "" })]);
      const hint = countryHintFromName(node.rawName);
      const location = hint || { ...geo, confidence: geo.country ? "ip-geo" : "unknown" };
      return { ...node, ...probe, country: location.country, countryCode: location.countryCode, flag: flagForCountryCode(location.countryCode), confidence: location.confidence };
    });
    const counts = new Map();
    const rules = inspected.map((node) => {
      const key = node.countryCode || "XX";
      const number = (counts.get(key) || 0) + 1;
      counts.set(key, number);
      const country = node.country || "待确认地区";
      const suffix = node.confidence === "ip-geo" ? " · IP归属地" : "";
      return { match: node.rawName, name: `${node.flag} ${country} ${String(number).padStart(2, "0")}${suffix}` };
    });
    const result = { warning: "检测结果是节点 IP 归属地，不代表真实 VPN 出口国家。", nodes: inspected, rules };
    nodeDiscoveryCache.set(cacheKey, { createdAt: Date.now(), result });
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of nodeDiscoveryCache) {
      if (value.createdAt < cutoff) nodeDiscoveryCache.delete(key);
    }
    res.json({ ...result, cached: false });
  } catch (error) { next(error); }
});

app.delete("/api/admin/sources/:id", adminAuth, (req, res, next) => {
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const boundUsers = db.prepare(`SELECT COUNT(DISTINCT s.id) AS count FROM subscriptions s
      LEFT JOIN subscription_source_assignments a ON a.subscription_id = s.id
      WHERE s.status = 'active' AND (s.source_id = ? OR a.source_id = ?)`).get(source.id, source.id).count;
    if (boundUsers > 0) throw apiError("SOURCE_IN_USE", `This source is bound to ${boundUsers} active subscription(s); reassign them before deleting`, 409);
    db.prepare("DELETE FROM upstream_sources WHERE id = ?").run(source.id);
    ensureEnabledDefaultSource();
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put("/api/admin/users/:id/source", adminAuth, (req, res, next) => {
  try {
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(Number(req.params.id));
    const existing = db.prepare("SELECT id, source_id, status FROM subscriptions WHERE user_id = ?").get(Number(req.params.id));
    const sourceId = Number(req.body?.sourceId) || null;
    if (!user) throw apiError("USER_NOT_FOUND", "User was not found", 404);
    if (!existing) throw apiError("SUBSCRIPTION_NOT_FOUND", "User has no subscription", 404);
    if (existing.status !== "active") throw apiError("SUBSCRIPTION_NOT_ACTIVE", "Only an active subscription can be assigned a source", 409);
    if (sourceId) {
      const source = sourceById(sourceId);
      if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
      if (!source.enabled) throw apiError("SOURCE_DISABLED", "Cannot bind a disabled source", 409);
    }
    const timestamp = now();
    db.transaction(() => {
      db.prepare("DELETE FROM subscription_source_assignments WHERE subscription_id = ?").run(existing.id);
      db.prepare("UPDATE subscriptions SET source_id = ?, pool_id = NULL, last_sync_at = NULL, last_sync_status = 'pending', last_sync_error = NULL, updated_at = ? WHERE id = ?")
        .run(sourceId, timestamp, existing.id);
      if (sourceId) db.prepare(`INSERT INTO subscription_source_assignments (subscription_id, source_id, state, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`).run(existing.id, sourceId, timestamp, timestamp);
    })();
    subscriptionSyncPromises.delete(existing.id);
    res.json({ ok: true, sourceId });
  } catch (error) { next(error); }
});

app.get("/api/admin/users/:id/pool", adminAuth, (req, res, next) => {
  try {
    const subscription = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(Number(req.params.id));
    if (!subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "User has no subscription", 404);
    const sources = assignedPoolSources(subscription).map((source) => ({
      id: source.id, name: source.name, state: source.assignment_state || "pending",
      lastSyncAt: source.assignment_last_sync_at || null, lastSyncStatus: source.assignment_last_sync_status || null,
      lastSyncError: source.assignment_last_sync_error || null,
    }));
    res.json({ assignment: { subscriptionId: subscription.id, pool: subscription.pool_id ? poolView(poolById(subscription.pool_id)) : null, sources } });
  } catch (error) { next(error); }
});

app.put("/api/admin/users/:id/pool", adminAuth, (req, res, next) => {
  try {
    const subscription = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(Number(req.params.id));
    const pool = poolById(Number(req.body?.poolId));
    if (!subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "User has no subscription", 404);
    if (subscription.status !== "active") throw apiError("SUBSCRIPTION_NOT_ACTIVE", "Only an active subscription can be assigned a resource pool", 409);
    if (!pool) throw apiError("POOL_NOT_FOUND", "Resource pool was not found", 404);
    if (!pool.enabled) throw apiError("POOL_DISABLED", "Cannot assign a disabled resource pool", 409);
    const sources = poolMembers(pool.id, { onlyHealthyCandidates: true });
    if (!sources.length) throw apiError("POOL_EMPTY", "The resource pool has no enabled sources", 409);
    const timestamp = now();
    db.transaction(() => {
      db.prepare("DELETE FROM subscription_source_assignments WHERE subscription_id = ?").run(subscription.id);
      db.prepare("UPDATE subscriptions SET pool_id = ?, source_id = ?, last_sync_at = NULL, last_sync_status = 'pending', last_sync_error = NULL, updated_at = ? WHERE id = ?")
        .run(pool.id, sources[0].id, timestamp, subscription.id);
      const insert = db.prepare(`INSERT INTO subscription_source_assignments (subscription_id, source_id, state, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`);
      sources.forEach((source) => insert.run(subscription.id, source.id, timestamp, timestamp));
    })();
    subscriptionSyncPromises.delete(subscription.id);
    res.json({ ok: true, assignment: { subscriptionId: subscription.id, pool: poolView(pool), sources: sources.map((source) => ({ id: source.id, name: source.name, state: "pending" })) } });
  } catch (error) { next(error); }
});

app.post("/api/admin/sources/:id/sync", adminAuth, async (req, res, next) => {
  const lockKey = `source:${Number(req.params.id)}`;
  if (syncLocks.has(lockKey) || syncLocks.has("all")) return next(apiError("SYNC_IN_PROGRESS", "A synchronization is already in progress", 409));
  syncLocks.add(lockKey);
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const subscriptions = db.prepare(`SELECT DISTINCT s.* FROM subscriptions s
      LEFT JOIN subscription_source_assignments a ON a.subscription_id = s.id
      WHERE s.status = 'active' AND (s.source_id = ? OR a.source_id = ?)`).all(source.id, source.id);
    const results = await mapWithConcurrency(subscriptions, upstreamSyncConcurrency, async (subscription) => {
      try {
        const synced = await syncSubscription(subscription);
        return { status: synced.last_sync_status === "stale" ? "stale" : "success" };
      } catch (error) { return { status: "error", error: error.message }; }
    });
    res.json({ source: source.name, total: subscriptions.length,
      success: results.filter((result) => result.status === "success").length,
      stale: results.filter((result) => result.status === "stale").length,
      errors: results.filter((result) => result.status === "error").length,
      syncedAt: now() });
  } catch (error) { next(error); } finally { syncLocks.delete(lockKey); }
});

app.post("/api/admin/sources/:id/test", adminAuth, async (req, res, next) => {
  try {
    const source = sourceById(Number(req.params.id));
    if (!source) throw apiError("SOURCE_NOT_FOUND", "Source was not found", 404);
    const formats = await Promise.all(["universal", "clash", "singbox"].map(async (format) => {
      try {
        const result = await fetchUpstream(source.id, format);
        return {
          format,
          ok: true,
          source: result.source,
          nodes: format === "universal" ? parseUniversalNodes(result.content).length : null,
          usage: format === "universal" ? result.usage || null : undefined,
        };
      } catch (error) {
        return { format, ok: false, error: error.message };
      }
    }));
     const passed = formats.filter((format) => format.ok).length;
     const universal = formats.find((format) => format.format === "universal");
     res.json({ source: source.name, ok: Boolean(universal?.ok), passed, total: formats.length, formats });
  } catch (error) { next(error); }
});

app.put("/api/admin/upstream", adminAuth, (req, res, next) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (url) {
      validateUpstreamUrl(url);
      const existing = db.prepare("SELECT * FROM upstream_sources WHERE is_default = 1 ORDER BY id LIMIT 1").get()
        || db.prepare("SELECT * FROM upstream_sources ORDER BY id LIMIT 1").get();
      const timestamp = now();
      db.transaction(() => {
        if (existing) {
          db.prepare(`UPDATE upstream_sources SET url_encrypted = ?, universal_url_encrypted = ?, enabled = 1,
            is_default = 1, updated_at = ? WHERE id = ?`)
            .run(encrypt(url), encrypt(url), timestamp, existing.id);
          db.prepare("UPDATE upstream_sources SET is_default = 0 WHERE id != ?").run(existing.id);
          invalidateSourceSubscriptions(existing.id);
        } else {
          db.prepare(`INSERT INTO upstream_sources
            (name, url_encrypted, universal_url_encrypted, enabled, is_default, created_at, updated_at)
            VALUES ('默认货源', ?, ?, 1, 1, ?, ?)`)
            .run(encrypt(url), encrypt(url), timestamp, timestamp);
        }
      })();
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/admin/sync", adminAuth, async (_req, res) => {
  const lockKey = "all";
  if (syncLocks.size > 0) throw apiError("SYNC_IN_PROGRESS", "A synchronization is already in progress", 409);
  syncLocks.add(lockKey);
  try {
  const subscriptions = db.prepare("SELECT * FROM subscriptions WHERE status = 'active'").all();
  const results = await mapWithConcurrency(subscriptions, upstreamSyncConcurrency, async (subscription) => {
    try {
      const synced = await syncSubscription(subscription);
      return synced.last_sync_status === "stale" ? "stale" : "success";
    } catch { return "error"; }
  });
  res.json({ total: subscriptions.length,
    success: results.filter((result) => result === "success").length,
    stale: results.filter((result) => result === "stale").length,
    errors: results.filter((result) => result === "error").length,
    syncedAt: now() });
  } finally { syncLocks.delete(lockKey); }
});

app.post("/api/auth/register", rateLimit({ name: "register", max: 5, windowMs: 15 * 60 * 1000 }), (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || email.split("@")[0] || "Student").trim().slice(0, 80);
    const inviteCode = normalizeReferralCode(req.body?.referralCode);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw apiError("INVALID_EMAIL", "Enter a valid email");
    if (password.length < 8) throw apiError("WEAK_PASSWORD", "Password must be at least 8 characters");
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) throw apiError("EMAIL_EXISTS", "Email is already registered", 409);
    const referrer = inviteCode ? db.prepare("SELECT id FROM users WHERE referral_code = ?").get(inviteCode) : null;
    if (inviteCode && !referrer) throw apiError("INVALID_REFERRAL_CODE", "Referral code is not valid");
    const timestamp = now();
    const result = db.transaction(() => {
      const inserted = db.prepare(`INSERT INTO users (email, name, password_hash, referral_code, referred_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(email, name || "Student", bcrypt.hashSync(password, 10), referralCode(), referrer?.id || null, timestamp);
      if (referrer) db.prepare(`INSERT INTO referrals
        (referrer_user_id, referred_user_id, code, status, reward_percent, created_at)
        VALUES (?, ?, ?, 'registered', 10, ?)`).run(referrer.id, inserted.lastInsertRowid, inviteCode, timestamp);
      return inserted;
    })();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    logEvent("auth.register", { userId: user.id, success: true });
    res.status(201).json({ user: safeUser(user), token: createSession(user.id) });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", rateLimit({ name: "user-login", max: 10, windowMs: 15 * 60 * 1000 }), (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!allowDemoAccount && email === demoEmail) throw apiError("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      logEvent("auth.login_failed", { success: false, reason: "invalid_credentials" }, "warn");
      throw apiError("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    }
    logEvent("auth.login", { userId: user.id, success: true });
    res.json({ user: safeUser(user), token: createSession(user.id) });
  } catch (error) { next(error); }
});

app.post("/api/auth/password/forgot", rateLimit({ name: "password-forgot", max: 3, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const user = /^\S+@\S+\.\S+$/.test(email) ? db.prepare("SELECT * FROM users WHERE email = ?").get(email) : null;
  // Always return the same result so this endpoint cannot be used to discover accounts.
  if (!user) return res.json({ ok: true, message: "If the address is registered, a reset email will be sent." });
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sessionHash(rawToken);
  const timestamp = now();
  db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ? OR used_at IS NOT NULL").run(user.id, timestamp);
  db.prepare(`INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)`).run(tokenHash, user.id, new Date(Date.now() + passwordResetLifetimeMs).toISOString(), timestamp);
  try {
    const delivered = await sendPasswordResetEmail(user, rawToken);
    if (!delivered) db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
  } catch {
    db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
  }
  logEvent("auth.password_reset_requested", { userId: user.id, success: true });
  res.json({ ok: true, message: "If the address is registered, a reset email will be sent." });
});

app.post("/api/auth/password/reset", rateLimit({ name: "password-reset", max: 8, windowMs: 15 * 60 * 1000 }), (req, res, next) => {
  try {
    const rawToken = String(req.body?.token || "");
    const newPassword = String(req.body?.newPassword || "");
    if (newPassword.length < 8) throw apiError("WEAK_PASSWORD", "Password must be at least 8 characters");
    const tokenHash = sessionHash(rawToken);
    const reset = db.prepare(`SELECT * FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`).get(tokenHash, now());
    if (!reset) throw apiError("INVALID_OR_EXPIRED_RESET_TOKEN", "This password reset link is invalid or has expired", 400);
    const timestamp = now();
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), reset.user_id);
      db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?").run(timestamp, tokenHash);
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(reset.user_id);
    })();
    for (const [token, session] of sessions) if (session.userId === reset.user_id) sessions.delete(token);
    res.json({ ok: true, message: "Password reset. Please sign in with your new password." });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", (req, res) => {
  const bearer = String(req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (bearer) {
    sessions.delete(bearer);
    db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(sessionHash(bearer));
  }
  res.json({ ok: true });
});

app.post("/api/auth/sessions/revoke-others", auth, (req, res, next) => {
  try {
    const currentHash = sessionHash(req.sessionToken);
    const result = db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?")
      .run(req.user.id, currentHash);
    for (const [token, session] of sessions) {
      if (session.userId === req.user.id && token !== req.sessionToken) sessions.delete(token);
    }
    res.json({ ok: true, revoked: result.changes });
  } catch (error) { next(error); }
});

app.post("/api/auth/password", auth, (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!bcrypt.compareSync(currentPassword, req.user.password_hash)) throw apiError("INVALID_CURRENT_PASSWORD", "Current password is incorrect", 401);
    if (newPassword.length < 8) throw apiError("WEAK_PASSWORD", "Password must be at least 8 characters");
    if (newPassword === currentPassword) throw apiError("PASSWORD_UNCHANGED", "New password must be different");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), req.user.id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?").run(req.user.id, sessionHash(req.sessionToken));
    for (const [token, session] of sessions) {
      if (session.userId === req.user.id && token !== req.sessionToken) sessions.delete(token);
    }
    res.json({ ok: true, message: "Password changed. Other sessions were signed out." });
  } catch (error) { next(error); }
});

app.get("/api/me", auth, async (req, res, next) => {
  try {
    expireSubscriptions();
    let subscription = currentSubscription(req.user.id);
    if (subscription?.status === "active" && needsSync(subscription)) subscription = await syncSubscription(subscription);
    res.json({ user: safeUser(req.user), subscription: subscription ? subscriptionView(subscription, currentPlan(subscription), requestOrigin(req)) : null });
  } catch (error) { next(error); }
});

app.patch("/api/me/profile", auth, (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (name.length < 2) throw apiError("INVALID_NAME", "Name must be at least 2 characters");
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.user.id);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    res.json({ user: safeUser(user) });
  } catch (error) { next(error); }
});

app.get("/api/support/tickets", auth, (req, res) => {
  const tickets = db.prepare("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.user.id).map(ticketView);
  res.json({ tickets });
});

app.post("/api/support/tickets", auth, (req, res, next) => {
  try {
    const subject = String(req.body?.subject || "").trim().slice(0, 120);
    const device = String(req.body?.device || "").trim().slice(0, 80);
    const client = String(req.body?.client || "").trim().slice(0, 80);
    const description = String(req.body?.description || "").trim().slice(0, 4000);
    if (!subject) throw apiError("INVALID_TICKET_SUBJECT", "Ticket subject is required");
    if (description.length < 10) throw apiError("INVALID_TICKET_DESCRIPTION", "Please describe the issue in at least 10 characters");
    const timestamp = now();
    const id = `TKT-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    db.prepare(`INSERT INTO support_tickets (id, user_id, subject, device, client, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(id, req.user.id, subject, device, client, description, timestamp, timestamp);
    res.status(201).json({ ticket: ticketView(db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(id)) });
  } catch (error) { next(error); }
});

app.get("/api/plans", (_req, res) => {
  res.json({ plans: db.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY id").all().map(planView) });
});

app.get("/api/config", (_req, res) => {
  res.json({ demoAccount: allowDemoAccount });
});

app.get("/api/payment/config", auth, (_req, res) => {
  const payment = currentPaymentConfig();
  res.json({ mode: payment.mode, mock: payment.mode === "mock", manual: payment.mode === "manual", webhook: payment.mode === "webhook", ready: paymentIsReady(payment), checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret), manualInstructions: payment.mode === "manual" ? payment.manualInstructions : "", methods: payment.methods });
});

function customerOrderView(order) {
  return {
    id: order.id, amount: order.amount, subtotal: order.subtotal, status: order.status,
    kind: order.kind, discountPercent: order.discountPercent, referralId: order.referralId || null,
    expiresAt: order.expiresAt, createdAt: order.createdAt, checkoutUrl: checkoutUrlFor(order),
  };
}

async function completeOrder(order, baseUrl = publicBaseUrl) {
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(order.plan_id);
  if (!plan) throw apiError("PLAN_NOT_FOUND", "Order plan was not found", 404);
  const existingSubscription = currentSubscription(order.user_id);
  const expiresAt = new Date();
  if (order.kind === "renewal") {
    const existingExpiry = existingSubscription ? expirationMillis(existingSubscription.expires_at) : 0;
    expiresAt.setTime(Math.max(Date.now(), existingExpiry));
  }
  expiresAt.setTime(addBillingPeriods(expiresAt, Number(plan.billing_period_months || 1)).getTime());
  // The primary source remains for compatibility and routing reports. Pool members
  // are merged into the customer-facing subscription content.
  const assignedRenewalSource = order.kind === "renewal" && existingSubscription?.source_id ? sourceById(existingSubscription.source_id) : null;
  const selectedSource = order.kind === "renewal" && existingSubscription?.source_id
    ? (assignedRenewalSource?.enabled ? assignedRenewalSource : null) || sourceForNewSubscription(order.user_id)
    : sourceForNewSubscription(order.user_id);
  const candidatePool = existingSubscription?.pool_id ? poolById(existingSubscription.pool_id) : poolForNewSubscription();
  // Empty pools must not suppress the established local demo subscription path.
  // In production this still fails closed because demo subscriptions are disabled.
  const selectedPool = candidatePool && poolMembers(candidatePool.id, { onlyHealthyCandidates: true }).length ? candidatePool : null;
  if (!selectedSource && !selectedPool && !configuredUpstreamUrl() && (!allowDemoSubscription || productionRuntime)) {
    throw apiError("UPSTREAM_NOT_CONFIGURED", "Configure an upstream source before activating a customer subscription", 503);
  }
  const poolResult = selectedPool ? await collectPoolSubscriptionFormats(selectedPool) : null;
  const { universal, clash, singbox, warnings } = poolResult || await fetchSubscriptionFormats(selectedSource?.id);
  const primarySourceId = selectedSource?.id || universal.sourceId;
  const timestamp = now();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'paid', confirmed_at = ? WHERE id = ? AND status = 'processing'").run(timestamp, order.id);
    db.prepare(`INSERT INTO subscriptions
      (user_id, plan_id, source_id, pool_id, token, status, usage_source, upstream_used_gb, upstream_total_gb, upstream_expires_at, upstream_synced_at, expires_at, last_sync_at, last_sync_status,
       universal_content, clash_content, singbox_content, created_at, updated_at)
      VALUES (@userId, @planId, @sourceId, @poolId, @token, 'active', @usageSource, @upstreamUsed, @upstreamTotal, @upstreamExpires, @upstreamSynced, @expiresAt, @lastSyncAt, @lastSyncStatus, @universal, @clash, @singbox, @createdAt, @updatedAt)
      ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, source_id = excluded.source_id, pool_id = excluded.pool_id, token = excluded.token,
        status = 'active', data_used_gb = 0, usage_source = excluded.usage_source, upstream_used_gb = excluded.upstream_used_gb,
        upstream_total_gb = excluded.upstream_total_gb, upstream_expires_at = excluded.upstream_expires_at,
        upstream_synced_at = excluded.upstream_synced_at, expires_at = excluded.expires_at, last_sync_at = excluded.last_sync_at,
        last_sync_status = excluded.last_sync_status, universal_content = excluded.universal_content,
        clash_content = excluded.clash_content, singbox_content = excluded.singbox_content, updated_at = excluded.updated_at`).run({
      userId: order.user_id, planId: plan.id, sourceId: primarySourceId, poolId: selectedPool?.id || null,
      token: order.kind === "renewal" && existingSubscription ? existingSubscription.token : subscriptionToken(),
      usageSource: universal.usage ? "upstream-aggregate" : "manual", upstreamUsed: universal.usage?.usedGb ?? null,
      upstreamTotal: universal.usage?.totalGb ?? null, upstreamExpires: universal.usage?.expiresAt ?? null,
      upstreamSynced: universal.usage ? timestamp : null, expiresAt: expiresAt.toISOString(), lastSyncAt: timestamp,
      lastSyncStatus: warnings.length ? "partial" : universal.source, universal: universal.content, clash: clash.content,
      singbox: singbox.content, createdAt: timestamp, updatedAt: timestamp,
    });
    db.prepare(`UPDATE referrals SET status = 'qualified', qualified_at = ?
      WHERE referred_user_id = ? AND status = 'registered'`).run(timestamp, order.user_id);
    if (order.referral_id) db.prepare("UPDATE referrals SET reward_used_at = ? WHERE id = ? AND status = 'qualified' AND reward_used_at IS NULL").run(timestamp, order.referral_id);
  });
  transaction();
  const subscription = currentSubscription(order.user_id);
  if (selectedPool) {
    ensureSubscriptionSourceAssignments(subscription.id, selectedPool.id, primarySourceId);
    persistPoolSourceStates(subscription.id, poolResult.sourceResults, timestamp);
    recordPoolSyncRun({ poolId: selectedPool.id, subscriptionId: subscription.id, status: warnings.length ? "partial" : "ok", stats: poolResult.stats, startedAt: timestamp });
  }
  recordUsageSnapshot(subscription, timestamp);
  logEvent("subscription.activated", { userId: order.user_id, orderId: order.id, sourceId: subscription.source_id, status: "active", success: true });
  return { order: { ...order, status: "paid", confirmedAt: timestamp }, subscription: subscriptionView(subscription, currentPlan(subscription), baseUrl) };
}

app.post("/api/orders", auth, (req, res, next) => {
  try {
    const payment = currentPaymentConfig();
    if (payment.mode !== "mock" && !paymentIsReady(payment)) throw apiError("PAYMENT_NOT_CONFIGURED", "Payment instructions or verification settings are not fully configured", 503);
    const plan = db.prepare("SELECT * FROM plans WHERE id = ? AND active = 1").get(Number(req.body?.planId) || 1);
    if (!plan) throw apiError("PLAN_NOT_FOUND", "Plan is not available", 404);
    if (!defaultSource() && !configuredUpstreamUrl() && (!allowDemoSubscription || productionRuntime)) {
      throw apiError("UPSTREAM_NOT_CONFIGURED", "Configure an upstream source before creating a customer order", 503);
    }
    const clientRequestId = String(req.headers["idempotency-key"] || req.body?.idempotencyKey || "").trim().slice(0, 128);
    if (clientRequestId) {
      const replay = db.prepare("SELECT * FROM orders WHERE user_id = ? AND client_request_id = ?").get(req.user.id, clientRequestId);
      if (replay) {
        const replayPlan = db.prepare("SELECT * FROM plans WHERE id = ?").get(replay.plan_id);
        const replaySubtotal = replay.kind === "renewal" ? replayPlan.renewal_price : replayPlan.first_month_price;
        return res.json({ replayed: true, order: customerOrderView({ ...replay, subtotal: replaySubtotal, discountPercent: replay.discount_percent, referralId: replay.referral_id, expiresAt: replay.expires_at, createdAt: replay.created_at }), plan: planView(replayPlan), pricing: { subtotal: replaySubtotal, discountPercent: replay.discount_percent, amount: replay.amount } });
      }
    }
    expireSubscriptions();
    const subscription = currentSubscription(req.user.id);
    const renewal = Boolean(req.body?.renewal);
    if (!renewal && subscription?.status === "active") throw apiError("SUBSCRIPTION_ALREADY_ACTIVE", "Subscription is already active; create a renewal order instead", 409);
    if (renewal && !subscription) throw apiError("SUBSCRIPTION_NOT_FOUND", "No subscription to renew", 404);
    expirePendingOrders();
    const pending = db.prepare("SELECT id, amount, kind, discount_percent, created_at FROM orders WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(req.user.id);
    if (pending) throw apiError("PENDING_ORDER_EXISTS", `There is already a pending ${pending.kind} order. Cancel it before creating another order.`, 409);
    const eligibleReferral = renewal ? db.prepare(`SELECT id, reward_percent FROM referrals
      WHERE referrer_user_id = ? AND status = 'qualified' AND reward_used_at IS NULL
      ORDER BY qualified_at ASC LIMIT 1`).get(req.user.id) : null;
    const discountPercent = eligibleReferral?.reward_percent || 0;
    const subtotal = renewal ? plan.renewal_price : plan.first_month_price;
    const amount = fromCents(toCents(subtotal) * (100 - discountPercent) / 100);
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const order = { id: randomId(), amount, subtotal, status: "pending", kind: renewal ? "renewal" : "new", discountPercent, referralId: eligibleReferral?.id || null, expiresAt, createdAt, clientRequestId: clientRequestId || null };
    try {
      db.prepare(`INSERT INTO orders (id, user_id, plan_id, amount, status, kind, discount_percent, referral_id, expires_at, created_at, client_request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(order.id, req.user.id, plan.id, order.amount, order.status, order.kind, order.discountPercent, order.referralId, order.expiresAt, order.createdAt, order.clientRequestId);
    } catch (error) {
      if (String(error.message).includes("idx_orders_one_open_per_user")) throw apiError("OPEN_ORDER_EXISTS", "There is already an open order for this customer", 409);
      throw error;
    }
    logEvent("order.created", { userId: req.user.id, orderId: order.id, status: order.status, success: true });
    res.status(201).json({ order: customerOrderView(order), plan: planView(plan), pricing: { subtotal, discountPercent, amount } });
  } catch (error) { next(error); }
});

app.get("/api/orders", auth, (req, res) => {
  expirePendingOrders();
  const orders = db.prepare(`SELECT o.id, o.amount, o.status, o.kind, o.discount_percent, o.expires_at, o.created_at, o.confirmed_at,
    p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at
    FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN payment_submissions ps ON ps.order_id = o.id
    WHERE o.user_id = ? ORDER BY o.created_at DESC`).all(req.user.id).map((order) => ({
      id: order.id, amount: order.amount, status: order.status, kind: order.kind, discountPercent: order.discount_percent, expiresAt: order.expires_at, checkoutUrl: checkoutUrlFor(order), planName: order.plan_name,
      createdAt: order.created_at, confirmedAt: order.confirmed_at,
      paymentSubmission: order.submitted_at ? { method: order.payment_method, reference: order.payment_reference, note: order.customer_note || "", submittedAt: order.submitted_at } : null,
    }));
  res.json({ orders });
});

app.get("/api/orders/:id", auth, (req, res, next) => {
  try {
    expirePendingOrders();
    const order = db.prepare(`SELECT o.id, o.amount, o.status, o.kind, o.discount_percent, o.expires_at, o.created_at, o.confirmed_at,
      p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at
      FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN payment_submissions ps ON ps.order_id = o.id
      WHERE o.id = ? AND o.user_id = ?`).get(req.params.id, req.user.id);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    res.json({ order: {
      id: order.id, amount: order.amount, status: order.status, kind: order.kind,
      discountPercent: order.discount_percent, expiresAt: order.expires_at,
      checkoutUrl: checkoutUrlFor(order), planName: order.plan_name,
      createdAt: order.created_at, confirmedAt: order.confirmed_at,
      paymentSubmission: order.submitted_at ? { method: order.payment_method, reference: order.payment_reference, note: order.customer_note || "", submittedAt: order.submitted_at } : null,
    } });
  } catch (error) { next(error); }
});

app.post("/api/orders/:id/payment-submission", auth, (req, res, next) => {
  try {
    const payment = currentPaymentConfig();
    if (payment.mode !== "manual") throw apiError("PAYMENT_SUBMISSION_NOT_AVAILABLE", "Payment references are only used for manual payment", 409);
    const order = db.prepare("SELECT id, status FROM orders WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    if (order.status !== "pending") throw apiError("ORDER_NOT_SUBMITTABLE", "Only pending orders can submit payment information", 409);
    const method = String(req.body?.method || "").trim();
    const reference = String(req.body?.reference || "").trim().slice(0, 160);
    const note = String(req.body?.note || "").trim().slice(0, 500);
    if (!payment.methods.some((item) => item.id === method)) throw apiError("INVALID_PAYMENT_METHOD", "Select an available payment method");
    if (reference.length < 3) throw apiError("INVALID_PAYMENT_REFERENCE", "Enter a payment reference or transfer number");
    const submittedAt = now();
    db.prepare(`INSERT INTO payment_submissions (order_id, payment_method, payment_reference, customer_note, submitted_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET payment_method = excluded.payment_method,
        payment_reference = excluded.payment_reference, customer_note = excluded.customer_note, submitted_at = excluded.submitted_at`)
      .run(order.id, method, reference, note || null, submittedAt);
    res.json({ ok: true, orderId: order.id, paymentSubmission: { method, reference, note, submittedAt } });
  } catch (error) { next(error); }
});

app.post("/api/orders/:id/cancel", auth, (req, res, next) => {
  try {
    const result = db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'")
      .run(req.params.id, req.user.id);
    if (result.changes !== 1) throw apiError("ORDER_NOT_CANCELLABLE", "Only your pending orders can be cancelled", 409);
    res.json({ ok: true, orderId: req.params.id, status: "cancelled" });
  } catch (error) { next(error); }
});

app.post("/api/orders/:id/confirm", auth, async (req, res, next) => {
  let claimedOrderId = null;
  try {
    const payment = currentPaymentConfig();
    if (payment.mode !== "mock" || productionRuntime) throw apiError("MOCK_PAYMENT_DISABLED", "This deployment requires payment confirmation from the configured payment flow", 409);
    expirePendingOrders();
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    if (order.status === "paid") {
      const existing = currentSubscription(req.user.id);
      if (!existing) throw apiError("ORDER_SUBSCRIPTION_MISSING", "Paid order has no subscription", 409);
      return res.json({ order: { ...order, confirmedAt: order.confirmed_at }, subscription: subscriptionView(existing, currentPlan(existing), requestOrigin(req)) });
    }
    if (order.status === "processing") throw apiError("ORDER_PROCESSING", "Order confirmation is already in progress", 409);
    if (order.status !== "pending") throw apiError("ORDER_NOT_CONFIRMABLE", "Order cannot be confirmed", 409);
    const claim = db.prepare("UPDATE orders SET status = 'processing' WHERE id = ? AND user_id = ? AND status = 'pending'").run(order.id, req.user.id);
    if (claim.changes !== 1) throw apiError("ORDER_PROCESSING", "Order confirmation is already in progress", 409);
    claimedOrderId = order.id;
    res.json(await completeOrder(order, requestOrigin(req)));
  } catch (error) {
    if (claimedOrderId) db.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'").run(claimedOrderId);
    next(error);
  }
});

app.post("/api/webhooks/payment", rateLimit({ name: "payment-webhook", max: 120, windowMs: 60 * 1000 }), async (req, res, next) => {
  let claimedOrderId = null;
  try {
    const payment = currentPaymentConfig();
    if (!payment.webhookSecret) throw apiError("PAYMENT_WEBHOOK_NOT_CONFIGURED", "Payment webhook secret is not configured", 503);
    const signature = String(req.headers["x-cheapvpn-signature"] || "");
    const expected = crypto.createHmac("sha256", payment.webhookSecret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest("hex");
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw apiError("INVALID_PAYMENT_SIGNATURE", "Payment signature is invalid", 401);
    }
    const provider = String(req.body?.provider || "external").slice(0, 40);
    const eventId = String(req.body?.eventId || req.body?.id || "").trim().slice(0, 160);
    const orderId = String(req.body?.orderId || "").trim();
    const status = String(req.body?.status || "").toLowerCase();
    const amount = Number(req.body?.amount);
    const successful = ["paid", "succeeded"].includes(status);
    const failed = ["failed", "cancelled", "canceled"].includes(status);
    if (!eventId || !orderId || (!successful && !failed)) throw apiError("INVALID_PAYMENT_EVENT", "A payment eventId, orderId and supported status are required");
    if (!Number.isFinite(amount) || amount < 0) throw apiError("INVALID_PAYMENT_AMOUNT", "A valid payment amount is required");
    const previousEvent = db.prepare("SELECT provider_event_id, order_id FROM payment_events WHERE provider_event_id = ?").get(eventId);
    if (previousEvent) {
      if (previousEvent.order_id !== orderId) throw apiError("PAYMENT_EVENT_CONFLICT", "This payment event is already linked to another order", 409);
      return res.json({ ok: true, duplicate: true, orderId: previousEvent.order_id });
    }
    expirePendingOrders();
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    if (order.status === "expired") throw apiError("PAYMENT_ORDER_EXPIRED", "This order has expired", 410);
    if (Number.isFinite(amount) && toCents(amount) !== toCents(order.amount)) throw apiError("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match order", 409);
    if (failed) {
      if (order.status === "paid") throw apiError("ORDER_ALREADY_PAID", "A paid order cannot be marked as failed", 409);
      if (order.status !== "pending") throw apiError("ORDER_NOT_CONFIRMABLE", "Only pending orders can receive a payment failure", 409);
      const failedStatus = status === "canceled" ? "cancelled" : "failed";
      db.prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'pending'").run(failedStatus, order.id);
       db.prepare(`INSERT OR IGNORE INTO payment_events (provider, provider_event_id, order_id, status, amount, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(provider, eventId, order.id, failedStatus, Number.isFinite(amount) ? amount : order.amount, now());
      logEvent("payment.failed", { orderId: order.id, provider, eventId, status: failedStatus, success: false }, "warn");
      return res.json({ ok: true, failed: true, orderId: order.id, status: failedStatus });
    }
    if (order.status === "paid") {
      db.prepare(`INSERT OR IGNORE INTO payment_events (provider, provider_event_id, order_id, status, amount, created_at)
        VALUES (?, ?, ?, 'paid', ?, ?)`).run(provider, eventId, order.id, Number.isFinite(amount) ? amount : order.amount, now());
      return res.json({ ok: true, alreadyPaid: true, orderId: order.id });
    }
    const claim = db.prepare("UPDATE orders SET status = 'processing' WHERE id = ? AND status = 'pending'").run(order.id);
    if (claim.changes !== 1) throw apiError("ORDER_PROCESSING", "Order confirmation is already in progress", 409);
    claimedOrderId = order.id;
    const result = await completeOrder(order);
    db.prepare(`INSERT OR IGNORE INTO payment_events (provider, provider_event_id, order_id, status, amount, created_at)
      VALUES (?, ?, ?, 'paid', ?, ?)`).run(provider, eventId, order.id, Number.isFinite(amount) ? amount : order.amount, now());
    logEvent("payment.succeeded", { orderId: order.id, provider, eventId, status: "paid", success: true });
    res.json({ ok: true, orderId: order.id, subscription: result.subscription });
  } catch (error) {
    if (claimedOrderId) db.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'").run(claimedOrderId);
    next(error);
  }
});

app.get("/api/subscription", auth, async (req, res) => {
  let subscription = activeSubscriptionOrError(req.user.id);
  if (needsSync(subscription)) subscription = await syncSubscription(subscription);
  if (subscription.status !== "active") throw apiError("SUBSCRIPTION_EXPIRED", "Subscription has expired or reached its data limit", 410);
  res.json({ subscription: subscriptionView(subscription, currentPlan(subscription), requestOrigin(req)) });
});

app.post("/api/subscription/sync", auth, async (req, res) => {
  const subscription = activeSubscriptionOrError(req.user.id);
  const synced = await syncSubscription(subscription);
  if (synced.status !== "active") throw apiError("SUBSCRIPTION_EXPIRED", "Subscription has expired or reached its data limit", 410);
  res.json({ subscription: subscriptionView(synced, currentPlan(synced), requestOrigin(req)) });
});

app.post("/api/subscription/reset", auth, (req, res) => {
  const subscription = activeSubscriptionOrError(req.user.id);
  db.prepare("UPDATE subscriptions SET token = ?, updated_at = ? WHERE id = ?").run(subscriptionToken(), now(), subscription.id);
  const updated = currentSubscription(req.user.id);
  res.json({ subscription: subscriptionView(updated, currentPlan(updated), requestOrigin(req)) });
});

app.get("/api/usage", auth, async (req, res, next) => {
  try {
    let subscription = activeSubscriptionOrError(req.user.id);
    if (needsSync(subscription)) subscription = await syncSubscription(subscription);
    if (subscription.status !== "active") throw apiError("SUBSCRIPTION_EXPIRED", "Subscription has expired or reached its data limit", 410);
    res.json({
      used: quotaUsageGb(subscription), total: subscription.data_total_gb,
      remaining: quotaIsEnforced(subscription) ? Math.max(0, subscription.data_total_gb - quotaUsageGb(subscription)) : subscription.data_total_gb,
      quotaEnforced: quotaIsEnforced(subscription), devices: subscription.device_limit,
      expiresAt: subscription.expires_at, usageSource: subscription.usage_source || "manual",
      upstream: subscription.upstream_total_gb === null || subscription.upstream_total_gb === undefined ? null : {
        used: subscription.upstream_used_gb || 0, total: subscription.upstream_total_gb,
        expiresAt: subscription.upstream_expires_at, syncedAt: subscription.upstream_synced_at,
      },
    });
  } catch (error) { next(error); }
});

app.get("/api/usage/history", auth, (req, res, next) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
    const subscription = currentSubscription(req.user.id);
    if (!subscription) return res.json({ history: [] });
    const history = db.prepare(`SELECT used_gb, total_gb, source, captured_at
      FROM usage_snapshots WHERE user_id = ? AND subscription_id = ?
      ORDER BY captured_at DESC LIMIT ?`).all(req.user.id, subscription.id, limit).map((snapshot) => ({
        usedGb: snapshot.used_gb, totalGb: snapshot.total_gb,
        source: snapshot.source, capturedAt: snapshot.captured_at,
      }));
    res.json({ history });
  } catch (error) { next(error); }
});

app.get("/api/referral", auth, (req, res) => {
  const referrals = db.prepare(`SELECT r.status, r.reward_percent, r.created_at, r.qualified_at,
    u.name, u.email FROM referrals r JOIN users u ON u.id = r.referred_user_id
    WHERE r.referrer_user_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
  const qualified = referrals.filter((referral) => referral.status === "qualified").length;
  res.json({
    code: req.user.referral_code,
    link: `${requestOrigin(req)}/?ref=${encodeURIComponent(req.user.referral_code)}`,
    reward: "10% off next renewal",
    successfulInvites: qualified,
    pendingInvites: referrals.length - qualified,
    referrals: referrals.map((referral) => ({
      name: referral.name, email: referral.email, status: referral.status,
      reward: `${referral.reward_percent}%`, createdAt: referral.created_at, qualifiedAt: referral.qualified_at,
    })),
  });
});

function serveSubscription(field, contentType) {
  return async (req, res, next) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Referrer-Policy", "no-referrer");
    try {
      expireSubscriptions();
      let subscription = db.prepare(`SELECT s.*, p.data_total_gb
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.token = ?`).get(req.params.token);
      if (!subscription) return res.status(404).send("Subscription not found");
      const format = field === "clash_content" ? "clash" : field === "singbox_content" ? "singbox" : "universal";
      const invalidCachedFormat = subscription[field] && !formatLooksUsable(subscription[field], format);
      const missingClashGroup = format === "clash" && subscription[field] && !/(^|\n)proxy-groups\s*:/i.test(subscription[field]);
      let transientFormatContent = null;
      // A supplier can intermittently fail its generic endpoint while still
      // serving a usable converted format. Do not make Clash/SingBox clients
      // wait for or depend on an unrelated generic-format refresh.
      if (subscription.status === "active" && !subscription.pool_id && format !== "universal" && (invalidCachedFormat || missingClashGroup || !subscription[field])) {
        try { transientFormatContent = (await fetchUpstream(subscription.source_id, format)).content; } catch { /* Let the normal stale-cache path handle a second attempt. */ }
        if (transientFormatContent) {
          subscription[field] = transientFormatContent;
          db.prepare(`UPDATE subscriptions SET ${field} = ?, updated_at = ? WHERE id = ?`).run(transientFormatContent, now(), subscription.id);
        }
      }
      if (subscription.status === "active" && !transientFormatContent && (needsSync(subscription) || invalidCachedFormat || missingClashGroup || (!subscription[field] && subscription.last_sync_status === "pending"))) {
        const hasCachedFormat = Boolean(subscription[field]);
        const canServeStale = hasCachedFormat && subscription.last_sync_status !== "pending";
        if (canServeStale) {
          // Keep client refreshes fast while one background request refreshes the cached content.
          void syncSubscription(subscription).catch(() => undefined);
        } else {
          subscription = await syncSubscription(subscription);
        }
      }
      expireSubscriptions();
      if (subscription.status !== "active") return res.status(410).send("Subscription expired");
      if (!subscription[field]) return res.status(404).send("Subscription format unavailable");
      const totalBytes = Math.max(0, Math.round(Number(subscription.data_total_gb || 0) * 1024 ** 3));
      const usedBytes = Math.min(totalBytes, Math.max(0, Math.round(quotaUsageGb(subscription) * 1024 ** 3)));
      const expireSeconds = Math.floor(expirationMillis(subscription.expires_at) / 1000);
      res.set("subscription-userinfo", `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expireSeconds}`);
      res.set("profile-title", "CheapVPN");
      res.set("Cache-Control", "private, max-age=60, must-revalidate");
      const etag = `"${crypto.createHash("sha1").update(`${subscription.id}:${subscription.updated_at}:${field}`).digest("hex")}"`;
      res.set("ETag", etag);
      if (req.headers["if-none-match"] === etag) return res.status(304).end();
      res.type(contentType).send(subscription[field]);
    } catch (error) { next(error); }
  };
}

const subscriptionPublicRateLimit = rateLimit({ name: "public-subscription", max: 120, windowMs: 60 * 1000 });
app.get("/s/:token", subscriptionPublicRateLimit, serveSubscription("universal_content", "text/plain"));
app.get("/s/clash/:token", subscriptionPublicRateLimit, serveSubscription("clash_content", "text/yaml"));
app.get("/s/singbox/:token", subscriptionPublicRateLimit, serveSubscription("singbox_content", "application/json"));

const distDir = path.join(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: "index.html" }));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/s/") && req.path !== "/health") {
      return res.sendFile(path.join(distDir, "index.html"));
    }
    next();
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: { code: error.code || "INTERNAL_ERROR", message: status === 500 ? "Unexpected server error" : error.message } });
});

export function productionStartupErrors() {
  if (!productionRuntime) return [];
  const payment = currentPaymentConfig();
  const errors = [];
  if (!encryptionKeyIsStrong()) errors.push("ADMIN_ENCRYPTION_KEY must be a random secret of at least 32 characters");
  if (!adminPasswordIsStrong()) errors.push("a strong ADMIN_PASSWORD or an updated admin password is required");
  if (allowDemoAccount) errors.push("ALLOW_DEMO_ACCOUNT must be false");
  if (allowDemoSubscription) errors.push("ALLOW_DEMO_SUBSCRIPTION must be false");
  if (allowPrivateUpstreamUrls) errors.push("ALLOW_PRIVATE_UPSTREAM_URLS must be false");
  if (!paymentIsReadyForProduction(payment)) errors.push("a ready manual or webhook payment configuration is required");
  return errors;
}

export function createApp({ database: injectedDatabase, provider, mailer } = {}) {
  if (injectedDatabase) database = injectedDatabase;
  if (provider) subscriptionProvider = provider;
  if (mailer) injectedMailer = mailer;
  return app;
}

export function startBackgroundJobs() {
  scheduleProviderUsageSync();
  scheduleResourcePoolSync();
}

export function stopBackgroundJobs() {
  if (providerUsageSyncTimer) clearInterval(providerUsageSyncTimer);
  providerUsageSyncTimer = null;
  if (resourcePoolSyncTimer) clearInterval(resourcePoolSyncTimer);
  resourcePoolSyncTimer = null;
}

export function closeDatabase() {
  stopBackgroundJobs();
  db.close();
}

export { db };

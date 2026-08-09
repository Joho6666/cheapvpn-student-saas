import bcrypt from "bcryptjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const paymentMethodCatalog = [
  { id: "wechat_pay", label: "WeChat Pay", icon: "chat", description: "微信支付" },
  { id: "alipay", label: "Alipay", icon: "account_balance_wallet", description: "支付宝" },
  { id: "card", label: "Visa / Mastercard", icon: "credit_card", description: "信用卡或借记卡" },
  { id: "bank_transfer", label: "Bank transfer", icon: "account_balance", description: "银行转账" },
];

const now = () => new Date().toISOString();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const failure = (code, message, status = 400) => json({ error: { code, message } }, status);
function base64url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
const fromBase64url = (value) => Uint8Array.from(atob(String(value).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value).length + 3) % 4)), (char) => char.charCodeAt(0));
const randomToken = (prefix = "") => { const bytes = crypto.getRandomValues(new Uint8Array(24)); return `${prefix}${base64url(bytes)}`; };
const safeUser = (user) => ({ id: user.id, email: user.email, name: user.name, referralCode: user.referral_code, createdAt: user.created_at });
const publicBase = (request, env) => String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
const planView = (plan) => ({ id: plan.id, slug: plan.slug, name: plan.name, firstMonth: Number(plan.first_month_price), renewal: Number(plan.renewal_price), dataTotal: Number(plan.data_total_gb), devices: Number(plan.device_limit), periodMonths: Number(plan.billing_period_months || 1), active: Boolean(plan.active) });

async function digest(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function passwordHash(password) {
  // Keep new accounts compatible with the migrated Node.js user records.
  return bcrypt.hashSync(password, 12);
}

async function passwordMatches(password, stored) {
  if (String(stored || "").startsWith("$2")) return bcrypt.compareSync(password, stored);
  const [kind, iterations, salt, expected] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !iterations || !salt || !expected) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64url(salt), iterations: Number(iterations) }, key, 256);
  return (await digest(base64url(new Uint8Array(bits)))) === (await digest(expected));
}

async function encryptionKey(env) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_ENCRYPTION_KEY || "")), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), encoder.encode(value)));
  const cipher = combined.slice(0, -16);
  const tag = combined.slice(-16);
  return `${base64url(iv)}.${base64url(tag)}.${base64url(cipher)}`;
}

async function decrypt(value, env) {
  const [iv, tag, cipher] = String(value || "").split(".");
  const encrypted = new Uint8Array([...fromBase64url(cipher), ...fromBase64url(tag)]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await encryptionKey(env), encrypted);
  return decoder.decode(plain);
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function currentUser(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await digest(token);
  const session = await env.DB.prepare("SELECT s.*, u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(tokenHash, now()).first();
  if (!session) return null;
  await env.DB.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now(), tokenHash).run();
  return { user: session, token, tokenHash };
}

async function currentAdmin(request, env) {
  const token = bearer(request);
  if (!token) return null;
  const tokenHash = await digest(token);
  const session = await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, now()).first();
  if (!session) return null;
  await env.DB.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now(), tokenHash).run();
  return { token, tokenHash };
}

async function createUserSession(userId, env) {
  const token = randomToken();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  await env.DB.prepare("INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").bind(await digest(token), userId, expiresAt, timestamp, timestamp).run();
  return token;
}

async function createAdminSession(env) {
  const token = randomToken();
  const timestamp = now();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions (token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(await digest(token), expiresAt, timestamp, timestamp).run();
  return token;
}

async function expireSubscriptions(env) {
  await env.DB.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?").bind(now(), now()).run();
}

function subLinks(subscription, request, env) {
  const root = publicBase(request, env);
  return { universal: `${root}/s/${subscription.token}`, clash: `${root}/s/clash/${subscription.token}`, singbox: `${root}/s/singbox/${subscription.token}` };
}

async function subscriptionForUser(userId, env) {
  await expireSubscriptions(env);
  return env.DB.prepare("SELECT s.*, p.slug, p.name AS plan_name, p.first_month_price, p.renewal_price, p.data_total_gb, p.device_limit, p.billing_period_months, p.active FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?").bind(userId).first();
}

function subscriptionView(subscription, request, env) {
  if (!subscription) return null;
  return { id: subscription.id, status: subscription.status, expiresAt: subscription.expires_at, dataTotalGb: Number(subscription.data_total_gb), dataUsedGb: Number(subscription.upstream_used_gb ?? subscription.data_used_gb), deviceLimit: subscription.device_limit, lastSyncAt: subscription.last_sync_at, lastSyncStatus: subscription.last_sync_status, plan: planView(subscription), links: subLinks(subscription, request, env) };
}

function maskUrl(value) { try { const url = new URL(value); return `${url.origin}${url.pathname.slice(0, 22)}...`; } catch { return "Configured"; } }

async function sourceView(source, env) {
  const universal = await decrypt(source.universal_url_encrypted || source.url_encrypted, env);
  let nodeRules = [];
  try { nodeRules = JSON.parse(source.node_rules_json || "[]"); } catch { nodeRules = []; }
  return { id: source.id, name: source.name, enabled: Boolean(source.enabled), isDefault: Boolean(source.is_default), maskedUrl: maskUrl(universal), lastSyncAt: source.last_sync_at, lastSyncStatus: source.last_sync_status, lastSyncError: source.last_sync_error, nodeRules };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "CheapVPN-Subscription-Sync/1.0" } });
    if (!response.ok) throw new Error(`Upstream responded ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

async function syncSubscription(subscription, env) {
  const timestamp = now();
  const source = subscription.source_id
    ? await env.DB.prepare("SELECT * FROM upstream_sources WHERE id = ? AND enabled = 1").bind(subscription.source_id).first()
    : await env.DB.prepare("SELECT * FROM upstream_sources WHERE enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1").first();
  if (!source) throw new Error("No enabled upstream source is configured");
  try {
    const universalUrl = await decrypt(source.universal_url_encrypted || source.url_encrypted, env);
    const clashUrl = source.clash_url_encrypted ? await decrypt(source.clash_url_encrypted, env) : universalUrl;
    const singboxUrl = source.singbox_url_encrypted ? await decrypt(source.singbox_url_encrypted, env) : universalUrl;
    const [universal, clash, singbox] = await Promise.all([fetchText(universalUrl), fetchText(clashUrl), fetchText(singboxUrl)]);
    await env.DB.prepare("UPDATE subscriptions SET source_id = ?, universal_content = ?, clash_content = ?, singbox_content = ?, last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL, updated_at = ? WHERE id = ?").bind(source.id, universal, clash, singbox, timestamp, timestamp, subscription.id).run();
    await env.DB.prepare("UPDATE upstream_sources SET last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL, updated_at = ? WHERE id = ?").bind(timestamp, timestamp, source.id).run();
  } catch (error) {
    await env.DB.prepare("UPDATE subscriptions SET last_sync_at = ?, last_sync_status = 'stale', last_sync_error = ?, updated_at = ? WHERE id = ?").bind(timestamp, String(error.message).slice(0, 500), timestamp, subscription.id).run();
    throw error;
  }
  return subscriptionForUser(subscription.user_id, env);
}

async function confirmOrder(order, env) {
  if (!order || order.status !== "pending") return null;
  const timestamp = now();
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(order.plan_id).first();
  if (!plan) throw new Error("Plan not found");
  const current = await subscriptionForUser(order.user_id, env);
  const currentExpiry = current?.status === "active" ? Date.parse(current.expires_at) : Date.now();
  const expiresAt = new Date(Math.max(Date.now(), currentExpiry) + Number(plan.billing_period_months) * 30 * 24 * 60 * 60 * 1000).toISOString();
  if (current) {
    await env.DB.prepare("UPDATE subscriptions SET plan_id = ?, status = 'active', expires_at = ?, updated_at = ? WHERE id = ?").bind(plan.id, expiresAt, timestamp, current.id).run();
  } else {
    await env.DB.prepare("INSERT INTO subscriptions (user_id, plan_id, token, status, expires_at, universal_content, clash_content, singbox_content, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '', '', '', ?, ?)").bind(order.user_id, plan.id, randomToken("cvpn_"), expiresAt, timestamp, timestamp).run();
  }
  await env.DB.prepare("UPDATE orders SET status = 'paid', confirmed_at = ? WHERE id = ?").bind(timestamp, order.id).run();
  const subscription = await subscriptionForUser(order.user_id, env);
  try { await syncSubscription(subscription, env); } catch { /* Keep the paid subscription active and retry on demand. */ }
  return subscriptionForUser(order.user_id, env);
}

async function expirePendingOrders(env) {
  await env.DB.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?").bind(now()).run();
}

function validCheckoutTemplate(template) {
  const value = String(template || "").trim();
  if (!value) return false;
  try {
    const probe = value.replaceAll("{orderId}", "order-probe").replaceAll("{amount}", "19.90");
    const url = new URL(probe);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

async function paymentConfig(env) {
  const mode = await setting(env, "payment_mode", env.PAYMENT_MODE || "manual");
  const checkoutTemplate = await setting(env, "payment_checkout_template", env.PAYMENT_CHECKOUT_URL_TEMPLATE || "");
  const encryptedSecret = await setting(env, "payment_webhook_secret_encrypted", "");
  let methodIds = ["wechat_pay", "alipay", "card"];
  try {
    const storedMethods = JSON.parse(await setting(env, "payment_method_ids", ""));
    if (Array.isArray(storedMethods)) methodIds = storedMethods;
  } catch { /* Use the customer-friendly defaults until an admin customizes them. */ }
  const methods = paymentMethodCatalog.filter((method) => methodIds.includes(method.id));
  return {
    mode: ["mock", "manual", "webhook"].includes(mode) ? mode : "manual",
    manualInstructions: await setting(env, "payment_manual_instructions", env.PAYMENT_MANUAL_INSTRUCTIONS || ""),
    checkoutTemplate,
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET || (encryptedSecret ? await decrypt(encryptedSecret, env) : ""),
    methods: methods.length ? methods : paymentMethodCatalog.filter((method) => ["wechat_pay", "alipay", "card"].includes(method.id)),
  };
}

function paymentReady(payment) {
  return (payment.mode === "mock") || (payment.mode === "manual" && Boolean(payment.manualInstructions.trim())) || (payment.mode === "webhook" && Boolean(payment.webhookSecret) && validCheckoutTemplate(payment.checkoutTemplate));
}

function checkoutUrlFor(order, payment) {
  if (!validCheckoutTemplate(payment?.checkoutTemplate) || !order?.id) return null;
  return payment.checkoutTemplate.replaceAll("{orderId}", encodeURIComponent(order.id)).replaceAll("{amount}", encodeURIComponent(Number(order.amount).toFixed(2)));
}

async function hmacHex(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function paymentWebhook(request, env) {
  const payment = await paymentConfig(env);
  if (payment.mode !== "webhook" || !payment.webhookSecret) return failure("PAYMENT_WEBHOOK_NOT_CONFIGURED", "Payment webhook is not configured", 503);
  const rawBody = await request.text();
  const signature = String(request.headers.get("x-cheapvpn-signature") || "").trim().toLowerCase();
  const expected = await hmacHex(rawBody, payment.webhookSecret);
  if (!safeEqual(signature, expected)) return failure("INVALID_PAYMENT_SIGNATURE", "Payment signature is invalid", 401);
  let body;
  try { body = JSON.parse(rawBody); } catch { return failure("INVALID_PAYMENT_EVENT", "Payment payload must be valid JSON"); }
  const provider = String(body.provider || "external").trim().slice(0, 40);
  const eventId = String(body.eventId || body.id || "").trim().slice(0, 160);
  const orderId = String(body.orderId || "").trim();
  const status = String(body.status || "").trim().toLowerCase();
  const amount = Number(body.amount);
  const successful = ["paid", "succeeded"].includes(status);
  const failed = ["failed", "cancelled", "canceled"].includes(status);
  if (!eventId || !orderId || (!successful && !failed) || !Number.isFinite(amount) || amount < 0) return failure("INVALID_PAYMENT_EVENT", "A payment eventId, orderId, amount and supported status are required");
  const priorEvent = await env.DB.prepare("SELECT order_id FROM payment_events WHERE provider_event_id = ?").bind(eventId).first();
  if (priorEvent) return priorEvent.order_id === orderId ? json({ ok: true, duplicate: true, orderId }) : failure("PAYMENT_EVENT_CONFLICT", "This payment event is already linked to another order", 409);
  await expirePendingOrders(env);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return failure("ORDER_NOT_FOUND", "Order not found", 404);
  if (Number(Math.round(amount * 100)) !== Number(Math.round(Number(order.amount) * 100))) return failure("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match order", 409);
  if (order.status === "paid") {
    await env.DB.prepare("INSERT INTO payment_events (provider_event_id, provider, order_id, status, amount, created_at) VALUES (?, ?, ?, 'paid', ?, ?)").bind(eventId, provider, order.id, amount, now()).run();
    return json({ ok: true, alreadyPaid: true, orderId: order.id });
  }
  if (order.status !== "pending") return failure("ORDER_NOT_CONFIRMABLE", "Order cannot receive a payment result", 409);
  if (failed) {
    const finalStatus = status === "canceled" ? "cancelled" : "failed";
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'pending'").bind(finalStatus, order.id),
      env.DB.prepare("INSERT INTO payment_events (provider_event_id, provider, order_id, status, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(eventId, provider, order.id, finalStatus, amount, now()),
    ]);
    return json({ ok: true, failed: true, orderId: order.id, status: finalStatus });
  }
  const claim = await env.DB.prepare("UPDATE orders SET status = 'processing' WHERE id = ? AND status = 'pending'").bind(order.id).run();
  if (claim.meta.changes !== 1) return failure("ORDER_PROCESSING", "Order confirmation is already in progress", 409);
  try {
    const subscription = await confirmOrder({ ...order, status: "pending" }, env);
    await env.DB.prepare("INSERT INTO payment_events (provider_event_id, provider, order_id, status, amount, created_at) VALUES (?, ?, ?, 'paid', ?, ?)").bind(eventId, provider, order.id, amount, now()).run();
    return json({ ok: true, orderId: order.id, subscription: subscriptionView(subscription, request, env) });
  } catch (error) {
    await env.DB.prepare("UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'").bind(order.id).run();
    throw error;
  }
}

async function requestData(request) {
  try { return await request.json(); } catch { return {}; }
}

async function setting(env, key, fallback = "") {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first())?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, now()).run();
}

function ticketView(ticket) {
  return { id: ticket.id, subject: ticket.subject, device: ticket.device || "", client: ticket.client || "", description: ticket.description, status: ticket.status, createdAt: ticket.created_at, updatedAt: ticket.updated_at };
}

async function usageHistory(userId, env, limit = 30) {
  return (await env.DB.prepare("SELECT used_gb, total_gb, source, captured_at FROM usage_snapshots WHERE user_id = ? ORDER BY captured_at DESC LIMIT ?").bind(userId, limit).all()).results
    .map((row) => ({ usedGb: Number(row.used_gb), totalGb: Number(row.total_gb), source: row.source, capturedAt: row.captured_at }));
}

async function sendResetEmail(email, token, request, env) {
  const emailConfig = await passwordResetEmailConfig(env);
  if (!emailConfig.apiKey || !emailConfig.from) return false;
  const resetUrl = `${publicBase(request, env)}/?reset=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${emailConfig.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: emailConfig.from,
      to: [email],
      subject: "Reset your CheapVPN password",
      text: `Use this link within 30 minutes to reset your CheapVPN password: ${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error("Password reset email could not be sent");
  return true;
}

async function passwordResetEmailConfig(env) {
  const storedKey = await setting(env, "resend_api_key_encrypted", "");
  return {
    apiKey: env.RESEND_API_KEY || (storedKey ? await decrypt(storedKey, env) : ""),
    from: env.EMAIL_FROM || await setting(env, "email_from", ""),
  };
}

async function adminPasswordMatches(password, env) {
  const storedHash = await setting(env, "admin_password_hash", "");
  return storedHash ? bcrypt.compareSync(password, storedHash) : Boolean(env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD);
}

async function userRoutes(request, env, path) {
  if (request.method === "POST" && path === "/api/auth/register") {
    const body = await requestData(request); const email = String(body.email || "").trim().toLowerCase(); const password = String(body.password || ""); const name = String(body.name || email.split("@")[0] || "Student").trim().slice(0, 80);
    if (!/^\S+@\S+\.\S+$/.test(email)) return failure("INVALID_EMAIL", "Enter a valid email");
    if (password.length < 8) return failure("WEAK_PASSWORD", "Password must be at least 8 characters");
    if (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first()) return failure("EMAIL_EXISTS", "Email is already registered", 409);
    const invite = String(body.referralCode || "").trim().toUpperCase();
    const referrer = invite ? await env.DB.prepare("SELECT id FROM users WHERE referral_code = ?").bind(invite).first() : null;
    if (invite && !referrer) return failure("INVALID_REFERRAL_CODE", "Referral code is not valid");
    try {
      const created = now(); const result = await env.DB.prepare("INSERT INTO users (email, name, password_hash, referral_code, referred_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(email, name || "Student", await passwordHash(password), `STU${randomToken().slice(0, 8).toUpperCase()}`, referrer?.id || null, created).run();
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(result.meta.last_row_id).first();
      return json({ user: safeUser(user), token: await createUserSession(user.id, env) }, 201);
    } catch (error) {
      return failure("REGISTRATION_FAILED", `Unable to create account: ${String(error.message).slice(0, 160)}`, 500);
    }
  }
  if (request.method === "POST" && path === "/api/auth/login") {
    const body = await requestData(request); const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(String(body.email || "").trim().toLowerCase()).first();
    if (!user || !(await passwordMatches(String(body.password || ""), user.password_hash))) return failure("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    return json({ user: safeUser(user), token: await createUserSession(user.id, env) });
  }
  if (request.method === "POST" && path === "/api/auth/password/forgot") {
    const body = await requestData(request); const email = String(body.email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return failure("INVALID_EMAIL", "Enter a valid email");
    const emailConfig = await passwordResetEmailConfig(env);
    if (!emailConfig.apiKey || !emailConfig.from) return failure("PASSWORD_RESET_EMAIL_NOT_CONFIGURED", "Password reset email is not configured yet. Contact support.", 503);
    const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
    if (!user) return json({ ok: true });
    const recent = await env.DB.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = ? AND created_at > ?").bind(user.id, new Date(Date.now() - 15 * 60 * 1000).toISOString()).first();
    if (Number(recent.count) >= 3) return json({ ok: true });
    const token = randomToken("reset_"); const timestamp = now(); const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await digest(token), user.id, expiresAt, timestamp).run();
    try { await sendResetEmail(user.email, token, request, env); } catch (error) { await env.DB.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").bind(await digest(token)).run(); return failure("PASSWORD_RESET_EMAIL_FAILED", String(error.message), 502); }
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/api/auth/password/reset") {
    const body = await requestData(request); const token = String(body.token || ""); const newPassword = String(body.newPassword || "");
    if (newPassword.length < 8) return failure("WEAK_PASSWORD", "Password must be at least 8 characters");
    const tokenHash = await digest(token); const reset = await env.DB.prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(tokenHash, now()).first();
    if (!reset) return failure("INVALID_OR_EXPIRED_RESET_TOKEN", "This password reset link is invalid or expired", 400);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await passwordHash(newPassword), reset.user_id),
      env.DB.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?").bind(now(), tokenHash),
      env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(reset.user_id),
    ]);
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/api/config") return json({ demoAccount: String(env.ALLOW_DEMO_ACCOUNT || "false") === "true" });
  if (request.method === "GET" && path === "/api/plans") return json({ plans: (await env.DB.prepare("SELECT * FROM plans WHERE active = 1 ORDER BY first_month_price").all()).results.map(planView) });
  const auth = await currentUser(request, env);
  if (!auth) return failure("UNAUTHORIZED", "Sign in required", 401);
  if (request.method === "POST" && path === "/api/auth/logout") { await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash = ?").bind(auth.tokenHash).run(); return json({ ok: true }); }
  if (request.method === "GET" && path === "/api/me") {
    const subscription = await subscriptionForUser(auth.user.id, env);
    return json({ user: safeUser(auth.user), subscription: subscriptionView(subscription, request, env) });
  }
  if (request.method === "GET" && path === "/api/usage") {
    const subscription = await subscriptionForUser(auth.user.id, env);
    if (!subscription) return failure("SUBSCRIPTION_NOT_FOUND", "No active subscription found", 404);
    const used = Number(subscription.upstream_used_gb ?? subscription.data_used_gb); const total = Number(subscription.upstream_total_gb ?? subscription.data_total_gb);
    return json({ totalGb: total, usedGb: used, remainingGb: Math.max(0, total - used), deviceLimit: subscription.device_limit, expiresAt: subscription.expires_at, status: subscription.status });
  }
  if (request.method === "GET" && path === "/api/usage/history") return json({ history: await usageHistory(auth.user.id, env) });
  if (request.method === "PATCH" && path === "/api/me/profile") {
    const body = await requestData(request); const name = String(body.name || "").trim().slice(0, 80);
    if (name.length < 2) return failure("INVALID_NAME", "Name must be at least 2 characters");
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, auth.user.id).run();
    return json({ user: safeUser(await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(auth.user.id).first()) });
  }
  if (request.method === "POST" && path === "/api/auth/password") {
    const body = await requestData(request); const currentPassword = String(body.currentPassword || ""); const newPassword = String(body.newPassword || "");
    if (!(await passwordMatches(currentPassword, auth.user.password_hash))) return failure("INVALID_CREDENTIALS", "Current password is incorrect", 401);
    if (newPassword.length < 8) return failure("WEAK_PASSWORD", "Password must be at least 8 characters");
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await passwordHash(newPassword), auth.user.id).run();
    await env.DB.prepare("DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?").bind(auth.user.id, auth.tokenHash).run();
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/api/payment/config") {
    const payment = await paymentConfig(env);
    return json({ mode: payment.mode, mock: payment.mode === "mock", manual: payment.mode === "manual", webhook: payment.mode === "webhook", ready: paymentReady(payment), checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret), manualInstructions: payment.mode === "manual" ? payment.manualInstructions : "", methods: payment.methods });
  }
  if (request.method === "GET" && path === "/api/support/tickets") {
    const tickets = (await env.DB.prepare("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(auth.user.id).all()).results;
    return json({ tickets: tickets.map(ticketView) });
  }
  if (request.method === "POST" && path === "/api/support/tickets") {
    const body = await requestData(request); const subject = String(body.subject || "").trim().slice(0, 120); const description = String(body.description || "").trim().slice(0, 4000);
    if (!subject) return failure("INVALID_TICKET_SUBJECT", "Ticket subject is required");
    if (description.length < 10) return failure("INVALID_TICKET_DESCRIPTION", "Please describe the issue in at least 10 characters");
    const ticket = { id: `TKT-${randomToken().slice(0, 10).toUpperCase()}`, user_id: auth.user.id, subject, device: String(body.device || "").trim().slice(0, 80), client: String(body.client || "").trim().slice(0, 80), description, status: "open", created_at: now(), updated_at: now() };
    await env.DB.prepare("INSERT INTO support_tickets (id, user_id, subject, device, client, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(ticket.id, ticket.user_id, ticket.subject, ticket.device, ticket.client, ticket.description, ticket.status, ticket.created_at, ticket.updated_at).run();
    return json({ ticket: ticketView(ticket) }, 201);
  }
  if (request.method === "GET" && path === "/api/subscription") {
    const subscription = await subscriptionForUser(auth.user.id, env);
    if (!subscription) return failure("SUBSCRIPTION_NOT_FOUND", "No active subscription found", 404);
    return json({ subscription: subscriptionView(subscription, request, env) });
  }
  if (request.method === "POST" && path === "/api/subscription/sync") {
    const subscription = await subscriptionForUser(auth.user.id, env);
    if (!subscription) return failure("SUBSCRIPTION_NOT_FOUND", "No active subscription found", 404);
    try { return json({ subscription: subscriptionView(await syncSubscription(subscription, env), request, env) }); } catch (error) { return failure("UPSTREAM_SYNC_FAILED", String(error.message), 502); }
  }
  if (request.method === "POST" && path === "/api/subscription/reset") {
    const subscription = await subscriptionForUser(auth.user.id, env);
    if (!subscription) return failure("SUBSCRIPTION_NOT_FOUND", "No active subscription found", 404);
    await env.DB.prepare("UPDATE subscriptions SET token = ?, updated_at = ? WHERE id = ?").bind(randomToken("cvpn_"), now(), subscription.id).run();
    return json({ subscription: subscriptionView(await subscriptionForUser(auth.user.id, env), request, env) });
  }
  if (request.method === "GET" && path === "/api/orders") {
    await expirePendingOrders(env);
    const payment = await paymentConfig(env);
    const rows = (await env.DB.prepare("SELECT o.*, p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN payment_submissions ps ON ps.order_id = o.id WHERE o.user_id = ? ORDER BY o.created_at DESC").bind(auth.user.id).all()).results;
    return json({ orders: rows.map((row) => ({ id: row.id, amount: Number(row.amount), status: row.status, kind: row.kind, discountPercent: Number(row.discount_percent || 0), expiresAt: row.expires_at, createdAt: row.created_at, confirmedAt: row.confirmed_at, planName: row.plan_name, checkoutUrl: checkoutUrlFor(row, payment), paymentSubmission: row.submitted_at ? { method: row.payment_method, reference: row.payment_reference, note: row.customer_note || "", submittedAt: row.submitted_at } : null })) });
  }
  if (request.method === "POST" && path === "/api/orders") {
    const payment = await paymentConfig(env);
    if (!paymentReady(payment)) return failure("PAYMENT_NOT_CONFIGURED", "Payment instructions or payment verification are not configured", 503);
    const body = await requestData(request); const requestId = String(request.headers.get("Idempotency-Key") || "").trim().slice(0, 128);
    if (requestId) {
      const replay = await env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND client_request_id = ?").bind(auth.user.id, requestId).first();
      if (replay) return json({ replayed: true, order: { ...replay, checkoutUrl: checkoutUrlFor(replay, payment) }, payment: { mode: payment.mode, instructions: payment.manualInstructions } });
    }
    const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ? AND active = 1").bind(Number(body.planId)).first();
    if (!plan) return failure("PLAN_NOT_FOUND", "Plan is not available", 404);
    await expirePendingOrders(env);
    const pending = await env.DB.prepare("SELECT id FROM orders WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(auth.user.id).first();
    if (pending) return failure("PENDING_ORDER_EXISTS", "There is already a pending order. Cancel it before creating another one.", 409);
    const existing = await subscriptionForUser(auth.user.id, env); const renewal = Boolean(body.renewal && existing);
    const amount = renewal ? Number(plan.renewal_price) : Number(plan.first_month_price); const id = crypto.randomUUID(); const timestamp = now();
    await env.DB.prepare("INSERT INTO orders (id, user_id, plan_id, amount, status, kind, expires_at, created_at, client_request_id) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)").bind(id, auth.user.id, plan.id, amount, renewal ? "renewal" : "new", new Date(Date.now() + 30 * 60 * 1000).toISOString(), timestamp, requestId || null).run();
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
    return json({ order: { ...order, checkoutUrl: checkoutUrlFor(order, payment) }, payment: { mode: payment.mode, instructions: payment.manualInstructions } }, 201);
  }
  const orderMatch = path.match(/^\/api\/orders\/([^/]+)(?:\/(cancel|confirm|payment-submission))?$/);
  if (orderMatch && request.method === "GET" && !orderMatch[2]) {
    await expirePendingOrders(env);
    const payment = await paymentConfig(env);
    const order = await env.DB.prepare("SELECT o.*, p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN payment_submissions ps ON ps.order_id = o.id WHERE o.id = ? AND o.user_id = ?").bind(orderMatch[1], auth.user.id).first();
    if (!order) return failure("ORDER_NOT_FOUND", "Order not found", 404);
    return json({ order: { id: order.id, amount: Number(order.amount), status: order.status, kind: order.kind, discountPercent: Number(order.discount_percent || 0), expiresAt: order.expires_at, createdAt: order.created_at, confirmedAt: order.confirmed_at, planName: order.plan_name, checkoutUrl: checkoutUrlFor(order, payment), paymentSubmission: order.submitted_at ? { method: order.payment_method, reference: order.payment_reference, note: order.customer_note || "", submittedAt: order.submitted_at } : null } });
  }
  if (orderMatch && request.method === "POST" && orderMatch[2] === "cancel") {
    const result = await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").bind(orderMatch[1], auth.user.id).run();
    return result.meta.changes === 1 ? json({ ok: true }) : failure("ORDER_NOT_CANCELLABLE", "Only pending orders can be cancelled", 409);
  }
  if (orderMatch && request.method === "POST" && orderMatch[2] === "confirm") {
    const payment = await paymentConfig(env);
    if (payment.mode !== "mock") return failure("MOCK_PAYMENT_DISABLED", "This order requires the configured payment flow", 409);
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(orderMatch[1], auth.user.id).first();
    if (!order) return failure("ORDER_NOT_FOUND", "Order not found", 404);
    if (order.status === "paid") return json({ ok: true, alreadyPaid: true, subscription: subscriptionView(await subscriptionForUser(auth.user.id, env), request, env) });
    if (order.status !== "pending") return failure("ORDER_NOT_CONFIRMABLE", "Order cannot be confirmed", 409);
    return json({ subscription: subscriptionView(await confirmOrder(order, env), request, env) });
  }
  if (orderMatch && request.method === "POST" && orderMatch[2] === "payment-submission") {
    const payment = await paymentConfig(env);
    if (payment.mode !== "manual") return failure("PAYMENT_SUBMISSION_NOT_AVAILABLE", "Payment references are only used for manual payment", 409);
    await expirePendingOrders(env);
    const order = await env.DB.prepare("SELECT id, status FROM orders WHERE id = ? AND user_id = ?").bind(orderMatch[1], auth.user.id).first();
    if (!order) return failure("ORDER_NOT_FOUND", "Order not found", 404);
    if (order.status !== "pending") return failure("ORDER_NOT_SUBMITTABLE", "Only pending orders can submit payment information", 409);
    const body = await requestData(request); const reference = String(body.reference || "").trim().slice(0, 160); const note = String(body.note || "").trim().slice(0, 1000); const method = String(body.method || "").trim();
    if (reference.length < 3) return failure("INVALID_PAYMENT_REFERENCE", "Enter a payment reference or transfer number");
    if (!payment.methods.some((item) => item.id === method)) return failure("INVALID_PAYMENT_METHOD", "Select an available payment method");
    await env.DB.prepare("INSERT INTO payment_submissions (order_id, payment_method, payment_reference, customer_note, submitted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET payment_method = excluded.payment_method, payment_reference = excluded.payment_reference, customer_note = excluded.customer_note, submitted_at = excluded.submitted_at").bind(order.id, method, reference, note || null, now()).run();
    return json({ ok: true, submittedAt: now() });
  }
  if (request.method === "GET" && path === "/api/referral") return json({ code: auth.user.referral_code, link: `${publicBase(request, env)}/?ref=${auth.user.referral_code}`, rewardPercent: 10 });
  return null;
}

async function adminRoutes(request, env, path) {
  if (request.method === "POST" && path === "/api/admin/auth/login") {
    const body = await requestData(request);
    if (!(await adminPasswordMatches(String(body.password || ""), env))) return failure("INVALID_ADMIN_CREDENTIALS", "Admin password is incorrect", 401);
    return json({ token: await createAdminSession(env) });
  }
  const admin = await currentAdmin(request, env);
  if (!admin) return failure("UNAUTHORIZED", "Administrator sign in required", 401);
  if (request.method === "POST" && path === "/api/admin/auth/logout") { await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(admin.tokenHash).run(); return json({ ok: true }); }
  if (request.method === "POST" && path === "/api/admin/auth/password") {
    const body = await requestData(request); const currentPassword = String(body.currentPassword || ""); const newPassword = String(body.newPassword || "");
    if (!(await adminPasswordMatches(currentPassword, env))) return failure("INVALID_ADMIN_CREDENTIALS", "Current admin password is incorrect", 401);
    if (newPassword.length < 12) return failure("WEAK_ADMIN_PASSWORD", "Admin password must be at least 12 characters", 400);
    await setSetting(env, "admin_password_hash", bcrypt.hashSync(newPassword, 12));
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash != ?").bind(admin.tokenHash).run();
    return json({ ok: true });
  }
  if (request.method === "GET" && path === "/api/admin/overview") {
    await expireSubscriptions(env); const metrics = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS activeSubscriptions, COALESCE((SELECT SUM(data_used_gb) FROM subscriptions WHERE status = 'active'), 0) AS usedGb, COALESCE((SELECT SUM(p.data_total_gb) FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status = 'active'), 0) AS totalGb").first();
    const sources = (await env.DB.prepare("SELECT * FROM upstream_sources ORDER BY is_default DESC, id ASC").all()).results;
    return json({ metrics, upstream: { configured: sources.some((source) => source.enabled), count: sources.length }, sources: await Promise.all(sources.map((source) => sourceView(source, env))) });
  }
  if (request.method === "GET" && path === "/api/admin/system") {
    const sources = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM upstream_sources").first();
    const payment = await paymentConfig(env);
    const usageUrl = await setting(env, "usage_api_url_encrypted", "");
    const emailConfig = await passwordResetEmailConfig(env);
    const storedAdminPassword = await setting(env, "admin_password_hash", "");
    return json({ publicBaseUrl: env.PUBLIC_BASE_URL || "", payment: { mode: payment.mode, ready: paymentReady(payment), productionReady: payment.mode !== "mock" && paymentReady(payment), checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret) }, upstream: { configured: Boolean(sources.total), total: Number(sources.total || 0), enabled: Number(sources.enabled || 0), assignmentMode: await setting(env, "upstream_assignment_mode", "default") }, usage: { apiConfigured: Boolean(usageUrl), automaticSync: false, syncIntervalMs: Number(await setting(env, "usage_sync_interval_ms", "0")) }, email: { configured: Boolean(emailConfig.apiKey && emailConfig.from) }, security: { encryptionKeyConfigured: Boolean(env.ADMIN_ENCRYPTION_KEY), adminPasswordStrong: Boolean(storedAdminPassword || (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 12)) } });
  }
  if (request.method === "GET" && path === "/api/admin/settings/payment") {
    const payment = await paymentConfig(env);
    return json({ mode: payment.mode, checkoutTemplate: payment.checkoutTemplate, manualInstructions: payment.manualInstructions, methods: payment.methods, checkoutConfigured: Boolean(payment.checkoutTemplate), webhookConfigured: Boolean(payment.webhookSecret), manualInstructionsConfigured: Boolean(payment.manualInstructions) });
  }
  if (request.method === "PUT" && path === "/api/admin/settings/payment") {
    const body = await requestData(request); const mode = String(body.mode || "manual");
    if (!["mock", "manual", "webhook"].includes(mode)) return failure("INVALID_PAYMENT_MODE", "Payment mode must be mock, manual or webhook");
    const current = await paymentConfig(env); const checkoutTemplate = Object.hasOwn(body, "checkoutTemplate") ? String(body.checkoutTemplate || "").trim().slice(0, 1000) : current.checkoutTemplate; const manualInstructions = Object.hasOwn(body, "manualInstructions") ? String(body.manualInstructions || "").trim().slice(0, 2000) : current.manualInstructions; const webhookSecret = String(body.webhookSecret || "").trim(); const methodIds = Array.isArray(body.methodIds) ? [...new Set(body.methodIds.map((value) => String(value)).filter((value) => paymentMethodCatalog.some((method) => method.id === value)))].slice(0, paymentMethodCatalog.length) : current.methods.map((method) => method.id);
    if (checkoutTemplate && !validCheckoutTemplate(checkoutTemplate)) return failure("INVALID_CHECKOUT_URL", "Checkout URL template must use http or https");
    if (!methodIds.length) return failure("PAYMENT_METHOD_REQUIRED", "Select at least one payment method");
    await setSetting(env, "payment_mode", mode); await setSetting(env, "payment_manual_instructions", manualInstructions); await setSetting(env, "payment_checkout_template", checkoutTemplate); await setSetting(env, "payment_method_ids", JSON.stringify(methodIds));
    if (body.clearWebhookSecret) await env.DB.prepare("DELETE FROM settings WHERE key = 'payment_webhook_secret_encrypted'").run(); else if (webhookSecret) await setSetting(env, "payment_webhook_secret_encrypted", await encrypt(webhookSecret, env));
    const saved = await paymentConfig(env);
    return json({ ok: true, mode: saved.mode, methods: saved.methods, ready: paymentReady(saved), checkoutConfigured: Boolean(saved.checkoutTemplate), webhookConfigured: Boolean(saved.webhookSecret), manualInstructionsConfigured: Boolean(saved.manualInstructions) });
  }
  if (request.method === "GET" && path === "/api/admin/settings/usage") return json({ apiConfigured: Boolean(await setting(env, "usage_api_url_encrypted", "")), url: "", tokenConfigured: Boolean(await setting(env, "usage_api_token_encrypted", "")), syncIntervalMs: Number(await setting(env, "usage_sync_interval_ms", "0")) });
  if (request.method === "PUT" && path === "/api/admin/settings/usage") {
    const body = await requestData(request); const interval = Number(body.syncIntervalMs || 0);
    if (!Number.isInteger(interval) || (interval !== 0 && interval < 300000)) return failure("INVALID_USAGE_INTERVAL", "Cloudflare scheduled sync must be disabled or at least 5 minutes");
    if (body.clearUrl) await env.DB.prepare("DELETE FROM settings WHERE key = 'usage_api_url_encrypted'").run(); else if (body.url) await setSetting(env, "usage_api_url_encrypted", await encrypt(String(body.url).trim(), env));
    if (body.clearToken) await env.DB.prepare("DELETE FROM settings WHERE key = 'usage_api_token_encrypted'").run(); else if (body.token) await setSetting(env, "usage_api_token_encrypted", await encrypt(String(body.token).trim(), env));
    await setSetting(env, "usage_sync_interval_ms", String(interval)); return json({ ok: true, syncIntervalMs: interval });
  }
  if (request.method === "GET" && path === "/api/admin/settings/email") { const config = await passwordResetEmailConfig(env); return json({ configured: Boolean(config.apiKey && config.from), resendConfigured: Boolean(config.apiKey), from: config.from || "" }); }
  if (request.method === "PUT" && path === "/api/admin/settings/email") {
    const body = await requestData(request); const from = String(body.from || "").trim().slice(0, 180); const resendApiKey = String(body.resendApiKey || "").trim();
    if (from && !/^.+<\S+@\S+>$|^\S+@\S+$/.test(from)) return failure("INVALID_EMAIL_FROM", "Sender must be an email address or Name <email@example.com>");
    if (resendApiKey) await setSetting(env, "resend_api_key_encrypted", await encrypt(resendApiKey, env));
    if (body.clearResendApiKey) await env.DB.prepare("DELETE FROM settings WHERE key = 'resend_api_key_encrypted'").run();
    if (from) await setSetting(env, "email_from", from); else if (body.clearFrom) await env.DB.prepare("DELETE FROM settings WHERE key = 'email_from'").run();
    const config = await passwordResetEmailConfig(env); return json({ ok: true, configured: Boolean(config.apiKey && config.from), resendConfigured: Boolean(config.apiKey), from: config.from || "" });
  }
  if (request.method === "GET" && path === "/api/admin/plans") return json({ plans: (await env.DB.prepare("SELECT * FROM plans ORDER BY id").all()).results.map(planView) });
  if (request.method === "POST" && path === "/api/admin/plans") {
    const body = await requestData(request); const result = await env.DB.prepare("INSERT INTO plans (slug, name, first_month_price, renewal_price, data_total_gb, device_limit, billing_period_months, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(String(body.slug || "").trim(), String(body.name || "").trim(), Number(body.firstMonthPrice), Number(body.renewalPrice), Number(body.dataTotalGb), Number(body.deviceLimit), Number(body.billingPeriodMonths || 1), body.active === false ? 0 : 1).run();
    return json({ plan: planView(await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(result.meta.last_row_id).first()) }, 201);
  }
  const planMatch = path.match(/^\/api\/admin\/plans\/(\d+)$/);
  if (planMatch && request.method === "PUT") { const body = await requestData(request); await env.DB.prepare("UPDATE plans SET name = COALESCE(?, name), first_month_price = COALESCE(?, first_month_price), renewal_price = COALESCE(?, renewal_price), data_total_gb = COALESCE(?, data_total_gb), device_limit = COALESCE(?, device_limit), billing_period_months = COALESCE(?, billing_period_months), active = COALESCE(?, active) WHERE id = ?").bind(body.name ?? null, body.firstMonthPrice ?? null, body.renewalPrice ?? null, body.dataTotalGb ?? null, body.deviceLimit ?? null, body.billingPeriodMonths ?? null, typeof body.active === "boolean" ? Number(body.active) : null, Number(planMatch[1])).run(); return json({ ok: true }); }
  if (request.method === "GET" && path === "/api/admin/upstream") { const sources = (await env.DB.prepare("SELECT * FROM upstream_sources ORDER BY is_default DESC, id ASC").all()).results; return json({ sources: await Promise.all(sources.map((source) => sourceView(source, env))) }); }
  if (request.method === "POST" && path === "/api/admin/sources") {
    const body = await requestData(request); const url = String(body.url || "").trim(); if (!/^https?:\/\//.test(url)) return failure("INVALID_UPSTREAM_URL", "Enter a valid HTTPS or HTTP subscription URL");
    const timestamp = now(); const result = await env.DB.prepare("INSERT INTO upstream_sources (name, url_encrypted, universal_url_encrypted, clash_url_encrypted, singbox_url_encrypted, enabled, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)").bind(String(body.name || "Upstream").trim().slice(0, 100), await encrypt(url, env), await encrypt(url, env), body.clashUrl ? await encrypt(String(body.clashUrl), env) : null, body.singboxUrl ? await encrypt(String(body.singboxUrl), env) : null, (await env.DB.prepare("SELECT COUNT(*) AS count FROM upstream_sources").first()).count === 0 ? 1 : 0, timestamp, timestamp).run();
    return json({ source: await sourceView(await env.DB.prepare("SELECT * FROM upstream_sources WHERE id = ?").bind(result.meta.last_row_id).first(), env) }, 201);
  }
  const sourceMatch = path.match(/^\/api\/admin\/sources\/(\d+)(?:\/(sync))?$/);
  if (sourceMatch && request.method === "POST" && sourceMatch[2] === "sync") { const source = await env.DB.prepare("SELECT * FROM upstream_sources WHERE id = ?").bind(Number(sourceMatch[1])).first(); if (!source) return failure("SOURCE_NOT_FOUND", "Source not found", 404); const subscriptions = (await env.DB.prepare("SELECT * FROM subscriptions WHERE source_id = ?").bind(source.id).all()).results; const results = await Promise.allSettled(subscriptions.map((subscription) => syncSubscription(subscription, env))); return json({ ok: true, synced: results.filter((result) => result.status === "fulfilled").length, failed: results.filter((result) => result.status === "rejected").length }); }
  if (sourceMatch && request.method === "PUT") { const body = await requestData(request); if (body.isDefault) await env.DB.prepare("UPDATE upstream_sources SET is_default = 0").run(); await env.DB.prepare("UPDATE upstream_sources SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), is_default = COALESCE(?, is_default), updated_at = ? WHERE id = ?").bind(body.name ?? null, typeof body.enabled === "boolean" ? Number(body.enabled) : null, typeof body.isDefault === "boolean" ? Number(body.isDefault) : null, now(), Number(sourceMatch[1])).run(); return json({ ok: true }); }
  if (sourceMatch && request.method === "DELETE") { await env.DB.prepare("DELETE FROM upstream_sources WHERE id = ?").bind(Number(sourceMatch[1])).run(); return json({ ok: true }); }
  if (request.method === "GET" && path === "/api/admin/users") {
    const query = new URL(request.url).searchParams; const q = String(query.get("q") || "").trim().toLowerCase().slice(0, 80); const page = Math.max(1, Number(query.get("page")) || 1); const pageSize = Math.min(100, Math.max(1, Number(query.get("pageSize")) || 50));
    const where = q ? "WHERE lower(u.name) LIKE ? OR lower(u.email) LIKE ?" : ""; const values = q ? [`%${q}%`, `%${q}%`] : [];
    const total = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).bind(...values).first()).count;
    const rows = (await env.DB.prepare(`SELECT u.id, u.name, u.email, s.status AS subscription_status, s.token, s.data_used_gb, s.upstream_used_gb, s.usage_source, s.expires_at, s.last_sync_at, s.last_sync_status, p.data_total_gb, p.device_limit, p.billing_period_months, p.name AS plan_name, us.name AS source_name FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN upstream_sources us ON us.id = s.source_id ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).bind(...values, pageSize, (page - 1) * pageSize).all()).results;
    return json({ users: rows.map((row) => ({ id: row.id, name: row.name, email: row.email, subscriptionStatus: row.subscription_status || "inactive", token: row.token ? `${row.token.slice(0, 10)}****${row.token.slice(-4)}` : "-", usedGb: Number(row.upstream_used_gb ?? row.data_used_gb ?? 0), totalGb: Number(row.data_total_gb || 0), devices: Number(row.device_limit || 0), expiresAt: row.expires_at || "-", usageSource: row.usage_source || "manual", periodMonths: Number(row.billing_period_months || 1), planName: row.plan_name || "-", sourceName: row.source_name || "" })), pagination: { page, pageSize, total: Number(total), pages: Math.max(1, Math.ceil(Number(total) / pageSize)), query: q } });
  }
  if (request.method === "GET" && path === "/api/admin/orders") {
    await expirePendingOrders(env);
    const rows = (await env.DB.prepare("SELECT o.*, u.name AS user_name, u.email AS user_email, p.name AS plan_name, ps.payment_method, ps.payment_reference, ps.customer_note, ps.submitted_at FROM orders o JOIN users u ON u.id = o.user_id JOIN plans p ON p.id = o.plan_id LEFT JOIN payment_submissions ps ON ps.order_id = o.id ORDER BY o.created_at DESC LIMIT 200").all()).results;
    return json({ orders: rows.map((row) => ({ id: row.id, amount: Number(row.amount), status: row.status, kind: row.kind, discountPercent: Number(row.discount_percent || 0), planName: row.plan_name, createdAt: row.created_at, expiresAt: row.expires_at, user: { name: row.user_name, email: row.user_email }, paymentSubmission: row.submitted_at ? { method: row.payment_method, reference: row.payment_reference, note: row.customer_note || "", submittedAt: row.submitted_at } : null })), pagination: { page: 1, pageSize: 200, total: rows.length, pages: 1 } });
  }
  if (request.method === "GET" && path === "/api/admin/tickets") {
    const rows = (await env.DB.prepare("SELECT t.*, u.name AS user_name, u.email FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.updated_at DESC LIMIT 200").all()).results;
    return json({ tickets: rows.map((row) => ({ ...ticketView(row), user: { name: row.user_name, email: row.email } })) });
  }
  const ticketMatch = path.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (ticketMatch && request.method === "PATCH") { const body = await requestData(request); const status = String(body.status || ""); if (!["open", "in_progress", "resolved", "closed"].includes(status)) return failure("INVALID_TICKET_STATUS", "Invalid ticket status"); await env.DB.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").bind(status, now(), ticketMatch[1]).run(); return json({ ok: true, status }); }
  const orderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/(confirm|cancel)$/);
  if (orderMatch && request.method === "POST") { const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderMatch[1]).first(); if (!order) return failure("ORDER_NOT_FOUND", "Order not found", 404); if (orderMatch[2] === "cancel") { await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(order.id).run(); return json({ ok: true }); } if ((await paymentConfig(env)).mode !== "manual") return failure("MANUAL_CONFIRMATION_DISABLED", "Manual confirmation is only available in manual payment mode", 409); if (order.status === "paid") return json({ ok: true, alreadyPaid: true, orderId: order.id }); if (order.status !== "pending") return failure("ORDER_NOT_CONFIRMABLE", "Order cannot be confirmed", 409); return json({ subscription: subscriptionView(await confirmOrder(order, env), request, env) }); }
  return null;
}

async function servePublicSubscription(request, env, path) {
  const match = path.match(/^\/s(?:\/(clash|singbox))?\/([^/]+)$/);
  if (!match) return null;
  await expireSubscriptions(env); const subscription = await env.DB.prepare("SELECT * FROM subscriptions WHERE token = ? AND status = 'active'").bind(match[2]).first();
  if (!subscription) return new Response("Subscription not found or expired", { status: 404 });
  const format = match[1] === "clash" ? "clash_content" : match[1] === "singbox" ? "singbox_content" : "universal_content";
  const contentType = format === "clash_content" ? "text/yaml; charset=utf-8" : format === "singbox_content" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  return new Response(subscription[format] || "", { headers: { "content-type": contentType, "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url); const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": url.origin, "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,idempotency-key" } });
    if (path === "/health") return json({ ok: true, service: "cheapvpn-edge" });
    if (path === "/health/ready") return json({ ok: Boolean(env.ADMIN_PASSWORD && env.ADMIN_ENCRYPTION_KEY), service: "cheapvpn-edge" }, env.ADMIN_PASSWORD && env.ADMIN_ENCRYPTION_KEY ? 200 : 503);
    if (path === "/api/webhooks/payment" && request.method === "POST") {
      try { return await paymentWebhook(request, env); } catch (error) { return failure("PAYMENT_WEBHOOK_FAILED", String(error.message || "Payment webhook failed"), 502); }
    }
    const subscription = await servePublicSubscription(request, env, path); if (subscription) return subscription;
    const admin = path.startsWith("/api/admin/") ? await adminRoutes(request, env, path) : null; if (admin) return admin;
    const api = path.startsWith("/api/") ? await userRoutes(request, env, path) : null; if (api) return api;
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env) {
    await expireSubscriptions(env);
    await expirePendingOrders(env);
    await env.DB.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").bind(now()).run();
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now()).run();
    await env.DB.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").bind(now()).run();
  }
};

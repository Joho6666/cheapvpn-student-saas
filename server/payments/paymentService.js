import crypto from "node:crypto";
import {
  paymentProviderModeDefault, paymentProvidersDefault, wechatPayConfig, alipayConfig,
  productionRuntime, publicBaseUrl,
} from "../config/env.js";
import { createPaymentRepository } from "./repository.js";
import { createCompletePayment } from "./completePayment.js";
import { MockPaymentProvider } from "./providers/mock.js";
import { WechatPayProvider } from "./providers/wechatPay.js";
import { AlipayProvider } from "./providers/alipay.js";

const QUERY_MIN_AGE_MS = 10 * 1000;
const QUERY_THROTTLE_MS = 8 * 1000;
const PAYMENT_TTL_MS = 15 * 60 * 1000;

export function paymentId() {
  return crypto.randomUUID().replaceAll("-", "");
}

export function wechatConfigured(config = wechatPayConfig) {
  return Boolean(config.enabled && config.appId && config.mchId && config.certSerialNo && config.privateKey && config.apiV3Key && config.publicKey);
}

export function alipayConfigured(config = alipayConfig) {
  return Boolean(config.enabled && config.appId && config.privateKey && config.publicKey);
}

export function nativeProvidersReady({ providerMode = paymentProviderModeDefault, production = productionRuntime } = {}) {
  if (providerMode === "mock") return !production;
  return wechatConfigured() || alipayConfigured();
}

export function createPaymentService({ db, now, toCents, apiError, logEvent, activatePaidOrder }) {
  const repository = createPaymentRepository(db);
  const { completePayment } = createCompletePayment({ db, repository, now, toCents, apiError, logEvent });
  const mockProvider = new MockPaymentProvider();
  const wechatProvider = new WechatPayProvider({ config: wechatPayConfig, toCents });
  const alipayProvider = new AlipayProvider({ config: alipayConfig });

  function providerMode() {
    if (productionRuntime) return "live";
    return paymentProviderModeDefault;
  }

  function enabledProviders() {
    const requested = paymentProvidersDefault.length ? paymentProvidersDefault : ["wechat", "alipay"];
    if (providerMode() === "mock") return requested;
    return requested.filter((name) => (name === "wechat" ? wechatConfigured() : alipayConfigured()));
  }

  function getProvider(name) {
    if (providerMode() === "mock") return mockProvider;
    if (name === "wechat") return wechatProvider;
    if (name === "alipay") return alipayProvider;
    const error = apiError("PAYMENT_PROVIDER_UNSUPPORTED", "Payment provider is not supported", 400);
    throw error;
  }

  function notifyUrl(provider) {
    if (provider === "wechat") return wechatPayConfig.notifyUrl || `${publicBaseUrl}/api/payments/wechat/notify`;
    if (provider === "alipay") return alipayConfig.notifyUrl || `${publicBaseUrl}/api/payments/alipay/notify`;
    return "";
  }

  function customerPaymentView(payment, order, extra = {}) {
    return {
      paymentId: payment.id,
      provider: payment.provider,
      qrContent: payment.qr_content,
      amount: payment.amount,
      status: extra.status || payment.status,
      expiresAt: payment.expires_at,
      activationStatus: order?.activation_status || "none",
      ...extra,
    };
  }

  function mapPublicStatus(order, payment) {
    if (!payment) {
      if (order?.status === "paid" && order.activation_status === "active") return "active";
      if (order?.status === "paid") return order.activation_status === "failed" ? "failed" : "paid";
      return order?.status || "pending";
    }
    if (payment.status === "expired" || payment.status === "closed") return "expired";
    if (payment.status === "failed") return "failed";
    if (payment.status === "paid" || order?.status === "paid") {
      if (order?.activation_status === "active") return "active";
      if (order?.activation_status === "failed") return "failed";
      if (order?.activation_status === "activating") return "activating";
      return "paid";
    }
    return "pending";
  }

  async function fulfill(result, baseUrl) {
    if (result.duplicate && result.order?.activation_status === "active") return result;
    try {
      const activation = await activatePaidOrder(result.order, baseUrl);
      return { ...result, ...activation, order: activation.order || result.order };
    } catch (error) {
      logEvent("payment.activation_failed", {
        orderId: result.order.id, provider: result.payment?.provider || "", status: "retrying", success: false,
        reason: error.code || "ACTIVATION_FAILED", message: String(error.message || "").slice(0, 180),
      }, "warn");
      const latest = db.prepare("SELECT * FROM orders WHERE id = ?").get(result.order.id);
      return { ...result, order: latest, activationError: error };
    }
  }

  async function closeProviderPayment(payment) {
    if (!payment || payment.status !== "pending") return;
    try {
      await getProvider(payment.provider).closePayment({ payment });
    } catch {
      logEvent("payment.close_failed", { paymentId: payment.id, provider: payment.provider, orderId: payment.order_id, success: false }, "warn");
    }
  }

  async function createPayment({ order, provider, description }) {
    const name = String(provider || "").trim().toLowerCase();
    if (!["wechat", "alipay"].includes(name)) throw apiError("INVALID_PAYMENT_PROVIDER", "Provider must be wechat or alipay");
    if (!enabledProviders().includes(name) && providerMode() !== "mock") {
      throw apiError("PAYMENT_PROVIDER_NOT_READY", "This payment provider is not configured", 503);
    }
    if (order.status !== "pending") throw apiError("ORDER_NOT_PAYABLE", "Only pending orders can create a payment", 409);
    const existing = repository.activePendingPayment(order.id);
    if (existing && existing.provider === name && existing.qr_content && new Date(existing.expires_at).getTime() > Date.now()) {
      return customerPaymentView(existing, order, { status: "pending" });
    }
    if (existing) {
      await closeProviderPayment(existing);
      repository.updatePayment(existing.id, { status: "closed", raw_status: "closed" });
    }
    const createdAt = now();
    const orderExpiry = order.expires_at ? new Date(order.expires_at).getTime() : Date.now() + PAYMENT_TTL_MS;
    const expiresAt = new Date(Math.min(orderExpiry, Date.now() + PAYMENT_TTL_MS)).toISOString();
    const payment = repository.insertPayment({
      id: paymentId(),
      order_id: order.id,
      provider: name,
      amount: order.amount,
      currency: "CNY",
      status: "pending",
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    });
    try {
      const created = await getProvider(name).createPayment({
        order, payment, description, notifyUrl: notifyUrl(name),
      });
      const saved = repository.updatePayment(payment.id, {
        qr_content: created.qrContent,
        provider_order_id: created.providerOrderId || payment.id,
        raw_status: created.rawStatus || "pending",
      });
      logEvent("payment.created", { orderId: order.id, paymentId: saved.id, provider: name, status: "pending", success: true });
      return customerPaymentView(saved, order, { status: "pending" });
    } catch (error) {
      repository.updatePayment(payment.id, { status: "failed", last_error: String(error.message || error).slice(0, 300), raw_status: "failed" });
      throw apiError(error.code || "PAYMENT_CREATE_FAILED", "Unable to create payment", error.status || 502);
    }
  }

  async function applyProviderResult(payment, queried) {
    if (!queried?.paid) {
      if (queried?.status === "closed" || queried?.status === "failed") {
        repository.updatePayment(payment.id, { status: queried.status, raw_status: queried.rawStatus || queried.status, last_query_at: now() });
      } else {
        repository.updatePayment(payment.id, { last_query_at: now(), raw_status: queried?.rawStatus || payment.raw_status });
      }
      return repository.getPayment(payment.id);
    }
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.order_id);
    const completed = completePayment({
      provider: payment.provider,
      providerTradeNo: queried.providerTradeNo,
      orderId: order.id,
      amount: order.amount,
      paidAt: queried.paidAt || now(),
      eventId: `${payment.provider}:${queried.providerTradeNo || payment.id}:${payment.id}`,
      paymentId: payment.id,
    });
    await fulfill(completed);
    return repository.getPayment(payment.id);
  }

  async function queryPayment({ payment, force = false }) {
    const latest = repository.getPayment(payment.id);
    if (!latest) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
    if (latest.status !== "pending") return latest;
    const createdAge = Date.now() - new Date(latest.created_at).getTime();
    const lastQuery = latest.last_query_at ? Date.now() - new Date(latest.last_query_at).getTime() : Number.POSITIVE_INFINITY;
    if (!force && (createdAge < QUERY_MIN_AGE_MS || lastQuery < QUERY_THROTTLE_MS)) return latest;
    try {
      const queried = await getProvider(latest.provider).queryPayment({ payment: latest });
      return applyProviderResult(latest, queried);
    } catch (error) {
      repository.updatePayment(latest.id, { last_query_at: now(), last_error: String(error.message || error).slice(0, 300) });
      return repository.getPayment(latest.id);
    }
  }

  async function statusForUser({ paymentId: id, userId, force = false }) {
    const payment = repository.getPayment(id);
    if (!payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(payment.order_id, userId);
    if (!order) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
    const refreshed = payment.status === "pending" ? await queryPayment({ payment, force }) : payment;
    const latestOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
    const status = mapPublicStatus(latestOrder, refreshed);
    const payload = customerPaymentView(refreshed, latestOrder, { status });
    if (status === "active") {
      payload.subscriptionReady = true;
    }
    return payload;
  }

  async function handleProviderWebhook(providerName, request) {
    const adapter = providerName === "wechat" ? wechatProvider : alipayProvider;
    if (!adapter.configured() && providerMode() !== "mock") {
      throw apiError("PAYMENT_PROVIDER_NOT_READY", "This payment provider is not configured", 503);
    }
    let parsed;
    if (providerName === "wechat") parsed = wechatProvider.verifyNotify(request);
    else parsed = { params: alipayProvider.parseNotify(request) };

    const outTradeNo = providerName === "wechat" ? parsed.resource.out_trade_no : parsed.params.out_trade_no;
    const payment = repository.getPayment(outTradeNo);
    if (!payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.order_id);
    if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
    const handled = await adapter.handleWebhook({ request, order, payment });
    if (!handled.paid) {
      repository.updatePayment(payment.id, { raw_status: handled.rawStatus || payment.raw_status, last_query_at: now() });
      return { ok: true, pending: true, orderId: order.id };
    }
    const completed = completePayment({
      provider: providerName,
      providerTradeNo: handled.providerTradeNo,
      orderId: order.id,
      amount: handled.amount,
      paidAt: handled.paidAt || now(),
      eventId: handled.eventId,
      paymentId: payment.id,
    });
    const fulfilled = await fulfill(completed);
    return { ok: true, orderId: order.id, duplicate: Boolean(fulfilled.duplicate), alreadyPaid: Boolean(fulfilled.alreadyPaid), activationStatus: fulfilled.order?.activation_status };
  }

  async function mockSuccess({ paymentId: id, production }) {
    if (production || providerMode() !== "mock") {
      throw apiError("MOCK_PAYMENT_DISABLED", "Mock payment success is disabled", 403);
    }
    const payment = repository.getPayment(id);
    if (!payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
    mockProvider.markPaid(id);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(payment.order_id);
    const completed = completePayment({
      provider: payment.provider,
      providerTradeNo: `mock_${payment.id}`,
      orderId: order.id,
      amount: order.amount,
      paidAt: now(),
      eventId: `mock:${payment.id}:${order.id}`,
      paymentId: payment.id,
    });
    return fulfill(completed);
  }

  async function expireStalePayments() {
    const due = repository.listDuePayments(now());
    for (const payment of due) {
      await closeProviderPayment(payment);
      repository.updatePayment(payment.id, { status: "expired", raw_status: "expired" });
    }
    return due.length;
  }

  async function closeOrderPayments(orderId) {
    const pending = repository.activePendingPayment(orderId);
    if (pending) {
      await closeProviderPayment(pending);
      repository.updatePayment(pending.id, { status: "closed", raw_status: "closed" });
    }
  }

  function listAdminPayments({ q = "", status = "", page = 1, pageSize = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (q) {
      clauses.push("(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(o.id) LIKE ? OR lower(p.id) LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status === "activation_failed") {
      clauses.push("o.status = 'paid' AND o.activation_status IN ('failed', 'retrying', 'pending')");
    } else if (status) {
      clauses.push("p.status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS count FROM payments p
      JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id JOIN plans pl ON pl.id = o.plan_id ${where}`).get(...params).count;
    const payments = db.prepare(`SELECT p.*, o.status AS order_status, o.activation_status, o.activation_error, o.activation_attempts,
      o.confirmed_at, o.amount AS order_amount, u.name, u.email, pl.name AS plan_name
      FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id JOIN plans pl ON pl.id = o.plan_id
      ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    const today = new Date().toISOString().slice(0, 10);
    const summary = {
      todayOrders: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE substr(created_at, 1, 10) = ?").get(today).count,
      todayRevenue: db.prepare("SELECT COALESCE(SUM(amount), 0) AS revenue FROM orders WHERE status = 'paid' AND substr(COALESCE(confirmed_at, created_at), 1, 10) = ?").get(today).revenue,
      paid: db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'paid'").get().count,
      pending: db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'pending'").get().count,
      failed: db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'failed'").get().count,
      unpaidActivation: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'paid' AND activation_status IN ('pending', 'retrying', 'failed', 'activating')").get().count,
    };
    return {
      summary,
      payments: payments.map((row) => ({
        id: row.id, orderId: row.order_id, provider: row.provider, amount: row.amount, status: row.status,
        orderStatus: row.order_status, activationStatus: row.activation_status, activationError: row.activation_error,
        activationAttempts: row.activation_attempts, providerTradeNo: row.provider_trade_no,
        user: { name: row.name, email: row.email }, planName: row.plan_name,
        createdAt: row.created_at, paidAt: row.paid_at, expiresAt: row.expires_at,
      })),
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) || 1 },
    };
  }

  return {
    repository, mockProvider, wechatProvider, alipayProvider, completePayment, createPayment,
    queryPayment, statusForUser, handleProviderWebhook, mockSuccess, expireStalePayments,
    closeOrderPayments, listAdminPayments, fulfill, enabledProviders, providerMode, mapPublicStatus,
    handleHmacWebhook: async (req, { webhookSecret, expirePendingOrders: expireOrders }) => {
      if (!webhookSecret) throw apiError("PAYMENT_WEBHOOK_NOT_CONFIGURED", "Payment webhook secret is not configured", 503);
      const signature = String(req.headers["x-cheapvpn-signature"] || "");
      const expected = crypto.createHmac("sha256", webhookSecret).update(req.rawBody || Buffer.from(JSON.stringify(req.body || {}))).digest("hex");
      if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        throw apiError("INVALID_PAYMENT_SIGNATURE", "Payment signature is invalid", 401);
      }
      const provider = String(req.body?.provider || "external").slice(0, 40);
      const eventId = String(req.body?.eventId || req.body?.id || "").trim().slice(0, 160);
      const inboundOrderId = String(req.body?.orderId || "").trim();
      const status = String(req.body?.status || "").toLowerCase();
      const amount = Number(req.body?.amount);
      const successful = ["paid", "succeeded"].includes(status);
      const failed = ["failed", "cancelled", "canceled"].includes(status);
      if (!eventId || !inboundOrderId || (!successful && !failed)) throw apiError("INVALID_PAYMENT_EVENT", "A payment eventId, orderId and supported status are required");
      if (!Number.isFinite(amount) || amount < 0) throw apiError("INVALID_PAYMENT_AMOUNT", "A valid payment amount is required");
      const previousEvent = repository.getEvent(eventId);
      if (previousEvent) {
        if (previousEvent.order_id !== inboundOrderId) throw apiError("PAYMENT_EVENT_CONFLICT", "This payment event is already linked to another order", 409);
        return { ok: true, duplicate: true, orderId: previousEvent.order_id };
      }
      expireOrders();
      const order = repository.loadOrder(inboundOrderId);
      if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
      if (order.status === "expired") throw apiError("PAYMENT_ORDER_EXPIRED", "This order has expired", 410);
      if (toCents(amount) !== toCents(order.amount)) throw apiError("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match order", 409);
      if (failed) {
        if (order.status === "paid") throw apiError("ORDER_ALREADY_PAID", "A paid order cannot be marked as failed", 409);
        if (order.status !== "pending") throw apiError("ORDER_NOT_CONFIRMABLE", "Only pending orders can receive a payment failure", 409);
        const failedStatus = status === "canceled" ? "cancelled" : "failed";
        db.prepare("UPDATE orders SET status = ? WHERE id = ? AND status = 'pending'").run(failedStatus, order.id);
        repository.insertEvent({ provider, eventId, orderId: order.id, status: failedStatus, amount, createdAt: now() });
        logEvent("payment.failed", { orderId: order.id, provider, eventId, status: failedStatus, success: false }, "warn");
        return { ok: true, failed: true, orderId: order.id, status: failedStatus };
      }
      const paid = completePayment({
        provider, providerTradeNo: eventId, orderId: order.id, amount, paidAt: now(), eventId,
      });
      if (paid.duplicate) return { ok: true, duplicate: true, orderId: order.id };
      if (paid.alreadyPaid) return { ok: true, alreadyPaid: true, orderId: order.id };
      const fulfilled = await fulfill(paid);
      if (fulfilled.activationError) throw fulfilled.activationError;
      return { ok: true, orderId: order.id, subscription: fulfilled.subscription };
    },
    nativeProvidersReady: () => nativeProvidersReady({ providerMode: providerMode(), production: productionRuntime }),
  };
}

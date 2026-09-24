import crypto from "node:crypto";
import { PaymentProvider } from "./base.js";
import { paymentRequest } from "../httpClient.js";
import { normalizePem, normalizePrivateKey } from "../pem.js";

const ALLOWED_GATEWAYS = new Set([
  "https://openapi.alipay.com/gateway.do",
  "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
]);

function yuanString(amount) {
  return Number(amount).toFixed(2);
}

export function alipaySignContent(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== "" && key !== "sign")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export function signAlipayParams(privateKeyPem, params) {
  const content = alipaySignContent(params);
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(content, "utf8");
  sign.end();
  return sign.sign(normalizePrivateKey(privateKeyPem), "base64");
}

export function verifyAlipaySignature(publicKeyPem, params, signature) {
  const content = alipaySignContent(params);
  const verify = crypto.createVerify("RSA-SHA256");
  verify.update(content, "utf8");
  verify.end();
  return verify.verify(normalizePem(publicKeyPem), signature, "base64");
}

export class AlipayProvider extends PaymentProvider {
  constructor({ config, http = paymentRequest }) {
    super("alipay");
    this.config = config;
    this.http = http;
  }

  configured() {
    const cfg = this.config;
    return Boolean(cfg?.enabled && cfg.appId && cfg.privateKey && cfg.publicKey);
  }

  gateway() {
    const value = String(this.config.gateway || "https://openapi.alipay.com/gateway.do").replace(/\/$/, "");
    if (!ALLOWED_GATEWAYS.has(value)) {
      const error = new Error("ALIPAY_GATEWAY_NOT_ALLOWED");
      error.code = "ALIPAY_GATEWAY_NOT_ALLOWED";
      throw error;
    }
    return value;
  }

  commonParams(method, bizContent) {
    return {
      app_id: this.config.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
      version: "1.0",
      notify_url: this.config.notifyUrl || undefined,
      biz_content: JSON.stringify(bizContent),
    };
  }

  async execute(method, bizContent) {
    const unsigned = this.commonParams(method, bizContent);
    const sign = signAlipayParams(this.config.privateKey, unsigned);
    const body = new URLSearchParams({ ...unsigned, sign }).toString();
    const response = await this.http(this.gateway(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
    });
    let parsed = {};
    try { parsed = JSON.parse(response.body); } catch { parsed = {}; }
    const key = `${method.replaceAll(".", "_")}_response`;
    const payload = parsed[key] || parsed;
    if (payload.code && payload.code !== "10000") {
      const error = new Error(payload.sub_msg || payload.msg || "ALIPAY_REQUEST_FAILED");
      error.code = payload.sub_code || payload.code || "ALIPAY_REQUEST_FAILED";
      throw error;
    }
    return payload;
  }

  async createPayment({ order, payment, description, notifyUrl }) {
    if (notifyUrl) this.config = { ...this.config, notifyUrl };
    const result = await this.execute("alipay.trade.precreate", {
      out_trade_no: payment.id,
      total_amount: yuanString(order.amount),
      subject: String(description || "CheapVPN").slice(0, 256),
      timeout_express: "15m",
    });
    if (!result.qr_code) {
      const error = new Error("ALIPAY_QR_MISSING");
      error.code = "ALIPAY_QR_MISSING";
      throw error;
    }
    return { qrContent: result.qr_code, providerOrderId: result.out_trade_no || payment.id, rawStatus: "WAIT_BUYER_PAY" };
  }

  async queryPayment({ payment }) {
    const result = await this.execute("alipay.trade.query", { out_trade_no: payment.id });
    const paid = ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(result.trade_status);
    return {
      paid,
      status: paid ? "paid" : result.trade_status === "TRADE_CLOSED" ? "closed" : "pending",
      providerTradeNo: result.trade_no || null,
      amount: result.total_amount != null ? Number(result.total_amount) : payment.amount,
      rawStatus: result.trade_status || "",
      appId: this.config.appId,
      outTradeNo: result.out_trade_no,
      sellerId: result.seller_id,
    };
  }

  async closePayment({ payment }) {
    await this.execute("alipay.trade.close", { out_trade_no: payment.id });
    return { closed: true };
  }

  async refundPayment() {
    return { refunded: false, reserved: true };
  }

  parseNotify(request) {
    const source = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)
      ? request.body
      : Object.fromEntries(new URLSearchParams(Buffer.isBuffer(request.rawBody) ? request.rawBody.toString("utf8") : String(request.rawBody || "")));
    const params = {};
    for (const [key, value] of Object.entries(source)) params[key] = Array.isArray(value) ? value[0] : String(value);
    const signature = params.sign || "";
    const { sign, sign_type: _signType, ...unsigned } = params;
    if (!signature || !verifyAlipaySignature(this.config.publicKey, unsigned, signature)) {
      const error = new Error("INVALID_PAYMENT_SIGNATURE");
      error.status = 401;
      error.code = "INVALID_PAYMENT_SIGNATURE";
      throw error;
    }
    return params;
  }

  assertPaidNotify(params, { order, payment }) {
    if (params.app_id && params.app_id !== this.config.appId) {
      const error = new Error("ALIPAY_APP_MISMATCH");
      error.status = 409;
      error.code = "ALIPAY_APP_MISMATCH";
      throw error;
    }
    if (this.config.sellerId && params.seller_id && params.seller_id !== this.config.sellerId) {
      const error = new Error("ALIPAY_SELLER_MISMATCH");
      error.status = 409;
      error.code = "ALIPAY_SELLER_MISMATCH";
      throw error;
    }
    if (params.out_trade_no !== payment.id) {
      const error = new Error("ALIPAY_ORDER_MISMATCH");
      error.status = 409;
      error.code = "ALIPAY_ORDER_MISMATCH";
      throw error;
    }
    const paid = ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(params.trade_status);
    if (paid && yuanString(params.total_amount) !== yuanString(order.amount)) {
      const error = new Error("PAYMENT_AMOUNT_MISMATCH");
      error.status = 409;
      error.code = "PAYMENT_AMOUNT_MISMATCH";
      throw error;
    }
    return { paid, params };
  }

  async handleWebhook({ request, order, payment }) {
    const params = this.parseNotify(request);
    const checked = this.assertPaidNotify(params, { order, payment });
    return {
      paid: checked.paid,
      providerTradeNo: params.trade_no,
      orderId: order.id,
      paymentId: payment.id,
      amount: order.amount,
      paidAt: params.gmt_payment || undefined,
      eventId: `alipay:${params.trade_no}:${params.out_trade_no}`,
      rawStatus: params.trade_status,
    };
  }
}

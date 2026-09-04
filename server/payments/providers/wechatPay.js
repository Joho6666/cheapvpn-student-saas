import crypto from "node:crypto";
import { PaymentProvider } from "./base.js";
import { paymentRequest } from "../httpClient.js";
import { normalizePem, normalizePrivateKey } from "../pem.js";

const WECHAT_HOST = "https://api.mch.weixin.qq.com";

function nonce() {
  return crypto.randomBytes(16).toString("hex");
}

export function wechatSignMessage({ method, path, timestamp, nonceStr, body }) {
  return `${method}\n${path}\n${timestamp}\n${nonceStr}\n${body}\n`;
}

export function wechatNotifyMessage({ timestamp, nonceStr, body }) {
  return `${timestamp}\n${nonceStr}\n${body}\n`;
}

export function signWechatRequest(privateKeyPem, message) {
  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  return sign.sign(normalizePrivateKey(privateKeyPem), "base64");
}

export function verifyWechatSignature(publicKeyPem, message, signature) {
  const verify = crypto.createVerify("SHA256");
  verify.update(message);
  verify.end();
  return verify.verify(normalizePem(publicKeyPem), signature, "base64");
}

export function decryptWechatResource(apiV3Key, resource) {
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(String(apiV3Key), "utf8"), Buffer.from(resource.nonce, "utf8"));
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

export class WechatPayProvider extends PaymentProvider {
  constructor({ config, http = paymentRequest, toCents }) {
    super("wechat");
    this.config = config;
    this.http = http;
    this.toCents = toCents;
  }

  configured() {
    const cfg = this.config;
    return Boolean(cfg?.enabled && cfg.appId && cfg.mchId && cfg.certSerialNo && cfg.privateKey && cfg.apiV3Key && cfg.publicKey);
  }

  authorization(method, urlPath, body = "") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = nonce();
    const message = wechatSignMessage({ method, path: urlPath, timestamp, nonceStr, body });
    const signature = signWechatRequest(this.config.privateKey, message);
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${this.config.certSerialNo}",signature="${signature}"`;
  }

  async request(method, urlPath, bodyObject) {
    const body = bodyObject === undefined ? "" : JSON.stringify(bodyObject);
    const response = await this.http(`${WECHAT_HOST}${urlPath}`, {
      method,
      headers: {
        Authorization: this.authorization(method, urlPath, body),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    });
    let parsed = {};
    try { parsed = response.body ? JSON.parse(response.body) : {}; } catch { parsed = { raw: response.body }; }
    if (response.status >= 400) {
      const error = new Error(parsed.message || parsed.code || "WECHAT_PAY_REQUEST_FAILED");
      error.status = response.status;
      error.code = parsed.code || "WECHAT_PAY_REQUEST_FAILED";
      throw error;
    }
    return parsed;
  }

  async createPayment({ order, payment, description, notifyUrl }) {
    const result = await this.request("POST", "/v3/pay/transactions/native", {
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: String(description || "CheapVPN").slice(0, 127),
      out_trade_no: payment.id,
      notify_url: notifyUrl,
      amount: { total: this.toCents(order.amount), currency: "CNY" },
    });
    if (!result.code_url) {
      const error = new Error("WECHAT_QR_MISSING");
      error.code = "WECHAT_QR_MISSING";
      throw error;
    }
    return { qrContent: result.code_url, providerOrderId: payment.id, rawStatus: "NOTPAY" };
  }

  async queryPayment({ payment }) {
    const result = await this.request("GET", `/v3/pay/transactions/out-trade-no/${payment.id}?mchid=${encodeURIComponent(this.config.mchId)}`);
    const paid = result.trade_state === "SUCCESS";
    return {
      paid,
      status: paid ? "paid" : result.trade_state === "CLOSED" ? "closed" : result.trade_state === "PAYERROR" ? "failed" : "pending",
      providerTradeNo: result.transaction_id || null,
      amount: result.amount?.total != null ? Number(result.amount.total) / 100 : payment.amount,
      currency: result.amount?.currency || "CNY",
      rawStatus: result.trade_state || "",
      appId: result.appid,
      mchId: result.mchid,
      outTradeNo: result.out_trade_no,
    };
  }

  async closePayment({ payment }) {
    await this.request("POST", `/v3/pay/transactions/out-trade-no/${payment.id}/close`, { mchid: this.config.mchId });
    return { closed: true };
  }

  async refundPayment() {
    return { refunded: false, reserved: true };
  }

  verifyNotify(request) {
    const timestamp = String(request.headers["wechatpay-timestamp"] || "");
    const nonceStr = String(request.headers["wechatpay-nonce"] || "");
    const signature = String(request.headers["wechatpay-signature"] || "");
    const serial = String(request.headers["wechatpay-serial"] || "");
    if (this.config.publicKeyId && serial && serial !== this.config.publicKeyId) {
      const error = new Error("WECHAT_SERIAL_MISMATCH");
      error.status = 401;
      error.code = "WECHAT_SERIAL_MISMATCH";
      throw error;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      const error = new Error("WECHAT_TIMESTAMP_INVALID");
      error.status = 401;
      error.code = "WECHAT_TIMESTAMP_INVALID";
      throw error;
    }
    const body = Buffer.isBuffer(request.rawBody) ? request.rawBody.toString("utf8") : JSON.stringify(request.body || {});
    const message = wechatNotifyMessage({ timestamp, nonceStr, body });
    if (!signature || !verifyWechatSignature(this.config.publicKey, message, signature)) {
      const error = new Error("INVALID_PAYMENT_SIGNATURE");
      error.status = 401;
      error.code = "INVALID_PAYMENT_SIGNATURE";
      throw error;
    }
    const payload = request.body && typeof request.body === "object" ? request.body : JSON.parse(body || "{}");
    const resource = decryptWechatResource(this.config.apiV3Key, payload.resource || {});
    return { payload, resource };
  }

  assertPaidResource(resource, { order, payment }) {
    if (resource.mchid && resource.mchid !== this.config.mchId) {
      const error = new Error("WECHAT_MCH_MISMATCH");
      error.status = 409;
      error.code = "WECHAT_MCH_MISMATCH";
      throw error;
    }
    if (resource.appid && resource.appid !== this.config.appId) {
      const error = new Error("WECHAT_APPID_MISMATCH");
      error.status = 409;
      error.code = "WECHAT_APPID_MISMATCH";
      throw error;
    }
    if (resource.out_trade_no !== payment.id) {
      const error = new Error("WECHAT_ORDER_MISMATCH");
      error.status = 409;
      error.code = "WECHAT_ORDER_MISMATCH";
      throw error;
    }
    if (resource.trade_state !== "SUCCESS") {
      return { paid: false, resource };
    }
    if (Number(resource.amount?.total) !== this.toCents(order.amount) || String(resource.amount?.currency || "CNY") !== "CNY") {
      const error = new Error("PAYMENT_AMOUNT_MISMATCH");
      error.status = 409;
      error.code = "PAYMENT_AMOUNT_MISMATCH";
      throw error;
    }
    return { paid: true, resource };
  }

  async handleWebhook({ request, order, payment }) {
    const { resource } = this.verifyNotify(request);
    const checked = this.assertPaidResource(resource, { order, payment });
    return {
      paid: checked.paid,
      providerTradeNo: resource.transaction_id,
      orderId: order.id,
      paymentId: payment.id,
      amount: order.amount,
      paidAt: resource.success_time || undefined,
      eventId: `wechat:${resource.transaction_id}:${resource.out_trade_no}`,
      rawStatus: resource.trade_state,
    };
  }
}

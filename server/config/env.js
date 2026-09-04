import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

const bool = (value, fallback = false) => String(value ?? fallback).toLowerCase() === "true";
const number = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const dataDir = path.resolve(process.env.DATA_DIR || path.join(serverDir, "..", "data"));
export const port = number(process.env.PORT, 4000);
export const host = process.env.HOST || "127.0.0.1";
export const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
export const trustProxyHeaders = bool(process.env.TRUST_PROXY);
export const configuredCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean);
export const upstreamTimeout = number(process.env.UPSTREAM_SYNC_TIMEOUT_MS, 10000);
export const nodeTestConcurrency = number(process.env.NODE_TEST_CONCURRENCY, 24);
export const upstreamSyncConcurrency = Math.max(1, number(process.env.UPSTREAM_SYNC_CONCURRENCY, 6));
export const nodeProbeTimeout = Math.max(500, number(process.env.NODE_PROBE_TIMEOUT_MS, 2000));
export const nodeGeoTimeout = Math.max(500, number(process.env.NODE_GEO_TIMEOUT_MS, 1800));
export const adminPassword = process.env.ADMIN_PASSWORD || "change-me-now";
export const productionRuntime = String(process.env.NODE_ENV || "").toLowerCase() === "production";
export const paymentWebhookSecretDefault = process.env.PAYMENT_WEBHOOK_SECRET || "";
export const paymentModeDefault = ["mock", "manual", "webhook", "wechat_alipay"].includes(String(process.env.PAYMENT_MODE || "mock"))
  ? String(process.env.PAYMENT_MODE || "mock") : "mock";
export const paymentProviderModeDefault = ["mock", "live"].includes(String(process.env.PAYMENT_PROVIDER_MODE || "live"))
  ? String(process.env.PAYMENT_PROVIDER_MODE || "live") : "live";
export const paymentProvidersDefault = String(process.env.PAYMENT_PROVIDERS || "wechat,alipay")
  .split(",").map((value) => value.trim().toLowerCase()).filter((value) => ["wechat", "alipay"].includes(value));

function envText(name) {
  return String(process.env[name] || "").replace(/\\n/g, "\n").trim();
}

export const wechatPayEnabled = bool(process.env.WECHAT_PAY_ENABLED);
export const wechatPayConfig = Object.freeze({
  enabled: wechatPayEnabled,
  appId: envText("WECHAT_PAY_APP_ID"),
  mchId: envText("WECHAT_PAY_MCH_ID"),
  certSerialNo: envText("WECHAT_PAY_CERT_SERIAL_NO"),
  privateKey: envText("WECHAT_PAY_PRIVATE_KEY"),
  apiV3Key: envText("WECHAT_PAY_API_V3_KEY"),
  publicKey: envText("WECHAT_PAY_PUBLIC_KEY"),
  publicKeyId: envText("WECHAT_PAY_PUBLIC_KEY_ID"),
  notifyUrl: envText("WECHAT_PAY_NOTIFY_URL"),
});

export const alipayEnabled = bool(process.env.ALIPAY_ENABLED);
export const alipayConfig = Object.freeze({
  enabled: alipayEnabled,
  appId: envText("ALIPAY_APP_ID"),
  privateKey: envText("ALIPAY_PRIVATE_KEY"),
  publicKey: envText("ALIPAY_PUBLIC_KEY"),
  gateway: envText("ALIPAY_GATEWAY") || "https://openapi.alipay.com/gateway.do",
  notifyUrl: envText("ALIPAY_NOTIFY_URL"),
  sellerId: envText("ALIPAY_SELLER_ID"),
});
export const paymentMethodCatalog = [
  { id: "wechat_pay", label: "WeChat Pay", icon: "chat", description: "微信支付" },
  { id: "alipay", label: "Alipay", icon: "account_balance_wallet", description: "支付宝" },
  { id: "card", label: "Visa / Mastercard", icon: "credit_card", description: "信用卡或借记卡" },
  { id: "bank_transfer", label: "Bank transfer", icon: "account_balance", description: "银行转账" },
];
export const allowDemoSubscription = bool(process.env.ALLOW_DEMO_SUBSCRIPTION);
export const allowDemoAccount = bool(process.env.ALLOW_DEMO_ACCOUNT);
export const paymentCheckoutTemplateDefault = String(process.env.PAYMENT_CHECKOUT_URL_TEMPLATE || "").trim();
export const paymentManualInstructionsDefault = String(process.env.PAYMENT_MANUAL_INSTRUCTIONS || "").trim().slice(0, 2000);
export const upstreamUsageApiUrlDefault = String(process.env.UPSTREAM_USAGE_API_URL || "").trim();
export const upstreamUsageApiTokenDefault = String(process.env.UPSTREAM_USAGE_API_TOKEN || "").trim();
export const upstreamUsageSyncIntervalDefault = Math.max(0, number(process.env.UPSTREAM_USAGE_SYNC_INTERVAL_MS, 0));
export const upstreamAssignmentDefault = ["default", "round_robin"].includes(String(process.env.UPSTREAM_ASSIGNMENT_MODE || "default"))
  ? String(process.env.UPSTREAM_ASSIGNMENT_MODE || "default") : "default";
export const smtpUrlDefault = String(process.env.SMTP_URL || "").trim();
export const emailFromDefault = String(process.env.EMAIL_FROM || "").trim().slice(0, 180);
export const allowPrivateUpstreamUrls = bool(process.env.ALLOW_PRIVATE_UPSTREAM_URLS);

export const config = Object.freeze({
  dataDir, port, host, publicBaseUrl, trustProxyHeaders, configuredCorsOrigins,
  upstreamTimeout, nodeTestConcurrency, upstreamSyncConcurrency, nodeProbeTimeout,
  nodeGeoTimeout, adminPassword, productionRuntime, paymentWebhookSecretDefault,
  paymentModeDefault, paymentProviderModeDefault, paymentProvidersDefault,
  wechatPayEnabled, wechatPayConfig, alipayEnabled, alipayConfig,
  paymentMethodCatalog, allowDemoSubscription, allowDemoAccount,
  paymentCheckoutTemplateDefault, paymentManualInstructionsDefault,
  upstreamUsageApiUrlDefault, upstreamUsageApiTokenDefault, upstreamUsageSyncIntervalDefault,
  upstreamAssignmentDefault, smtpUrlDefault, emailFromDefault, allowPrivateUpstreamUrls,
});

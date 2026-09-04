import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const ALLOWED_HOSTS = new Set([
  "api.mch.weixin.qq.com",
  "openapi.alipay.com",
  "openapi-sandbox.dl.alipaydev.com",
]);

function ipv4IsPrivate(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function ipv6IsPrivate(value) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea")
    || normalized.startsWith("feb") || normalized.startsWith("ff")
    || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

function isPrivateAddress(address) {
  const normalized = String(address || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  return family === 4 ? ipv4IsPrivate(normalized) : family === 6 ? ipv6IsPrivate(normalized) : true;
}

export function assertPaymentUrl(input) {
  let parsed;
  try { parsed = new URL(String(input)); } catch { throw new Error("PAYMENT_URL_INVALID"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("PAYMENT_URL_PROTOCOL");
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) throw new Error("PAYMENT_HOST_NOT_ALLOWED");
  if (parsed.username || parsed.password) throw new Error("PAYMENT_URL_CREDENTIALS");
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error("PAYMENT_PRIVATE_HOST");
  return parsed;
}

async function resolvePublic(parsed) {
  const literal = net.isIP(parsed.hostname);
  const addresses = literal
    ? [{ address: parsed.hostname, family: literal }]
    : await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  const approved = addresses.filter(({ address }) => !isPrivateAddress(address));
  if (!approved.length) throw new Error("PAYMENT_PRIVATE_HOST");
  return approved[0];
}

function requestOnce(parsed, address, { method, headers, body, timeoutMs }) {
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.setTimeout(timeoutMs || 15000, () => {
      request.destroy(new Error("PAYMENT_HTTP_TIMEOUT"));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function paymentRequest(url, { method = "GET", headers = {}, body = "", timeoutMs = 15000 } = {}) {
  const parsed = assertPaymentUrl(url);
  const address = await resolvePublic(parsed);
  return requestOnce(parsed, address, { method, headers, body, timeoutMs });
}

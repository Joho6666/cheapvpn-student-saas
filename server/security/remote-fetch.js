import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const REDIRECT_LIMIT = 5;

export class RemoteFetchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RemoteFetchError";
    this.code = code;
    this.status = status;
  }
}

function ipv4IsPrivate(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

function ipv6IsPrivate(value) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("ff") || normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

export function isPrivateAddress(address) {
  const normalized = String(address || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  return family === 4 ? ipv4IsPrivate(normalized) : family === 6 ? ipv6IsPrivate(normalized) : true;
}

function parseAndValidateUrl(input, { allowPrivate = false } = {}) {
  let parsed;
  try { parsed = new URL(String(input)); } catch { throw new RemoteFetchError("INVALID_REMOTE_URL", "Remote URL must be a valid HTTP(S) URL"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new RemoteFetchError("INVALID_REMOTE_URL", "Remote URL must use http or https");
  if (parsed.username || parsed.password) throw new RemoteFetchError("REMOTE_URL_CREDENTIALS_FORBIDDEN", "Remote URL must not contain credentials");
  if (!parsed.hostname) throw new RemoteFetchError("INVALID_REMOTE_URL", "Remote URL must include a hostname");
  if (["metadata", "metadata.google.internal", "instance-data"].includes(parsed.hostname.toLowerCase())) {
    throw new RemoteFetchError("PRIVATE_REMOTE_URL_BLOCKED", "Metadata service hostnames are not allowed");
  }
  if (!allowPrivate && net.isIP(parsed.hostname) && isPrivateAddress(parsed.hostname)) {
    throw new RemoteFetchError("PRIVATE_REMOTE_URL_BLOCKED", "Private or local upstream URLs are disabled");
  }
  return parsed;
}

export function validateRemoteUrl(input, options = {}) {
  return parseAndValidateUrl(input, options);
}

async function resolveApprovedAddresses(parsed, allowPrivate) {
  const literal = net.isIP(parsed.hostname);
  const addresses = literal ? [{ address: parsed.hostname, family: literal }] : await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new RemoteFetchError("REMOTE_DNS_FAILED", "Remote hostname did not resolve", 502);
  const approved = addresses.filter(({ address }) => allowPrivate || !isPrivateAddress(address));
  if (!approved.length) throw new RemoteFetchError("PRIVATE_REMOTE_URL_BLOCKED", "Remote hostname resolves only to private or local addresses");
  return approved;
}

function requestOnce(parsed, address, { signal, headers }) {
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers,
      servername: parsed.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => finish(resolve, {
        status: response.statusCode || 0,
        headers: new Headers(response.headers),
        body: Buffer.concat(chunks),
      }));
      response.on("error", (error) => finish(reject, error));
    });
    request.on("error", (error) => finish(reject, error));
    if (signal) {
      if (signal.aborted) request.destroy(new Error("The operation was aborted"));
      signal.addEventListener("abort", () => request.destroy(new Error("The operation was aborted")), { once: true });
    }
    request.end();
  });
}

export async function safeRemoteFetch(input, options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const headers = { Accept: "*/*", ...(options.headers || {}) };
  let current = String(input);
  for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
    const parsed = parseAndValidateUrl(current, { allowPrivate });
    const addresses = await resolveApprovedAddresses(parsed, allowPrivate);
    let response;
    try {
      response = await requestOnce(parsed, addresses[0], options);
    } catch (error) {
      if (error instanceof RemoteFetchError) throw error;
      throw new RemoteFetchError("REMOTE_FETCH_FAILED", "Remote upstream request failed", 502);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: response.headers,
        url: parsed.toString(),
        text: async () => response.body.toString("utf8"),
        json: async () => JSON.parse(response.body.toString("utf8")),
      };
    }
    const location = response.headers.get("location");
    if (!location) throw new RemoteFetchError("REMOTE_REDIRECT_INVALID", "Remote redirect did not include a location", 502);
    if (redirect === REDIRECT_LIMIT) throw new RemoteFetchError("REMOTE_REDIRECT_LIMIT", "Remote redirect limit exceeded", 502);
    current = new URL(location, parsed).toString();
  }
  throw new RemoteFetchError("REMOTE_REDIRECT_LIMIT", "Remote redirect limit exceeded", 502);
}

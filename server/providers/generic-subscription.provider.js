import { ProviderAdapter } from "./base.provider.js";
import { safeRemoteFetch } from "../security/remote-fetch.js";

export class GenericSubscriptionProvider extends ProviderAdapter {
  constructor({ timeoutMs = 10000, allowPrivate = false } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.allowPrivate = allowPrivate;
  }

  async getStatus() { return { ok: true, provider: "generic-subscription" }; }

  async getSubscription(url, { signal, format = "universal" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await safeRemoteFetch(url, { signal: controller.signal, allowPrivate: this.allowPrivate });
      return { response, content: await response.text(), format, source: "generic-subscription" };
    } finally { clearTimeout(timer); }
  }

  async getUsage(url, { token = "", signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await safeRemoteFetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        allowPrivate: this.allowPrivate,
      });
      return { response, payload: await response.json(), source: "generic-usage" };
    } finally { clearTimeout(timer); }
  }
}

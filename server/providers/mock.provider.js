import { ProviderAdapter } from "./base.provider.js";

export class MockProvider extends ProviderAdapter {
  constructor({ content = "# CheapVPN mock subscription\n", usage = null } = {}) {
    super();
    this.content = content;
    this.usage = usage;
  }
  async getStatus() { return { ok: true, provider: "mock" }; }
  async getSubscription() { return { content: this.content, source: "mock", usage: this.usage }; }
  async getUsage() { return { payload: this.usage, source: "mock" }; }
}

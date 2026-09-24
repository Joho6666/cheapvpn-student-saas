export class PaymentProvider {
  constructor(name) {
    this.name = name;
  }

  async createPayment() {
    throw new Error("createPayment is not implemented");
  }

  async queryPayment() {
    throw new Error("queryPayment is not implemented");
  }

  async handleWebhook() {
    throw new Error("handleWebhook is not implemented");
  }

  async closePayment() {
    return { closed: false };
  }

  async refundPayment() {
    throw new Error("refundPayment is not implemented");
  }
}

import { PaymentProvider } from "./base.js";

export class MockPaymentProvider extends PaymentProvider {
  constructor() {
    super("mock");
    this.paid = new Set();
  }

  async createPayment({ payment }) {
    return {
      qrContent: `cheapvpn://mock-payment/${payment.id}`,
      providerOrderId: payment.id,
      rawStatus: "NOTPAY",
    };
  }

  async queryPayment({ payment }) {
    const paid = this.paid.has(payment.id) || payment.status === "paid";
    return {
      paid,
      status: paid ? "paid" : "pending",
      providerTradeNo: paid ? `mock_${payment.id}` : null,
      amount: payment.amount,
      rawStatus: paid ? "SUCCESS" : "NOTPAY",
    };
  }

  markPaid(paymentId) {
    this.paid.add(paymentId);
  }

  async handleWebhook() {
    throw new Error("MOCK_WEBHOOK_UNSUPPORTED");
  }

  async closePayment({ payment }) {
    this.paid.delete(payment.id);
    return { closed: true };
  }

  async refundPayment() {
    return { refunded: false, reserved: true };
  }
}

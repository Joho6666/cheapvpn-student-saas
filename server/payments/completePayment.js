export function createCompletePayment({ db, repository, now, toCents, apiError, logEvent }) {
  function completePayment({
    provider,
    providerTradeNo,
    orderId,
    amount,
    paidAt,
    eventId,
    paymentId,
  }) {
    const timestamp = now();
    const result = db.transaction(() => {
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
      if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
      if (order.status === "expired") throw apiError("PAYMENT_ORDER_EXPIRED", "This order has expired", 410);
      if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
        throw apiError("INVALID_PAYMENT_AMOUNT", "A valid payment amount is required");
      }
      if (toCents(amount) !== toCents(order.amount)) {
        throw apiError("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match order", 409);
      }

      let payment = paymentId ? repository.getPayment(paymentId) : repository.activePendingPayment(orderId);
      if (paymentId && !payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
      if (payment && payment.order_id !== order.id) {
        throw apiError("PAYMENT_ORDER_MISMATCH", "Payment does not belong to this order", 409);
      }
      if (payment && toCents(payment.amount) !== toCents(order.amount)) {
        throw apiError("PAYMENT_AMOUNT_MISMATCH", "Payment amount does not match order", 409);
      }

      const resolvedEventId = String(eventId || `${provider}:${providerTradeNo || "none"}:${order.id}`).slice(0, 160);
      const previousEvent = repository.getEvent(resolvedEventId);
      if (previousEvent) {
        if (previousEvent.order_id !== order.id) {
          throw apiError("PAYMENT_EVENT_CONFLICT", "This payment event is already linked to another order", 409);
        }
        return { duplicate: true, alreadyPaid: order.status === "paid", order, payment };
      }

      if (order.status === "paid") {
        const inserted = repository.insertEvent({
          provider, eventId: resolvedEventId, orderId: order.id, status: "paid",
          amount: Number(amount), createdAt: timestamp,
        });
        if (payment && payment.status !== "paid") {
          repository.updatePayment(payment.id, {
            status: "paid",
            provider_trade_no: providerTradeNo || payment.provider_trade_no,
            paid_at: paidAt || timestamp,
            raw_status: "paid",
            last_error: null,
          });
          payment = repository.getPayment(payment.id);
        }
        if (!inserted) return { duplicate: true, alreadyPaid: true, order, payment };
        return { alreadyPaid: true, order, payment };
      }

      if (!["pending", "processing"].includes(order.status)) {
        throw apiError("ORDER_NOT_CONFIRMABLE", "Order cannot be confirmed", 409);
      }

      const claim = db.prepare(`UPDATE orders
        SET status = 'paid', confirmed_at = ?,
            activation_status = CASE WHEN activation_status = 'active' THEN activation_status ELSE 'pending' END
        WHERE id = ? AND status IN ('pending', 'processing')`).run(paidAt || timestamp, order.id);
      if (claim.changes !== 1) {
        const latest = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
        if (latest?.status === "paid") {
          const inserted = repository.insertEvent({
            provider, eventId: resolvedEventId, orderId: order.id, status: "paid",
            amount: Number(amount), createdAt: timestamp,
          });
          if (!inserted) return { duplicate: true, alreadyPaid: true, order: latest, payment };
          return { alreadyPaid: true, order: latest, payment };
        }
        throw apiError("ORDER_NOT_CONFIRMABLE", "Order cannot be confirmed", 409);
      }

      if (payment) {
        repository.updatePayment(payment.id, {
          status: "paid",
          provider_trade_no: providerTradeNo || payment.provider_trade_no,
          paid_at: paidAt || timestamp,
          raw_status: "paid",
          last_error: null,
        });
        payment = repository.getPayment(payment.id);
      }

      repository.insertEvent({
        provider, eventId: resolvedEventId, orderId: order.id, status: "paid",
        amount: Number(amount), createdAt: timestamp,
      });
      const updatedOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
      return { completed: true, order: updatedOrder, payment };
    })();

    logEvent(result.duplicate ? "payment.duplicate" : "payment.succeeded", {
      orderId, provider, eventId: eventId || "", status: "paid", success: true, paymentId: paymentId || "",
    });
    return result;
  }

  return { completePayment };
}

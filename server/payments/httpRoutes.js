export function registerPaymentHttpRoutes(app, {
  auth, adminAuth, rateLimit, apiError, productionRuntime, paymentRuntime, db, now,
}) {
  app.post("/api/orders/:orderId/payments", auth, async (req, res, next) => {
    try {
      const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(req.params.orderId, req.user.id);
      if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
      const created = await paymentRuntime.createPayment({
        order,
        provider: req.body?.provider,
        description: "CheapVPN Student",
      });
      res.status(201).json(created);
    } catch (error) { next(error); }
  });

  app.get("/api/payments/:paymentId/status", auth, async (req, res, next) => {
    try {
      res.json(await paymentRuntime.statusForUser({ paymentId: req.params.paymentId, userId: req.user.id }));
    } catch (error) { next(error); }
  });

  app.post("/api/payments/:paymentId/mock-success", auth, async (req, res, next) => {
    try {
      const payment = paymentRuntime.repository.getPayment(req.params.paymentId);
      if (!payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
      const order = db.prepare("SELECT id FROM orders WHERE id = ? AND user_id = ?").get(payment.order_id, req.user.id);
      if (!order) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
      const result = await paymentRuntime.mockSuccess({ paymentId: req.params.paymentId, production: productionRuntime });
      if (result.activationError) throw result.activationError;
      res.json({ ok: true, status: "active", orderId: order.id, subscription: result.subscription });
    } catch (error) { next(error); }
  });

  app.post("/api/payments/wechat/notify", rateLimit({ name: "wechat-notify", max: 120, windowMs: 60 * 1000 }), async (req, res) => {
    try {
      await paymentRuntime.handleProviderWebhook("wechat", req);
      res.json({ code: "SUCCESS", message: "成功" });
    } catch (error) {
      const status = error.status || 500;
      res.status(status === 401 || status === 409 ? status : 500).json({ code: "FAIL", message: status === 500 ? "ERROR" : error.message });
    }
  });

  app.post("/api/payments/alipay/notify", rateLimit({ name: "alipay-notify", max: 120, windowMs: 60 * 1000 }), async (req, res) => {
    try {
      await paymentRuntime.handleProviderWebhook("alipay", req);
      res.type("text/plain").send("success");
    } catch (_error) {
      res.status(500).type("text/plain").send("fail");
    }
  });

  app.get("/api/admin/payments", adminAuth, (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    res.json(paymentRuntime.listAdminPayments({
      q: String(req.query.q || "").trim().toLowerCase(),
      status: String(req.query.status || "").trim(),
      page,
      pageSize,
    }));
  });

  app.post("/api/admin/payments/:id/query", adminAuth, async (req, res, next) => {
    try {
      const payment = paymentRuntime.repository.getPayment(req.params.id);
      if (!payment) throw apiError("PAYMENT_NOT_FOUND", "Payment was not found", 404);
      const refreshed = await paymentRuntime.queryPayment({ payment, force: true });
      res.json({ payment: refreshed });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/orders/:id/retry-activation", adminAuth, async (req, res, next) => {
    try {
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
      if (!order) throw apiError("ORDER_NOT_FOUND", "Order was not found", 404);
      if (order.status !== "paid") throw apiError("ORDER_NOT_CONFIRMABLE", "Only paid orders can retry activation", 409);
      const result = await paymentRuntime.fulfill({ order, payment: paymentRuntime.repository.activePendingPayment(order.id) });
      if (result.activationError) throw result.activationError;
      res.json({ ok: true, orderId: order.id, activationStatus: result.order?.activation_status || "active", subscription: result.subscription });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/orders/:id/close", adminAuth, async (req, res, next) => {
    try {
      const result = db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(req.params.id);
      if (result.changes !== 1) throw apiError("ORDER_NOT_CANCELLABLE", "Only pending orders can be closed", 409);
      await paymentRuntime.closeOrderPayments(req.params.id);
      res.json({ ok: true, orderId: req.params.id, status: "cancelled" });
    } catch (error) { next(error); }
  });
}

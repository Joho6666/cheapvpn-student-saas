export function createPaymentRepository(db) {
  const nowIso = () => new Date().toISOString();

  function getPayment(id) {
    return db.prepare("SELECT * FROM payments WHERE id = ?").get(id) || null;
  }

  function getPaymentForUpdate(id) {
    return getPayment(id);
  }

  function listPaymentsForOrder(orderId) {
    return db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC").all(orderId);
  }

  function activePendingPayment(orderId) {
    return db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(orderId) || null;
  }

  function insertPayment(payment) {
    const timestamp = payment.created_at || nowIso();
    db.prepare(`INSERT INTO payments
      (id, order_id, provider, provider_trade_no, provider_order_id, amount, currency, status,
       qr_content, raw_status, last_query_at, last_error, created_at, updated_at, expires_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        payment.id, payment.order_id, payment.provider, payment.provider_trade_no || null,
        payment.provider_order_id || null, payment.amount, payment.currency || "CNY", payment.status,
        payment.qr_content || null, payment.raw_status || null, payment.last_query_at || null,
        payment.last_error || null, timestamp, payment.updated_at || timestamp,
        payment.expires_at || null, payment.paid_at || null,
      );
    return getPayment(payment.id);
  }

  function updatePayment(id, fields) {
    const current = getPayment(id);
    if (!current) return null;
    const next = { ...current, ...fields, updated_at: nowIso() };
    db.prepare(`UPDATE payments SET provider_trade_no = ?, provider_order_id = ?, status = ?, qr_content = ?,
      raw_status = ?, last_query_at = ?, last_error = ?, updated_at = ?, expires_at = ?, paid_at = ?
      WHERE id = ?`)
      .run(
        next.provider_trade_no, next.provider_order_id, next.status, next.qr_content, next.raw_status,
        next.last_query_at, next.last_error, next.updated_at, next.expires_at, next.paid_at, id,
      );
    return getPayment(id);
  }

  function closePendingForOrder(orderId, timestamp = nowIso()) {
    return db.prepare(`UPDATE payments SET status = 'closed', updated_at = ?, last_error = NULL
      WHERE order_id = ? AND status = 'pending'`).run(timestamp, orderId).changes;
  }

  function expireDuePayments(timestamp = nowIso()) {
    return db.prepare(`UPDATE payments SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`).run(timestamp, timestamp).changes;
  }

  function listDuePayments(timestamp = nowIso()) {
    return db.prepare(`SELECT * FROM payments WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`).all(timestamp);
  }

  function insertEvent({ provider, eventId, orderId, status, amount, createdAt = nowIso() }) {
    const result = db.prepare(`INSERT OR IGNORE INTO payment_events (provider, provider_event_id, order_id, status, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(provider, eventId, orderId, status, amount, createdAt);
    return result.changes === 1;
  }

  function getEvent(eventId) {
    return db.prepare("SELECT provider_event_id, order_id, status FROM payment_events WHERE provider_event_id = ?").get(eventId) || null;
  }

  function loadOrder(orderKey) {
    const rows = db.prepare("SELECT * FROM orders WHERE id = ?").all(String(orderKey || ""));
    return rows[0] || null;
  }

  return {
    getPayment, getPaymentForUpdate, listPaymentsForOrder, activePendingPayment, insertPayment,
    updatePayment, closePendingForOrder, expireDuePayments, listDuePayments, insertEvent, getEvent, loadOrder,
  };
}

const DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const MAX_ATTEMPTS = 8;
const ACTIVATING_STALE_MS = 10 * 60 * 1000;

export function nextRetryAt(attempts, from = Date.now()) {
  const delay = DELAYS_MS[Math.min(Math.max(attempts, 1) - 1, DELAYS_MS.length - 1)];
  return new Date(from + delay).toISOString();
}

export function createActivationRetryJob({ db, now, activatePaidOrder, logEvent }) {
  async function recoverStaleActivations() {
    const cutoff = new Date(Date.now() - ACTIVATING_STALE_MS).toISOString();
    db.prepare(`UPDATE orders SET activation_status = 'retrying', activation_next_retry_at = ?
      WHERE status = 'paid' AND activation_status = 'activating' AND confirmed_at IS NOT NULL AND confirmed_at <= ?`)
      .run(now(), cutoff);
  }

  async function runDueRetries() {
    recoverStaleActivations();
    const due = db.prepare(`SELECT * FROM orders
      WHERE status = 'paid' AND activation_status IN ('pending', 'retrying')
        AND (activation_next_retry_at IS NULL OR activation_next_retry_at <= ?)
        AND activation_attempts < ?
      ORDER BY created_at ASC LIMIT 20`).all(now(), MAX_ATTEMPTS);
    let ran = 0;
    for (const order of due) {
      ran += 1;
      try {
        await activatePaidOrder(order);
        logEvent("payment.activation_retry", { orderId: order.id, status: "active", success: true, count: order.activation_attempts });
      } catch (error) {
        logEvent("payment.activation_retry", {
          orderId: order.id, status: "retrying", success: false, count: order.activation_attempts,
          reason: error.code || "ACTIVATION_FAILED",
        }, "warn");
      }
    }
    return ran;
  }

  return { runDueRetries, recoverStaleActivations, nextRetryAt, MAX_ATTEMPTS };
}

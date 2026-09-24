-- Schema compatibility only. Cloudflare Worker is not the production WeChat/Alipay payment entry.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_trade_no TEXT,
  provider_order_id TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL,
  qr_content TEXT,
  raw_status TEXT,
  last_query_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  paid_at TEXT,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_trade_no ON payments(provider_trade_no) WHERE provider_trade_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_pending_per_order ON payments(order_id) WHERE status = 'pending';
ALTER TABLE orders ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN activation_error TEXT;
ALTER TABLE orders ADD COLUMN activation_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN activation_next_retry_at TEXT;

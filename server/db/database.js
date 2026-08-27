import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function createDatabase({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "cheapvpn.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, referral_code TEXT NOT NULL UNIQUE, referred_by_user_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      first_month_price REAL NOT NULL, renewal_price REAL NOT NULL, data_total_gb REAL NOT NULL,
      device_limit INTEGER NOT NULL, billing_period_months INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan_id INTEGER NOT NULL, amount REAL NOT NULL,
      status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'new', discount_percent INTEGER NOT NULL DEFAULT 0,
      referral_id INTEGER, expires_at TEXT, created_at TEXT NOT NULL, confirmed_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(plan_id) REFERENCES plans(id)
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL, status TEXT NOT NULL,
      amount REAL, created_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id)
    );
    CREATE TABLE IF NOT EXISTS payment_submissions (
      order_id TEXT PRIMARY KEY, payment_method TEXT NOT NULL DEFAULT 'manual',
      payment_reference TEXT NOT NULL, customer_note TEXT, submitted_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, plan_id INTEGER NOT NULL,
      source_id INTEGER, token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, data_used_gb REAL NOT NULL DEFAULT 0,
      usage_source TEXT NOT NULL DEFAULT 'manual', upstream_used_gb REAL, upstream_total_gb REAL,
      upstream_expires_at TEXT, upstream_synced_at TEXT, expires_at TEXT NOT NULL,
      last_sync_at TEXT, last_sync_status TEXT, last_sync_error TEXT,
      universal_content TEXT NOT NULL, clash_content TEXT NOT NULL, singbox_content TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(plan_id) REFERENCES plans(id)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      used_gb REAL NOT NULL, total_gb REAL NOT NULL, source TEXT NOT NULL, captured_at TEXT NOT NULL,
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, used_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, subject TEXT NOT NULL, device TEXT, client TEXT,
      description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, resolved_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_user_id INTEGER NOT NULL,
      referred_user_id INTEGER NOT NULL UNIQUE, code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered', reward_percent INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL, qualified_at TEXT, reward_used_at TEXT,
      FOREIGN KEY(referrer_user_id) REFERENCES users(id), FOREIGN KEY(referred_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS upstream_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url_encrypted TEXT NOT NULL,
      universal_url_encrypted TEXT, clash_url_encrypted TEXT, singbox_url_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT, last_sync_status TEXT, last_sync_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  const addColumn = (table, column, definition) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
    catch (error) { if (!String(error.message).includes("duplicate column name")) throw error; }
  };
  addColumn("payment_submissions", "payment_method", "TEXT NOT NULL DEFAULT 'manual'");
  addColumn("subscriptions", "source_id", "INTEGER");
  addColumn("plans", "billing_period_months", "INTEGER NOT NULL DEFAULT 1");
  addColumn("users", "referred_by_user_id", "INTEGER");
  addColumn("orders", "kind", "TEXT NOT NULL DEFAULT 'new'");
  addColumn("orders", "discount_percent", "INTEGER NOT NULL DEFAULT 0");
  addColumn("orders", "referral_id", "INTEGER");
  addColumn("orders", "expires_at", "TEXT");
  addColumn("orders", "client_request_id", "TEXT");
  addColumn("referrals", "reward_used_at", "TEXT");
  for (const column of ["universal_url_encrypted", "clash_url_encrypted", "singbox_url_encrypted", "node_rules_json"]) {
    addColumn("upstream_sources", column, "TEXT");
  }
  for (const [column, definition] of [
    ["usage_source", "TEXT NOT NULL DEFAULT 'manual'"], ["upstream_used_gb", "REAL"],
    ["upstream_total_gb", "REAL"], ["upstream_expires_at", "TEXT"], ["upstream_synced_at", "TEXT"],
  ]) addColumn("subscriptions", column, definition);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_pending_expiry ON orders(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_request ON orders(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_source_status ON subscriptions(source_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_usage_snapshots_user_time ON usage_snapshots(user_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_snapshots_subscription_time ON usage_snapshots(subscription_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user_expiry ON password_reset_tokens(user_id, expires_at);
  `);

  const conflicts = db.prepare(`SELECT user_id, GROUP_CONCAT(id) AS order_ids
    FROM orders WHERE status IN ('pending', 'processing') GROUP BY user_id HAVING COUNT(*) > 1`).all();
  if (conflicts.length) {
    const detail = conflicts.map((row) => `user_id=${row.user_id} orders=${row.order_ids}`).join("; ");
    throw new Error(`OPEN_ORDER_MIGRATION_CONFLICT: resolve existing pending/processing orders before startup: ${detail}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_user ON orders(user_id) WHERE status IN ('pending', 'processing')");
  return db;
}

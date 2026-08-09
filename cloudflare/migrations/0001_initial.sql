PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by_user_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  first_month_price REAL NOT NULL,
  renewal_price REAL NOT NULL,
  data_total_gb REAL NOT NULL,
  device_limit INTEGER NOT NULL,
  billing_period_months INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'new',
  discount_percent INTEGER NOT NULL DEFAULT 0,
  referral_id INTEGER,
  reward_used_at TEXT,
  client_request_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(plan_id) REFERENCES plans(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_request ON orders(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(status, expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  plan_id INTEGER NOT NULL,
  source_id INTEGER,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  data_used_gb REAL NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT 'manual',
  upstream_used_gb REAL,
  upstream_total_gb REAL,
  upstream_expires_at TEXT,
  upstream_synced_at TEXT,
  expires_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  node_rules_json TEXT,
  universal_content TEXT NOT NULL DEFAULT '',
  clash_content TEXT NOT NULL DEFAULT '',
  singbox_content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(plan_id) REFERENCES plans(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(status, expires_at);

CREATE TABLE IF NOT EXISTS upstream_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url_encrypted TEXT NOT NULL,
  universal_url_encrypted TEXT,
  clash_url_encrypted TEXT,
  singbox_url_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  used_gb REAL NOT NULL,
  total_gb REAL NOT NULL,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_user_time ON usage_snapshots(user_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id INTEGER NOT NULL,
  referred_user_id INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  reward_percent INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL,
  qualified_at TEXT,
  reward_used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  device TEXT,
  client TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_time ON support_tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_time ON support_tickets(status, updated_at DESC);

INSERT OR IGNORE INTO plans
  (slug, name, first_month_price, renewal_price, data_total_gb, device_limit, billing_period_months, active)
VALUES ('student', 'CheapVPN Student Plan', 9.9, 19.9, 50, 2, 1, 1);

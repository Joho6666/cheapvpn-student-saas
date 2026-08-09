import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const projectDir = process.cwd();
const envPath = path.resolve(process.env.ENV_FILE || path.join(projectDir, ".env"));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectDir, "server", "data"));
const dbPath = path.join(dataDir, "cheapvpn.sqlite");
const newPassword = String(process.env.NEW_ADMIN_PASSWORD || "");
const newEncryptionKey = String(process.env.NEW_ADMIN_ENCRYPTION_KEY || "");

if (newPassword.length < 12) throw new Error("NEW_ADMIN_PASSWORD must be at least 12 characters");
if (newEncryptionKey.length < 32) throw new Error("NEW_ADMIN_ENCRYPTION_KEY must be at least 32 characters");
if (!fs.existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function keyBytes(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function decrypt(value, key) {
  const [ivText, tagText, encryptedText] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function replaceEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
}

const envText = fs.readFileSync(envPath, "utf8");
const env = parseEnv(envText);
const oldEncryptionKey = keyBytes(env.ADMIN_ENCRYPTION_KEY || env.ADMIN_PASSWORD || "change-me-now");
const nextEncryptionKey = keyBytes(newEncryptionKey);
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const sources = db.prepare("SELECT id, url_encrypted, universal_url_encrypted, clash_url_encrypted, singbox_url_encrypted FROM upstream_sources").all();
const encryptedSettings = db.prepare(`SELECT key, value FROM settings WHERE key IN (
  'usage_api_url_encrypted', 'usage_api_token_encrypted',
  'payment_webhook_secret_encrypted', 'payment_checkout_template_encrypted', 'payment_manual_instructions_encrypted'
)`).all();
const migrated = [];
const migratedSettings = [];
try {
  const migrate = db.transaction(() => {
    for (const source of sources) {
      const values = [source.url_encrypted, source.universal_url_encrypted, source.clash_url_encrypted, source.singbox_url_encrypted]
        .map((value) => value ? encrypt(decrypt(value, oldEncryptionKey), nextEncryptionKey) : null);
      db.prepare(`UPDATE upstream_sources SET url_encrypted = ?, universal_url_encrypted = ?, clash_url_encrypted = ?, singbox_url_encrypted = ?, updated_at = ? WHERE id = ?`)
        .run(...values, new Date().toISOString(), source.id);
      migrated.push(source.id);
    }
    for (const setting of encryptedSettings) {
      db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
        .run(encrypt(decrypt(setting.value, oldEncryptionKey), nextEncryptionKey), new Date().toISOString(), setting.key);
      migratedSettings.push(setting.key);
    }
    db.prepare("DELETE FROM admin_sessions").run();
  });
  migrate();
  const backupPath = `${envPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(envPath, backupPath);
  let nextEnv = replaceEnvValue(envText, "ADMIN_PASSWORD", newPassword);
  nextEnv = replaceEnvValue(nextEnv, "ADMIN_ENCRYPTION_KEY", newEncryptionKey);
  fs.writeFileSync(envPath, nextEnv, "utf8");
  console.log(`Rotated admin secrets, migrated ${migrated.length} upstream source(s) and ${migratedSettings.length} encrypted setting(s). Backup: ${backupPath}`);
} catch (error) {
  db.close();
  throw error;
}
db.close();

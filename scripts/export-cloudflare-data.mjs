import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const sourcePath = path.resolve(process.argv[2] || "server/data/cheapvpn.sqlite");
const destinationPath = path.resolve(process.argv[3] || "cloudflare/local-data-import.sql");
const db = new Database(sourcePath, { readonly: true });
const tables = ["users", "plans", "orders", "subscriptions", "upstream_sources", "usage_snapshots", "referrals", "settings", "support_tickets"];

const quote = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
};

let sql = [];
for (const table of tables) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) continue;
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) continue;
  const columns = Object.keys(rows[0]);
  for (const row of rows) {
    // Subscription bodies are regenerated from encrypted source URLs after deployment.
    // Omitting them keeps each remote D1 statement below Cloudflare's size limit.
    const values = columns.map((column) => (table === "subscriptions" && ["universal_content", "clash_content", "singbox_content"].includes(column) ? quote("") : quote(row[column])));
    sql.push(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${values.join(", ")});`);
  }
}
fs.writeFileSync(destinationPath, `${sql.join("\n")}\n`, "utf8");
console.log(`Prepared ${destinationPath} from ${sourcePath}.`);

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR || path.join("server", "data");
const source = path.join(dataDir, "cheapvpn.sqlite");
const backupDir = process.env.BACKUP_DIR || "/backups";
fs.mkdirSync(backupDir, { recursive: true });
const output = path.join(backupDir, `cheapvpn-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
const db = new Database(source, { readonly: true });
await db.backup(output);
db.close();
console.log(`Database backup created: ${output}`);

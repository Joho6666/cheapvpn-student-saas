export function normalizePem(value) {
  const text = String(value || "").replace(/\\n/g, "\n").trim();
  if (!text) return "";
  if (text.includes("BEGIN")) return text;
  const wrapped = text.match(/.{1,64}/g)?.join("\n") || text;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

export function normalizePrivateKey(value) {
  const text = String(value || "").replace(/\\n/g, "\n").trim();
  if (!text) return "";
  if (text.includes("BEGIN")) return text;
  const wrapped = text.match(/.{1,64}/g)?.join("\n") || text;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

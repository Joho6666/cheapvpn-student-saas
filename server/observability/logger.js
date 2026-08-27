const ALLOWED_FIELDS = new Set([
  "requestId", "userId", "orderId", "provider", "eventId", "status", "code", "method",
  "path", "durationMs", "count", "sourceId", "format", "success", "reason",
]);

function safeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields)
    .filter(([key, value]) => ALLOWED_FIELDS.has(key) && value !== undefined && value !== null && typeof value !== "object")
    .map(([key, value]) => [key, String(value).slice(0, 200)]));
}

export function logEvent(event, fields = {}, level = "info") {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safeFields(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

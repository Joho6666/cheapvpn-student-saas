import assert from "node:assert/strict";
import http from "node:http";
import { safeRemoteFetch, validateRemoteUrl } from "../server/security/remote-fetch.js";

const server = http.createServer((req, res) => {
  if (req.url === "/redirect") { res.writeHead(302, { Location: "/content" }); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("safe fixture");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
try {
  assert.throws(() => validateRemoteUrl("file:///etc/passwd"), /http|https/i);
  assert.throws(() => validateRemoteUrl("http://user:pass@example.com"), /credentials/i);
  assert.doesNotThrow(() => validateRemoteUrl("https://example.com/subscription"));
  await assert.rejects(() => safeRemoteFetch(`http://127.0.0.1:${port}/content`), (error) => error.code === "PRIVATE_REMOTE_URL_BLOCKED");
  const response = await safeRemoteFetch(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true });
  assert.equal(response.ok, true);
  assert.equal(await response.text(), "safe fixture");
  console.log("Upstream security E2E passed: URL scheme, credentials, private address and redirect revalidation");
} finally {
  server.close();
}

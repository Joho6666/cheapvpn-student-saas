import {
  closeDatabase,
  createApp,
  productionStartupErrors,
  startBackgroundJobs,
} from "./app.js";
import { logEvent } from "./observability/logger.js";

const startupErrors = productionStartupErrors();
if (startupErrors.length) {
  logEvent("app.startup_refused", {
    count: startupErrors.length,
    reason: startupErrors.join("; "),
    message: "CheapVPN refused to start in production",
  }, "error");
  process.exit(1);
}

const app = createApp();
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "127.0.0.1";
startBackgroundJobs();
const httpServer = app.listen(port, host, () => {
  logEvent("app.listening", { success: true });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("app.shutdown_started", { reason: signal });
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  httpServer.close(() => {
    closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

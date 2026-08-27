import {
  closeDatabase,
  createApp,
  productionStartupErrors,
  startBackgroundJobs,
} from "./app.js";

const startupErrors = productionStartupErrors();
if (startupErrors.length) {
  console.error(`CheapVPN refused to start in production:\n- ${startupErrors.join("\n- ")}`);
  process.exit(1);
}

const app = createApp();
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "127.0.0.1";
startBackgroundJobs();
const httpServer = app.listen(port, host, () => console.log(`CheapVPN API listening on http://${host}:${port}`));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`CheapVPN API received ${signal}; closing connections`);
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

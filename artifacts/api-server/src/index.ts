import app from "./app";
import { logger } from "./lib/logger";
import {
  ensureBackgroundWorkerSchema,
  startBackgroundWorker,
} from "./lib/background-worker";
import { ensureNotificationSchema } from "./lib/notifications";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await ensureBackgroundWorkerSchema();
await ensureNotificationSchema();

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

const stopWorker = startBackgroundWorker();

server.on("close", () => {
  stopWorker();
});

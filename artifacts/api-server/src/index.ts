import app from "./app";
import { logger } from "./lib/logger";
import { syncKeyPrices } from "./lib/price-sync";
import { syncDigisellerOrders } from "./lib/orders";
import { ensureAdminAccount } from "./lib/admin-bootstrap";

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

const adminAccountStatus = await ensureAdminAccount();
logger.info({ adminAccountStatus }, "Administrator account is ready");

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

const PRICE_SYNC_INTERVAL_MS = 60 * 60 * 1_000;
const PRICE_SYNC_INITIAL_DELAY_MS = 60 * 1_000;
const ORDER_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const ORDER_SYNC_INITIAL_DELAY_MS = 60 * 1_000;

async function runScheduledPriceSync() {
  try {
    const result = await syncKeyPrices();
    logger.info({ priceSync: result }, "Scheduled GPay price sync finished");
  } catch (err) {
    logger.error({ err }, "Scheduled GPay price sync failed");
  }
}

const initialTimer = setTimeout(() => {
  void runScheduledPriceSync();
}, PRICE_SYNC_INITIAL_DELAY_MS);
const intervalTimer = setInterval(() => {
  void runScheduledPriceSync();
}, PRICE_SYNC_INTERVAL_MS);
initialTimer.unref();
intervalTimer.unref();

async function runScheduledOrderSync() {
  try {
    const result = await syncDigisellerOrders();
    logger.info(
      { orderSync: result },
      "Scheduled Digiseller order sync finished",
    );
  } catch (err) {
    logger.error({ err }, "Scheduled Digiseller order sync failed");
  }
}

const orderInitialTimer = setTimeout(() => {
  void runScheduledOrderSync();
}, ORDER_SYNC_INITIAL_DELAY_MS);
const orderIntervalTimer = setInterval(() => {
  void runScheduledOrderSync();
}, ORDER_SYNC_INTERVAL_MS);
orderInitialTimer.unref();
orderIntervalTimer.unref();

server.on("close", () => {
  clearTimeout(initialTimer);
  clearInterval(intervalTimer);
  clearTimeout(orderInitialTimer);
  clearInterval(orderIntervalTimer);
});

import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

const allowedOrigins = new Set(
  [
    process.env.APP_ORIGIN,
    process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : undefined,
    ...(process.env.REPLIT_DOMAINS ?? "")
      .split(",")
      .filter(Boolean)
      .map((domain) => `https://${domain}`),
  ].filter((origin): origin is string => Boolean(origin)),
);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (
    process.env.TEST_AUTH_BYPASS === "1" ||
    ["GET", "HEAD", "OPTIONS"].includes(req.method)
  ) {
    next();
    return;
  }
  if (req.headers.origin && allowedOrigins.has(req.headers.origin)) {
    next();
    return;
  }
  if (!req.headers.cookie) {
    next();
    return;
  }
  res.status(403).json({ error: "Недопустимый источник запроса" });
});

app.use("/api", router);

export default app;

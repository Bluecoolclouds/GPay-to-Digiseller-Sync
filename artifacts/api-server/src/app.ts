import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

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
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

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
const allowedHosts = new Set(
  [...allowedOrigins]
    .map((origin) => {
      try {
        return new URL(origin).host;
      } catch {
        return undefined;
      }
    })
    .filter((host): host is string => Boolean(host)),
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

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req, allowedHosts) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

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

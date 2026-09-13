import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  clearSessionCookie,
  createAdminSession,
  getSessionCookie,
  isAdminSession,
  setSessionCookie,
} from "../middlewares/auth";

const router: IRouter = Router();
const attempts = new Map<
  string,
  { count: number; resetAt: number; blockedUntil: number }
>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function equal(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

router.get("/auth/session", (req, res) => {
  res.json({ authenticated: isAdminSession(getSessionCookie(req)) });
});

router.post("/auth/login", (req, res) => {
  const key = req.ip ?? "unknown";
  const storedState = attempts.get(key);
  const state =
    storedState && storedState.resetAt > Date.now() ? storedState : undefined;
  if (!state && storedState) attempts.delete(key);
  if (state && state.blockedUntil > Date.now()) {
    res.status(429).json({ error: "Слишком много попыток. Попробуйте позже." });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expectedEmail = process.env.ADMIN_EMAIL?.trim() ?? "";
  const expectedPassword = process.env.ADMIN_PASSWORD ?? "";
  if (
    !email ||
    !password ||
    !expectedEmail ||
    !expectedPassword ||
    !equal(email.toLowerCase(), expectedEmail.toLowerCase()) ||
    !equal(password, expectedPassword)
  ) {
    const count = (state?.count ?? 0) + 1;
    attempts.set(key, {
      count,
      resetAt: Date.now() + WINDOW_MS,
      blockedUntil: count >= MAX_ATTEMPTS ? Date.now() + WINDOW_MS : 0,
    });
    res.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }
  attempts.delete(key);
  setSessionCookie(res, createAdminSession());
  res.json({ authenticated: true });
});

router.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

export default router;
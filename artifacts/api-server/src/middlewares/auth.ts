import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";

export type OperatorAuth = {
  userId?: string | null;
  sessionClaims?: unknown;
};

type ClaimsWithMetadata = {
  role?: unknown;
  metadata?: { role?: unknown };
  publicMetadata?: { role?: unknown };
  public_metadata?: { role?: unknown };
};

function getRole(auth: OperatorAuth): string | undefined {
  const claims = auth.sessionClaims as ClaimsWithMetadata | null;
  const role =
    claims?.role ??
    claims?.metadata?.role ??
    claims?.publicMetadata?.role ??
    claims?.public_metadata?.role;
  return typeof role === "string" ? role : undefined;
}

export function getOperatorAuthorization(
  auth: OperatorAuth,
): { allowed: true } | { allowed: false; status: 401 | 403; error: string } {
  if (!auth.userId) {
    return { allowed: false, status: 401, error: "Требуется вход оператора" };
  }
  if (!["operator", "owner"].includes(getRole(auth) ?? "")) {
    return { allowed: false, status: 403, error: "Недостаточно прав оператора" };
  }
  return { allowed: true };
}

export function requireOperatorRole(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (process.env.TEST_AUTH_BYPASS === "1") {
    next();
    return;
  }
  const authorization = getOperatorAuthorization(getAuth(req));
  if (!authorization.allowed) {
    res.status(authorization.status).json({ error: authorization.error });
    return;
  }
  next();
}

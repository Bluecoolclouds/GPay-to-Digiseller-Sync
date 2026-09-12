import assert from "node:assert/strict";
import test from "node:test";
import { getOperatorAuthorization } from "../middlewares/auth";

test("rejects a request without an authenticated user", () => {
  const result = getOperatorAuthorization({ userId: null, sessionClaims: null });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.equal(result.status, 401);
});

test("rejects an authenticated user without an operator role", () => {
  const result = getOperatorAuthorization({ userId: "user_1", sessionClaims: {} });
  assert.equal(result.allowed, false);
  if (result.allowed) return;
  assert.equal(result.status, 403);
});

test("allows operator and owner roles", () => {
  for (const role of ["operator", "owner"]) {
    const result = getOperatorAuthorization({
      userId: "user_1",
      sessionClaims: { public_metadata: { role } },
    });
    assert.equal(result.allowed, true);
  }
});
import assert from "node:assert/strict";
import test from "node:test";
import { createAdminSession, isAdminSession } from "../middlewares/auth";

process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";

test("accepts a server-signed administrator session", () => {
  assert.equal(isAdminSession(createAdminSession()), true);
});

test("rejects a missing administrator session", () => {
  assert.equal(isAdminSession(undefined), false);
});

test("rejects a modified administrator session", () => {
  const valid = createAdminSession();
  const modified = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
  assert.equal(isAdminSession(modified), false);
});
import { createRequire as __createRequire } from "node:module";
import __path from "node:path";
import __url from "node:url";
globalThis.require = __createRequire(import.meta.url);
globalThis.__filename = __url.fileURLToPath(import.meta.url);
globalThis.__dirname = __path.dirname(globalThis.__filename);

// src/__tests__/auth.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// src/middlewares/auth.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return value;
}
function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}
function createAdminSession() {
  const payload = Buffer.from(
    JSON.stringify({ role: "owner", exp: Date.now() + SESSION_AGE_SECONDS * 1e3 })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function isAdminSession(token) {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return false;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );
    return parsed.role === "owner" && typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

// src/__tests__/auth.test.ts
process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
test("accepts a server-signed administrator session", () => {
  assert.equal(isAdminSession(createAdminSession()), true);
});
test("rejects a missing administrator session", () => {
  assert.equal(isAdminSession(void 0), false);
});
test("rejects a modified administrator session", () => {
  const valid = createAdminSession();
  const modified = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
  assert.equal(isAdminSession(modified), false);
});
//# sourceMappingURL=auth.test.mjs.map

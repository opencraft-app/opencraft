import test from "node:test";
import assert from "node:assert/strict";

process.env.ADMIN_SESSION_SECRET = "test-session-secret";

// @ts-expect-error Node test runner requires explicit extension here.
const {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
} = await import("./admin-session-constants.ts");
// @ts-expect-error Node test runner requires explicit extension here.
const {
  createAdminSessionValue,
  readAdminSessionToken,
  readAdminSessionTokenFromCookieHeader,
  createAdminSessionCookie,
  createClearedAdminSessionCookie,
} = await import("./admin-session.ts");

test("createAdminSessionValue round-trips the token", () => {
  const value = createAdminSessionValue("secret-admin-token", 1_700_000_000);
  assert.equal(readAdminSessionToken(value, 1_700_000_100), "secret-admin-token");
});

test("readAdminSessionToken rejects expired values", () => {
  const value = createAdminSessionValue("secret-admin-token", 1_700_000_000);
  assert.equal(readAdminSessionToken(value, 1_700_000_000 + ADMIN_SESSION_TTL_SECONDS + 1), null);
});

test("readAdminSessionTokenFromCookieHeader extracts the session token", () => {
  const now = Math.floor(Date.now() / 1000);
  const value = createAdminSessionValue("secret-admin-token", now);
  const cookieHeader = `${ADMIN_SESSION_COOKIE}=${value}; other=1`;
  assert.equal(readAdminSessionTokenFromCookieHeader(cookieHeader), "secret-admin-token");
});

test("createAdminSessionCookie sets secure httpOnly attributes", () => {
  const cookie = createAdminSessionCookie("secret-admin-token");
  assert.match(cookie, /^admin_session=/);
  assert.match(cookie, /Path=\/admin\/gateway/);
  assert.match(cookie, /Max-Age=259200/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("createClearedAdminSessionCookie expires the session cookie", () => {
  const cookie = createClearedAdminSessionCookie();
  assert.match(cookie, /^admin_session=/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { accountFailureDiagnostic } from "../../packages/account-pool-host/src/account-diagnostics.js";

test("account diagnostics classify refresh failures without leaking provider messages or arbitrary error fields", () => {
  const secret = "synthetic-token-do-not-log";
  const error = Object.assign(new Error(`refresh_token_reused Bearer ${secret} private@example.invalid`), {
    code: secret, status: 401, stack: secret,
  });
  const result = accountFailureDiagnostic(error);
  assert.equal(result.reason, "refresh-token-reused");
  assert.equal(result.code, null);
  assert.equal(result.upstreamStatus, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|Bearer|example.invalid/u);
  assert.equal(result.fingerprint, accountFailureDiagnostic(new Error(error.message)).fingerprint);
  assert.notEqual(result.fingerprint, accountFailureDiagnostic(new Error("different failure")).fingerprint);
});

test("usage HTTP failure is distinct from authentication and transport failure", () => {
  assert.equal(accountFailureDiagnostic(new Error("Codex usage refresh failed (HTTP 503)")).upstreamStatus, 503);
  assert.equal(accountFailureDiagnostic(new Error("Codex usage refresh failed (HTTP 503)")).reason, "usage-http-error");
  assert.equal(accountFailureDiagnostic(Object.assign(new Error("private path"), { code: "ENOENT" })).code, "ENOENT");
  assert.equal(accountFailureDiagnostic(null).reason, "unclassified");
});


test("repeated refresh failures remain bounded and preserve unauthorized classification", () => {
  for (const prefix of ["token refresh failed ", "refresh "]) {
    assert.equal(accountFailureDiagnostic(new Error(prefix.repeat(20_000))).reason, "unclassified");
    assert.equal(accountFailureDiagnostic(new Error(prefix.repeat(20_000) + "401 Unauthorized")).reason, "oauth-refresh-unauthorized");
  }
});

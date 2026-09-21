import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error Node test runner requires explicit extension here.
const { requiresDashboardAdminValidation } = await import("./admin-route-policy.ts");

test("shadow binding mutations require a validated dashboard admin session", () => {
  assert.equal(requiresDashboardAdminValidation(["shadow-bindings"]), true);
  assert.equal(requiresDashboardAdminValidation(["shadow-bindings", "usr_1"]), true);
});

test("existing Auth admin routes retain their current proxy policy", () => {
  assert.equal(requiresDashboardAdminValidation(["users"]), false);
  assert.equal(requiresDashboardAdminValidation(["invites"]), false);
});

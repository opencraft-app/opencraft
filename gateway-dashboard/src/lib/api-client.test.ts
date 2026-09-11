import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error Node test runner requires explicit extension here.
const { ApiError, buildApiURL } = await import("./api-client.ts");

test("buildApiURL targets the dashboard basePath API route for direct access", () => {
  const url = buildApiURL("ai-gateway/stats", "https://admin.example.com");

  assert.equal(url.toString(), "https://admin.example.com/admin/gateway/api/ai-gateway/stats");
});

test("buildApiURL preserves query params", () => {
  const url = buildApiURL("ai-gateway/users", "https://admin.example.com", {
    page: 2,
    search: "alice",
    status: undefined,
  });

  assert.equal(url.toString(), "https://admin.example.com/admin/gateway/api/ai-gateway/users?page=2&search=alice");
});

test("ApiError surfaces CTL message envelopes", () => {
  const error = new ApiError(409, { code: "MIGRATION_CONFLICT", message: "user has multiple running bots" });

  assert.equal(error.message, "user has multiple running bots");
});

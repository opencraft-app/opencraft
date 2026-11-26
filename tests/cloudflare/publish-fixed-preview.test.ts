import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInheritedBindings,
  DEFAULT_PREVIEW_ORIGIN,
  DEFAULT_PREVIEW_WORKER,
  parsePublishArgs,
} from "../../scripts/cloudflare/publish-fixed-preview.ts";

test("parsePublishArgs applies fixed preview defaults and validates required inputs", () => {
  const parsed = parsePublishArgs(["--assets", "./dist-cf"], {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-token",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(parsed.worker, DEFAULT_PREVIEW_WORKER);
  assert.equal(parsed.origin, DEFAULT_PREVIEW_ORIGIN);
  assert.equal(parsed.revision, "0123456789abcdef0123456789abcdef01234567");

  assert.throws(
    () =>
      parsePublishArgs([], { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "t", GITHUB_SHA: "1234567" }),
    /Expected --assets/,
  );
  assert.throws(
    () =>
      parsePublishArgs(["--assets", "./dist-cf"], {
        CLOUDFLARE_ACCOUNT_ID: "bad",
        CLOUDFLARE_API_TOKEN: "t",
        GITHUB_SHA: "1234567",
      }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
});

test("buildInheritedBindings converts secret_text to inherit and preserves DO bindings", () => {
  const result = buildInheritedBindings([
    { name: "PREVIEW_PASSWORD", type: "secret_text" },
    { name: "ACCOUNT_CORE", type: "durable_object_namespace", class_name: "AccountCore", namespace_id: "ns-1" },
    { name: "PREVIEW_ORIGIN", type: "plain_text", text: "https://preview.opencraft.app" },
    { name: "ASSETS", type: "assets" },
  ]);
  assert.deepEqual(result, [
    { type: "inherit", name: "PREVIEW_PASSWORD" },
    { type: "durable_object_namespace", name: "ACCOUNT_CORE", class_name: "AccountCore", namespace_id: "ns-1" },
    { type: "plain_text", name: "PREVIEW_ORIGIN", text: "https://preview.opencraft.app" },
    { type: "assets", name: "ASSETS" },
  ]);
});

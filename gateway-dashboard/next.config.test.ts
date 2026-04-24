import test from "node:test";
import assert from "node:assert/strict";

import nextConfig from "./next.config.ts";

test("root path redirects to dashboard login base path", async () => {
  assert.equal(typeof nextConfig.redirects, "function");

  const redirects = await nextConfig.redirects();

  assert.deepEqual(redirects, [
    {
      source: "/",
      destination: "/admin/gateway/login",
      basePath: false,
      permanent: false,
    },
  ]);
});

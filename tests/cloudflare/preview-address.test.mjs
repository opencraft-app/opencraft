import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../scripts/cloudflare/preview-address-worker.mjs";

const origin = "https://opencraft-preview.example.workers.dev";
const target = "https://opencraft-preview-cf-aaaaaaaa.example.workers.dev";

test("the fixed address forwards the signed-in request to the selected preview", async () => {
  const env = {
    PREVIEW_PUBLIC_ORIGIN: origin,
    PREVIEW_TARGET_ORIGIN: target,
    PREVIEW_TARGET: {
      async fetch(request) {
        assert.equal(request.url, target + "/__opencraft_auth/local?q=1");
        assert.equal(request.headers.get("origin"), target);
        assert.equal(request.headers.get("cookie"), "isolated_session=example");
        assert.equal(await request.text(), "test");
        return new Response("ok", { headers: { "set-cookie": "isolated_session=next; Secure; Path=/" } });
      },
    },
  };
  const response = await worker.fetch(
    new Request(origin + "/__opencraft_auth/local?q=1", {
      method: "POST",
      headers: { origin, cookie: "isolated_session=example" },
      body: "test",
    }),
    env,
  );
  assert.equal(response.headers.get("set-cookie"), "isolated_session=next; Secure; Path=/");
  assert.equal(await response.text(), "ok");
});

test("foreign Origins are refused and same-site redirects stay at the fixed address", async () => {
  let calls = 0;
  const env = {
    PREVIEW_PUBLIC_ORIGIN: origin,
    PREVIEW_TARGET_ORIGIN: target,
    PREVIEW_TARGET: {
      async fetch() {
        calls++;
        return Response.redirect(target + "/local/thread?q=1");
      },
    },
  };
  assert.equal((await worker.fetch(new Request(origin, { headers: { origin: target } }), env)).status, 403);
  assert.equal(calls, 0);
  const response = await worker.fetch(new Request(origin), env);
  assert.equal(response.headers.get("location"), origin + "/local/thread?q=1");
});

test("the custom address shares the target and keeps origin checks local to its hostname", async () => {
  const customOrigin = "https://preview.example.com";
  const env = {
    PREVIEW_PUBLIC_ORIGIN: origin,
    PREVIEW_CUSTOM_ORIGIN: customOrigin,
    PREVIEW_TARGET_ORIGIN: target,
    PREVIEW_TARGET: {
      async fetch(request) {
        assert.equal(request.headers.get("origin"), target);
        return Response.redirect(target + "/local/preview");
      },
    },
  };
  assert.equal((await worker.fetch(new Request(customOrigin, { headers: { origin } }), env)).status, 403);
  const response = await worker.fetch(new Request(customOrigin, { headers: { origin: customOrigin } }), env);
  assert.equal(response.headers.get("location"), customOrigin + "/local/preview");
});

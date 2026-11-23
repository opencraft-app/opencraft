import assert from "node:assert/strict";
import test from "node:test";
import {
  personalSubscriptionRoute,
  personalSubscriptionTarget,
} from "../../apps/codex-core/src/personal-subscription-route.ts";

const subscription = "a".repeat(64);

test("only the exact personal subscription paths are forwarded", () => {
  assert.deepEqual(personalSubscriptionRoute(`/personal/${subscription}/v1/models`), {
    subscription,
    endpoint: "models",
  });
  for (const url of [
    undefined,
    `//evil.example/personal/${subscription}/v1/models`,
    `/personal/${subscription}/v1/models?next=//evil.example`,
    `/personal/${subscription}/v1/other`,
    `/personal/${"A".repeat(64)}/v1/responses`,
    `/personal/${subscription}/v1/responses/../../admin`,
  ])
    assert.equal(personalSubscriptionRoute(url), null, String(url));
});

test("the forwarded URL keeps the upstream origin and the validated path only", () => {
  const route = personalSubscriptionRoute(`/personal/${subscription}/v1/responses`)!;
  const target = personalSubscriptionTarget("https://upstream.example/base/path?x=1", route);
  assert.equal(target.href, `https://upstream.example/personal/${subscription}/v1/responses`);
  assert.throws(() =>
    personalSubscriptionTarget("https://upstream.example", { subscription: "x@evil", endpoint: "models" }),
  );
});

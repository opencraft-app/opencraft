import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationNavigation } from "../../../../apps/workbench-web/src/runtime/workbench-navigation";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
test("one router guard fences PUSH, POP, REPLACE and obsolete confirmation callbacks", async () => {
  const n = createApplicationNavigation(null, { mode: "memory" });
  n.openExtensionView("assets");
  const attempts: Array<{ proceed(): void; cancel(): void }> = [];
  const stop = n.registerNavigationGuard(
    () => true,
    (attempt) => attempts.push(attempt),
  );
  n.openChat();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  attempts.at(-1)!.cancel();
  await settle();
  n.openSettings();
  await settle();
  const stale = attempts.at(-1)!;
  n.openChat();
  await settle();
  stale.proceed();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  attempts.at(-1)!.cancel();
  await settle();
  n.openSettings("appearance", "replace");
  await settle();
  attempts.at(-1)!.cancel();
  n.back();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  attempts.at(-1)!.proceed();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "conversation");
  stop();
  n.dispose();
});
test("retiring an account/view cancels its pending navigation rather than consenting", async () => {
  const n = createApplicationNavigation(null, { mode: "memory" });
  n.openExtensionView("assets");
  let attempt: { proceed(): void; cancel(): void } | undefined;
  const stop = n.registerNavigationGuard(
    () => true,
    (value) => (attempt = value),
  );
  n.openChat();
  await settle();
  assert.ok(attempt);
  stop();
  attempt.proceed();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  n.openChat();
  await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "conversation");
  n.dispose();
});


test("connected Workbench forwards the guard to the same router", async () => {
  const { createWorkbenchNavigationTransaction } = await import("../../../../apps/workbench-web/src/runtime/workbench-navigation-transaction");
  const { createWorkbenchDraftLocation } = await import("../../../../packages/workbench-runtime/src/index");
  const n = createWorkbenchNavigationTransaction(createWorkbenchDraftLocation("local", "a"), {
    setViewId() {}, cancelPending() {}, prepare: async () => null,
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  n.openExtensionView("assets");
  let attempt: {proceed():void;cancel():void}|undefined;
  const stop = n.registerNavigationGuard(() => true, value => attempt=value);
  n.openSettings(); await settle(); assert.ok(attempt);
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  attempt.cancel(); await n.openChat(); await settle();
  assert.equal(n.getSnapshot().applicationRoute.kind, "extension-view");
  attempt!.proceed(); await settle(); assert.equal(n.getSnapshot().applicationRoute.kind, "conversation");
  stop(); n.dispose();
});

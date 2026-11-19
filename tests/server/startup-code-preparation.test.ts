import assert from "node:assert/strict";
import test from "node:test";
import { prepareStartupCode } from "../../apps/workbench-web/src/runtime/startup-code-preparation";

test("required modules start concurrently without waiting for or activating a slow provider", async () => {
  const controller = new AbortController(),
    started: string[] = [];
  prepareStartupCode(
    [
      () => {
        started.push("slow");
        return new Promise(() => {});
      },
      async () => {
        started.push("next");
      },
    ],
    controller.signal,
  );
  await Promise.resolve();
  assert.deepEqual(started, ["slow", "next"]);
  controller.abort();
});
test("retirement before preparation prevents code acquisition", async () => {
  const controller = new AbortController();
  let calls = 0;
  prepareStartupCode(
    [
      async () => {
        calls++;
      },
    ],
    controller.signal,
  );
  controller.abort();
  await Promise.resolve();
  assert.equal(calls, 0);
});
test("failed or throwing code preparation neither blocks another module nor creates an unhandled rejection", async () => {
  let calls = 0;
  prepareStartupCode(
    [
      () => {
        throw Error("chunk");
      },
      async () => {
        throw Error("network");
      },
      async () => {
        calls++;
      },
    ],
    new AbortController().signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

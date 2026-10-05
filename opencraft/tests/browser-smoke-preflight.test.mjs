import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserRuntimeDependencies } from "../scripts/browser-smoke-preflight.mjs";

test("browser preflight lists missing libraries before browser launch", () => {
  assert.throws(() => assertBrowserRuntimeDependencies("/confirmed/chrome", { platform: "linux", run: () =>
    "\tlibgbm.so.1 => not found\n\tlibasound.so.2 => /usr/lib64/libasound.so.2 (0x123)\n\tlibwayland-server.so.0 => not found\n" }),
  /libgbm.so.1, libwayland-server.so.0/u);
});
test("browser preflight uses the confirmed binary and actual library environment", () => {
  const env = { LD_LIBRARY_PATH: "/tooling-libs" };
  assert.doesNotThrow(() => assertBrowserRuntimeDependencies("/confirmed/chrome", { platform: "linux", env,
    run(command, args, options) {
      assert.equal(command, "ldd"); assert.deepEqual(args, ["/confirmed/chrome"]); assert.equal(options.env, env);
      return "libgbm.so.1 => /tooling-libs/libgbm.so.1 (0x123)";
    } }));
});
test("preflight fails closed on dependency inspection errors without mutating the machine", () => {
  assert.throws(() => assertBrowserRuntimeDependencies("/missing/chrome", { platform: "linux", run: () => { throw Error("ldd failed"); } }), /Cannot inspect/u);
  assert.doesNotThrow(() => assertBrowserRuntimeDependencies(undefined, { platform: "darwin", run: () => { throw Error("must not run"); } }));
});

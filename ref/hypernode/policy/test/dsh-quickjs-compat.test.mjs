import assert from "node:assert/strict";
import test from "node:test";
import { installDshQuickJsCompatibility } from "../src/runtime/dsh-quickjs-compat.js";

test("DSH QuickJS compatibility leaves native Node intrinsics and user functions intact", () => {
  function userFunction() { return true; }
  const before = Function.prototype.toString.call(userFunction);
  installDshQuickJsCompatibility();
  assert.equal(Function.prototype.toString.call(Object), "function Object() { [native code] }");
  assert.equal(Function.prototype.toString.call(Array), "function Array() { [native code] }");
  assert.equal(Function.prototype.toString.call(userFunction), before);
});

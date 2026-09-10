import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { createNativeLoginStorage } = createRequire(import.meta.url)("../apps/workbench-expo/src/runtime/native-login-storage.ts") as typeof import("../apps/workbench-expo/src/runtime/native-login-storage");

test("compare/delete and replacement writes are serialized", async () => {
  let saved: string | null = "old";
  const storage = createNativeLoginStorage({
    read: async () => { await Promise.resolve(); return saved; },
    write: async value => { saved = value; },
    remove: async () => { saved = null; },
  });
  await Promise.all([storage.remove("old"), storage.write("new"), storage.remove("old")]);
  assert.equal(await storage.read(), "new");
});

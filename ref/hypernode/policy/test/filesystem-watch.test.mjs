import assert from "node:assert/strict";
import test from "node:test";

import { resolveFilesystemWatch } from "../src/services/filesystem-watch.ts";

test("filesystem watches use the first owning namespace", () => {
  const watch = resolveFilesystemWatch("/workspace/repo/../repo/.git", [{
    owns: (path) => path.startsWith("/workspace/"),
    normalize: (path) => path,
  }], () => {
    throw new Error("must not use fallback");
  });
  assert.deepEqual(watch, { path: "/workspace/repo/.git", routable: true });
});

test("unroutable absolute watches become inert instead of retryable errors", () => {
  const watch = resolveFilesystemWatch("/data/hypernode/.git", [], () => {
    throw new Error("path is outside /workspace");
  });
  assert.equal(watch.path, "/data/hypernode/.git");
  assert.equal(watch.routable, false);
  assert.match(watch.error.message, /outside \/workspace/);
});

test("filesystem watches still reject non-absolute and escaping paths", () => {
  assert.throws(() => resolveFilesystemWatch("relative", [], () => "/"), /absolute/);
  assert.throws(() => resolveFilesystemWatch("/../escape", [], () => "/"), /escapes/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../apps/workbench-web/src/workbench-root.tsx", import.meta.url),
  "utf8",
);

test("BFCache pagehide preserves the live Workbench owner graph", () => {
  assert.match(source, /if \(!event\.persisted\) void application\.dispose\(\)/u);
  assert.doesNotMatch(source, /addEventListener\("pagehide", dispose, \{ once: true \}\)/u);
});

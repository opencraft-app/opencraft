import assert from "node:assert/strict";
import test from "node:test";
import { lintSourceGroups } from "../../scripts/lint-source-groups.mjs";

test("typed workspaces use separate workers without dropping test or root sources", () => {
  const files = [
    "apps/web/src/a.ts",
    "tests/a.test.ts",
    "packages/core/src/b.ts",
    "apps/web/src/c.tsx",
    "scripts/tool.mjs",
    "plugins/example/src/index.ts",
  ];
  const groups = lintSourceGroups(files);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.find((group) => group.includes(files[0])),
    [files[0], files[3]],
  );
  assert.deepEqual(
    groups.find((group) => group.includes(files[1])),
    [files[1], files[4]],
  );
  assert.deepEqual(groups.flat().sort(), [...files].sort());
  assert.deepEqual(lintSourceGroups([]), []);
});

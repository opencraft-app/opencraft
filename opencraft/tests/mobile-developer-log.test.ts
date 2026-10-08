import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import type * as DeveloperLogCore from "../apps/workbench-expo/src/runtime/mobile-developer-log-core";

const { appendDeveloperLine } = createRequire(import.meta.url)(
  "../apps/workbench-expo/src/runtime/mobile-developer-log-core.ts",
) as typeof DeveloperLogCore;

test("developer log retains only the latest 100 lines and numeric facts", () => {
  let lines = [] as ReturnType<typeof appendDeveloperLine>;
  for (let index = 0; index < 105; index++) {
    lines = appendDeveloperLine(lines, `time-${index}`, "avatar.upload.response", {
      status: 400 + index,
      bytes: 200,
      // A mistaken caller cannot persist arbitrary personal data.
      token: "private-value",
    } as Parameters<typeof appendDeveloperLine>[3]);
  }
  assert.equal(lines.length, 100);
  assert.equal(lines[0]?.time, "time-5");
  assert.deepEqual(lines.at(-1)?.facts, { status: 504, bytes: 200 });
  assert.equal(JSON.stringify(lines).includes("private-value"), false);

  const scriptFailure = appendDeveloperLine(lines, "now", "bot.runtime.script.failed", {
    kind: 1, line: 2, column: 3, endpoint: 1, message: "private exception text",
  } as Parameters<typeof appendDeveloperLine>[3]);
  assert.deepEqual(scriptFailure.at(-1)?.facts, { kind: 1, line: 2, column: 3, endpoint: 1 });
  assert.equal(JSON.stringify(scriptFailure).includes("private exception text"), false);
});

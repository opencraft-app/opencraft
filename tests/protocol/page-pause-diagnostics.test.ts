import assert from "node:assert/strict";
import test from "node:test";
import { createPagePauseDiagnostics } from "../../apps/workbench-web/src/runtime/page-pause-diagnostics";

test("foreground failure retains a completed mobile pause without assuming network availability", () => {
  let time = 1000;
  const page = createPagePauseDiagnostics(() => time);
  assert.deepEqual(page.snapshot(), {});
  page.pause(); time += 5000; page.pause(); time += 89000;
  assert.deepEqual(page.snapshot(), { pageHiddenForMs: 94000 });
  page.resume(); time += 30; page.resume();
  assert.deepEqual(page.snapshot(), { pagePauseMs: 94000, pageResumeAgoMs: 30 });
  page.pause(); time += 2000;
  assert.deepEqual(page.snapshot(), { pagePauseMs: 94000, pageResumeAgoMs: 2030, pageHiddenForMs: 2000 });
});

test("a restored page with missing pause observation reports unknown duration", () => {
  let time = 100;
  const page = createPagePauseDiagnostics(() => time);
  page.resume(); assert.deepEqual(page.snapshot(), {});
  page.resume(true); time += 20;
  assert.deepEqual(page.snapshot(), { pageResumeAgoMs: 20 });
  time = 0; assert.deepEqual(page.snapshot(), { pageResumeAgoMs: 0 });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopUiPreferenceStore } from "../apps/workbench-electron/src/ui-preferences-store.ts";

test("Electron UI preferences persist with revision conflicts and a fixed key registry", () => {
  const root = mkdtempSync(join(tmpdir(), "opencraft-ui-preferences-"));
  const path = join(root, "opencraft-ui.sqlite");
  try {
    const first = new DesktopUiPreferenceStore(path);
    assert.equal(first.load("shell.applicationsPinned"), null);
    const stored = first.compareAndSet("shell.applicationsPinned", 0, "true");
    assert.equal(stored.outcome, "updated");
    assert.equal(first.compareAndSet("shell.applicationsPinned", 0, "false").outcome, "conflict");
    assert.throws(() => first.load("arbitrary.preference"), /Invalid UI preference key/u);
    first.close();

    const reopened = new DesktopUiPreferenceStore(path);
    assert.deepEqual(reopened.load("shell.applicationsPinned"), stored.outcome === "updated"
      ? stored.record
      : null);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

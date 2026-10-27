import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopUiPreferenceStore } from "../../apps/workbench-electron/src/ui-preferences-store.ts";

test("Electron UI preferences persist with revision conflicts and a fixed key registry", () => {
  const root = mkdtempSync(join(tmpdir(), "opencraft-ui-preferences-"));
  const path = join(root, "opencraft-ui.sqlite");
  try {
    const first = new DesktopUiPreferenceStore(path);
    assert.equal(first.load("shell.applicationsPinned"), null);
    const stored = first.compareAndSet("shell.applicationsPinned", 0, "true");
    assert.equal(stored.outcome, "updated");
    assert.equal(first.compareAndSet("shell.applicationsPinned", 0, "false").outcome, "conflict");
    assert.equal(first.compareAndSet("chat.defaultFollowUpAction", 0, '"queue"').outcome, "updated");
    assert.throws(() => first.load("arbitrary.preference"), /Invalid UI preference key/u);
    first.close();

    const reopened = new DesktopUiPreferenceStore(path);
    assert.equal(reopened.load("chat.defaultFollowUpAction")?.valueJson, '"queue"');
    assert.deepEqual(reopened.load("shell.applicationsPinned"), stored.outcome === "updated"
      ? stored.record
      : null);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";

test("DesktopUiPreferenceStore manages SQLite lifecycle: fresh, up-to-date, adopted, and moved-aside", () => {
  const root = mkdtempSync(join(tmpdir(), "opencraft-ui-lifecycle-"));
  const path = join(root, "opencraft-ui.sqlite");
  try {
    // 1. Fresh
    const fresh = new DesktopUiPreferenceStore(path);
    assert.equal(fresh.outcome.status, "fresh");
    fresh.compareAndSet("shell.applicationsPinned", 0, "true");
    fresh.close();

    // 2. Up-to-date
    const reopened = new DesktopUiPreferenceStore(path);
    assert.equal(reopened.outcome.status, "up-to-date");
    assert.equal(reopened.load("shell.applicationsPinned")?.valueJson, "true");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DesktopUiPreferenceStore adopts legacy matching database and moves aside mismatched legacy database", () => {
  for (const matching of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), `opencraft-ui-legacy-${matching ? "match" : "mismatch"}-`));
    const path = join(root, "opencraft-ui.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE ui_preferences (
          key TEXT PRIMARY KEY NOT NULL,
          value_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      if (matching) {
        raw.prepare("INSERT INTO ui_preferences VALUES (?, ?, ?, ?)").run("shell.applicationsPinned", "true", 1, 100);
      } else {
        raw.exec("CREATE TABLE extra_table (id TEXT PRIMARY KEY)");
      }
      raw.close();

      const store = new DesktopUiPreferenceStore(path);
      try {
        assert.equal(store.outcome.status, matching ? "adopted" : "moved-aside");
        assert.ok(store.outcome.backupPath);
        const files = readdirSync(root);
        assert.ok(files.some(f => f.includes(".pre-v1-")));
        assert.equal(files.some(f => f.includes(".legacy-")), !matching);

        if (matching) {
          assert.equal(store.load("shell.applicationsPinned")?.valueJson, "true");
        } else {
          assert.equal(store.load("shell.applicationsPinned"), null);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  reorderPanelTabPreview,
  resolvePanelTabCommit,
  RIGHT_PANEL_TAB_DROP_TAIL_ID,
} from "../apps/workbench-web/src/components/right-panel-tab-drag.ts";

test("tab drag owns a reversible preview without mutating committed order", () => {
  const committed = Object.freeze(["browser", "terminal", "files"]);
  const preview = reorderPanelTabPreview(committed, "terminal", "browser");
  assert.deepEqual(committed, ["browser", "terminal", "files"]);
  assert.deepEqual(preview, ["terminal", "browser", "files"]);
  assert.deepEqual(resolvePanelTabCommit(committed, preview, "terminal"), {
    tabId: "terminal",
    beforeTabId: "browser",
  });
});

test("dropping on strip tail produces one append commit", () => {
  const committed = ["browser", "terminal", "files"];
  const preview = reorderPanelTabPreview(
    committed,
    "browser",
    RIGHT_PANEL_TAB_DROP_TAIL_ID,
  );
  assert.deepEqual(preview, ["terminal", "files", "browser"]);
  assert.deepEqual(resolvePanelTabCommit(committed, preview, "browser"), {
    tabId: "browser",
    beforeTabId: null,
  });
});

test("cancelled or stationary drags require no model command", () => {
  const committed = ["browser", "terminal"];
  assert.strictEqual(
    reorderPanelTabPreview(committed, "terminal", "terminal"),
    committed,
  );
  assert.equal(resolvePanelTabCommit(committed, committed, "terminal"), null);
});

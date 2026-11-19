import assert from "node:assert/strict";
import test from "node:test";
import { requiresInitialPresentation } from "../../apps/workbench-web/src/runtime/initial-presentation";

test("presentation deferral preserves landing views and settings but never classifies chat or unrelated pages as required", () => {
  const views = ["opencraft.schedules.view"],
    settings = ["opencraft.schedules"];
  assert.equal(requiresInitialPresentation({ kind: "conversation" }, views, settings), false);
  assert.equal(
    requiresInitialPresentation({ kind: "extension-view", viewId: views[0]!, resourceUri: null }, views, settings),
    true,
  );
  assert.equal(requiresInitialPresentation({ kind: "settings", slug: settings[0]! }, views, settings), true);
  assert.equal(requiresInitialPresentation({ kind: "settings", slug: "appearance" }, views, settings), false);
  assert.equal(
    requiresInitialPresentation({ kind: "extension-view", viewId: "other", resourceUri: null }, views, settings),
    false,
  );
  assert.equal(
    requiresInitialPresentation({ kind: "extension-view", viewId: "opencraft.overhome.view", resourceUri: null }, [
      "opencraft.overhome.view",
    ]),
    true,
  );
});

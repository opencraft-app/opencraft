import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptivePanel, projectPanel } from "../packages/workbench-runtime/src/adaptive-panel";
const primary = { id: "list", minWidth: 220 };
const secondary = { id: "provider:a", minWidth: 360 };

test("selection and compact focus are independent; Back retains the page", () => {
  const panel = new AdaptivePanel();
  panel.seed(secondary.id);
  assert.deepEqual(projectPanel(panel.getSnapshot(), primary, secondary, 400).visible, ["list"]);
  panel.select(secondary.id);
  assert.equal(projectPanel(panel.getSnapshot(), primary, secondary, 400).canGoBack, true);
  panel.back();
  assert.equal(panel.getSnapshot().secondaryId, secondary.id);
  assert.deepEqual(projectPanel(panel.getSnapshot(), primary, secondary, 580).visible, [primary.id, secondary.id]);
  panel.select(secondary.id);
  assert.equal(panel.getSnapshot().active, "secondary");
});
test("resize is a pure projection, independent for each container", () => {
  const panel = new AdaptivePanel(); panel.select(secondary.id);
  const snapshot = panel.getSnapshot();
  let changes = 0; panel.subscribe(() => changes++);
  for (const width of [0, 400, 580, 1000, 200]) projectPanel(snapshot, primary, secondary, width);
  assert.equal(panel.getSnapshot(), snapshot); assert.equal(changes, 0);
  assert.equal(projectPanel(snapshot, primary, secondary, 579).split, false);
  assert.equal(projectPanel(snapshot, primary, secondary, 580).split, true);
});
test("seed never overwrites user selection; only explicit close clears it", () => {
  const panel = new AdaptivePanel(); panel.select("create"); panel.back(); panel.seed(secondary.id);
  assert.equal(panel.getSnapshot().secondaryId, "create");
  panel.clear(); assert.equal(panel.getSnapshot().secondaryId, null);
  assert.throws(() => projectPanel({ secondaryId: "missing", active: "secondary" }, primary, secondary, 800));
});

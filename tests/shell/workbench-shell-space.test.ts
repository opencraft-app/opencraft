import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellSpace, shellSpaceMetrics, workbenchWindowMetrics, type ShellSpaceInput } from "../../packages/workbench-runtime/src/shell-space";
import { createShellNavigationState, projectShellNavigation } from "../../packages/workbench-runtime/src/shell-navigation";
import { getRightPanelWidthBounds, interpolateRightPanelWidth } from "../../packages/workbench-panels/src/model";

const input: ShellSpaceInput = {
  width: 1500, navigationOpen: true, navigationDetent: "expanded", navigationWidth: 182,
  contextOpen: true, contextWidth: 275, rightOpen: true, rightFullWidth: false,
};

test("native window width and immersive shell fallback share the shared minimum", () => {
  assert.equal(workbenchWindowMetrics.minimumWidth, 480);
  assert.equal(shellSpaceMetrics.mainMinimum, workbenchWindowMetrics.minimumWidth);
  const minimum = resolveShellSpace({ ...input, width: workbenchWindowMetrics.minimumWidth });
  assert.equal(minimum.level, 4);
  assert.equal(minimum.navigationOpen, false);
  assert.equal(minimum.contextOpen, false);
  assert.equal(minimum.rightOpen, false);
});

test("width pressure reduces the extra application pane before tools and context", () => {
  const cases = [[1500, 0], [1200, 1], [1100, 2], [1000, 3], [700, 4]];
  for (const [width, level] of cases) assert.equal(resolveShellSpace({ ...input, width }).level, level);
  assert.deepEqual(resolveShellSpace({ ...input, width: 700 }), {
    level: 4, navigationDetent: "hidden", navigationWidth: 0, navigationOpen: false,
    contextOpen: false, rightOpen: false, leftWidth: 0, rightAvailable: false,
  });
});

test("all pane width combinations preserve usable main content; immersive fits tiny windows", () => {
  for (const width of [320, 480, 640, 800, 960, 1000, 1200, 1600, 2200]) {
    for (const navigationWidth of [168, 182, 340, 520]) for (const contextWidth of [240, 275, 520]) {
      for (const rightOpen of [true, false]) for (const contextOpen of [true, false]) {
        const result = resolveShellSpace({ ...input, width, navigationWidth, contextWidth, rightOpen, contextOpen });
        assert.ok(width - result.leftWidth - (result.rightOpen ? 320 : 0) >= Math.min(width, shellSpaceMetrics.mainMinimum));
        assert.ok(!result.contextOpen || contextOpen);
        assert.ok(!result.rightOpen || rightOpen);
      }
    }
  }
});

test("widening restores intent with hysteresis and does not reopen manually closed tools", () => {
  assert.equal(resolveShellSpace({ ...input, width: 1260, previousLevel: 1 }).level, 1);
  assert.equal(resolveShellSpace({ ...input, width: 1290, previousLevel: 1 }).level, 0);
  assert.equal(resolveShellSpace({ ...input, width: 1200, previousLevel: 0 }).level, 1);
  assert.equal(resolveShellSpace({ ...input, width: 1500, rightOpen: false, previousLevel: 4 }).rightOpen, false);
  assert.equal(resolveShellSpace({ ...input, navigationDetent: "compact", previousLevel: 4 }).navigationDetent, "compact");
  assert.equal(input.navigationDetent, "expanded");
});

test("context-free routes and closed Sidecar never reserve phantom columns", () => {
  const result = resolveShellSpace({ ...input, width: 640, contextOpen: false, rightOpen: false });
  assert.equal(result.navigationDetent, "compact");
  assert.equal(result.leftWidth, 52);
  const closed = resolveShellSpace({ ...input, width: 900, navigationOpen: false, contextOpen: false });
  assert.equal(closed.leftWidth, 0);
  assert.equal(closed.rightOpen, true);
});

test("full-width tools replace the main viewport instead of paying for two columns", () => {
  const result = resolveShellSpace({ ...input, width: 900, rightFullWidth: true });
  assert.equal(result.rightOpen, true);
  assert.ok(900 - result.leftWidth >= 480);
});

test("tool resizing uses the same main reserve as the window arbiter", () => {
  for (const available of [800, 1000, 1600]) {
    const bounds = getRightPanelWidthBounds(available, "regular", shellSpaceMetrics.mainMinimum);
    assert.equal(bounds.maximum, available - shellSpaceMetrics.mainMinimum);
    for (const ratio of [0, 0.5, 1]) {
      assert.ok(available - interpolateRightPanelWidth(ratio, available, shellSpaceMetrics.mainMinimum) >= 480);
    }
  }
});

test("projected navigation labels, footer and peek follow the same responsive decision", () => {
  const state = createShellNavigationState({ applications: true });
  for (const width of [1500, 1200, 1100, 1000, 700]) {
    const space = resolveShellSpace({ ...input, width });
    const projection = projectShellNavigation({ state, space, viewportWidth: width, contextWidth: 275, contextAvailable: true, sidecarOpen: true });
    assert.equal(projection.dockOpen, space.navigationOpen);
    assert.equal(projection.contextOpen, space.contextOpen);
    assert.equal(projection.railDetent, space.navigationDetent);
    assert.equal(projection.footerVisible, space.navigationOpen || space.contextOpen);
  }
  assert.equal(state.railDetent, "expanded");
  assert.equal(state.pinned.applications, true);
});


test("presentation minimum includes the unified rail before dock admission", () => {
  const narrow = resolveShellSpace({ ...input, navigationOpen: false, contextWidth: 240,
    contextMinimumWidth: 288, rightOpen: false, width: 767 });
  assert.equal(narrow.contextOpen, false);
  const fits = resolveShellSpace({ ...input, navigationOpen: false, contextWidth: 240,
    contextMinimumWidth: 288, rightOpen: false, width: 768 });
  assert.equal(fits.leftWidth, 288);
  assert.equal(fits.contextOpen, true);
});

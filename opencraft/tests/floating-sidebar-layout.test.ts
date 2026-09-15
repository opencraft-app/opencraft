import assert from "node:assert/strict";
import test from "node:test";
import { floatingSidebarLayout } from "../apps/workbench-web/src/components/floating-sidebar-layout";
const input = { viewportWidth: 900, contextWidth: 275, primaryWidth: 137, contextAvailable: true, navigationAvailable: true, expanded: true };
test("floating surface contains both navigation and context independent of dock budget", () => {
  assert.deepEqual(floatingSidebarLayout(input), { primaryWidth: 137, contextWidth: 275, width: 412, detent: "expanded", canExpand: true });
  assert.equal(floatingSidebarLayout({ ...input, expanded: false }).width, 327);
});
test("narrow overlays retain app navigation while fitting their own viewport", () => {
  for (const viewportWidth of [320, 360, 400, 540, 700]) {
    const result = floatingSidebarLayout({ ...input, contextWidth: 520, viewportWidth });
    assert.ok(result.width <= viewportWidth - 24);
    assert.ok(result.primaryWidth >= 52); assert.ok(result.contextWidth > 0);
  }
  assert.equal(floatingSidebarLayout({ ...input, viewportWidth: 360 }).detent, "compact");
  assert.equal(input.expanded, true);
});
test("navigation-only and context-only shells remain valid", () => {
  assert.equal(floatingSidebarLayout({ ...input, contextAvailable: false }).contextWidth, 0);
  assert.equal(floatingSidebarLayout({ ...input, navigationAvailable: false }).primaryWidth, 0);
});

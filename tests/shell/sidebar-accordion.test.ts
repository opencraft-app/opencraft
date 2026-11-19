import assert from "node:assert/strict";
import { test } from "node:test";
import { sidebarAnchoredScrollTop } from "../../apps/workbench-web/src/components/use-sidebar-accordion";
const input = {
  scrollTop: 350,
  maxScrollTop: 2000,
  headingTop: 300,
  headingHeight: 40,
  anchorTop: 500,
  viewportTop: 100,
  viewportBottom: 800,
  readingRoom: 44,
};
test("collapse above the activated heading is compensated without adding a spacer", () => {
  assert.equal(sidebarAnchoredScrollTop(input), 150);
});
test("expansion above the activated heading is compensated", () => {
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: 700 }), 550);
});
test("scroll boundaries are clamped; no negative scroll or invented capacity", () => {
  assert.equal(sidebarAnchoredScrollTop({ ...input, scrollTop: 0, maxScrollTop: 0 }), 0);
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: 2000, maxScrollTop: 450 }), 450);
});
test("an opening heading reserves real reading room below itself", () => {
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: 780, anchorTop: 780 }), 414);
});
test("offscreen headings are brought to the existing viewport", () => {
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: 900, anchorTop: 900, readingRoom: 0 }), 490);
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: -50, anchorTop: -50 }), 200);
});
test("a short viewport still keeps its heading at the top", () => {
  assert.equal(sidebarAnchoredScrollTop({ ...input, headingTop: 300, anchorTop: 300, viewportBottom: 120 }), 550);
});

test("the shared safe viewport excludes floating footer clearance", () => {
  assert.equal(
    sidebarAnchoredScrollTop({ ...input, headingTop: 720, anchorTop: 720, viewportTop: 120, viewportBottom: 700 }),
    454,
  );
});

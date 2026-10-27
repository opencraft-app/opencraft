import assert from "node:assert/strict";
import test from "node:test";
test("route retention never evicts an actively subscribed owner", () => {
  const registry = new FloatingComposerRegistry();
  const active = registry.get("active");
  const unsubscribe = active.subscribe(() => {});
  active.hide("tab", true);
  for (let i = 0; i < 30; i++) { registry.get(`route-${i}`); registry.release(`route-${i}`); }
  assert.equal(registry.get("active"), active);
  assert.equal(active.getSnapshot().collapsedTabs.get("tab"), "manual");
  unsubscribe();
});
import {
  FloatingComposerState,
  FloatingComposerRegistry,
  projectFloatingComposer,
  ComposerWheelSwipeController,
} from "../../apps/workbench-web/src/components/floating-composer-state";
const project = (
  state: FloatingComposerState,
  tabId = "a",
  readiness: "ready" | "loading" | "unavailable" = "ready"
) =>
  projectFloatingComposer(state.getSnapshot(), {
    floating: true,
    tabId,
    readiness,
  });
test('mobile browser starts on demand through loading and retains explicit reveal intent', () => {
  const state = new FloatingComposerState();
  state.prepareMobileBrowser('a');
  for (const readiness of ['loading', 'ready', 'unavailable'] as const) {
    const view = projectFloatingComposer(state.getSnapshot(), { floating: true, tabId: 'a', readiness, onDemand: true });
    assert.equal(view.interactive, false);
  }
  state.show('a', true);
  state.focus('a');
  state.prepareMobileBrowser('a');
  assert.equal(project(state).interactive, true);
  state.prepareMobileBrowser('b');
  assert.equal(project(state, 'b').interactive, false);
  assert.equal(project(state).interactive, true);
});
test("browser compact/focused/peek are separate from latest turn and route visibility", () => {
  const state = new FloatingComposerState();
  assert.equal(project(state).density, "compact");
  state.focus("a");
  assert.equal(project(state).density, "expanded");
  state.hide("a", true);
  assert.equal(project(state).peeked, true);
  assert.equal(project(state).interactive, false);
  assert.equal(project(state, "b").peeked, false);
  state.show("a", true);
  assert.equal(project(state).interactive, true);
  state.toggle("a", true);
  assert.equal(project(state).mounted, false);
  state.toggle("a", true);
  assert.equal(project(state).interactive, true);
});
test("automatic policy never overwrites manual collapse or an active editor/menu", () => {
  const state = new FloatingComposerState();
  state.autoCollapse("a", true, true, true);
  assert.equal(project(state).peeked, false);
  state.hide("a", true);
  state.autoCollapse("a", false, false, true);
  assert.equal(state.getSnapshot().collapsedTabs.get("a"), "manual");
  state.autoCollapse("b", true, false, true);
  state.autoCollapse("b", false, false, true);
  assert.equal(state.getSnapshot().collapsedTabs.has("b"), false);
});
test("loading/unavailable browser cannot trap the composer in peek", () => {
  const state = new FloatingComposerState();
  state.hide("a", true);
  for (const readiness of ["loading", "unavailable"] as const) {
    assert.equal(project(state, "a", readiness).peeked, false);
    assert.equal(project(state, "a", readiness).interactive, true);
  }
});
test("late animation completion cannot reverse a newer transition", async () => {
  const state = new FloatingComposerState();
  state.hide("a");
  assert.equal(project(state).phase, "exiting");
  state.show("a");
  assert.equal(project(state).phase, "entering");
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(project(state).phase, "visible");
  state.hide("a");
  state.show("a", true);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(project(state).phase, "visible");
});
test("route store retains tab intent across presentation unmount, isolates other routes", () => {
  const registry = new FloatingComposerRegistry(),
    a = registry.get("a");
  a.hide("tab", true);
  registry.release("a");
  assert.equal(registry.get("a"), a);
  assert.equal(project(a, "tab").peeked, true);
  assert.equal(project(registry.get("b"), "tab").peeked, false);
});
test("wheel momentum stays with the initiating gesture until a new acceleration", () => {
  const swipe = new ComposerWheelSwipeController();
  swipe.beginSwipe({ deltaY: 80, timeStamp: 0 }, "peek");
  assert.equal(swipe.isContinuation({ deltaY: 30, timeStamp: 100 }), true);
  assert.equal(swipe.isContinuation({ deltaY: 10, timeStamp: 250 }), true);
  assert.equal(swipe.isContinuation({ deltaY: 45, timeStamp: 270 }), false);
  swipe.beginSwipe({ deltaY: 20, timeStamp: 500 }, "composer");
  assert.equal(swipe.isContinuation({ deltaY: 10, timeStamp: 700 }), false);
});

test("unready browsers and inline presentation retain an editor despite disabled floating intent", () => {
  const state = new FloatingComposerState();
  state.hide("a", true);
  state.toggle("b", true);
  for (const floating of [false, true]) {
    for (const readiness of ["loading", "unavailable"] as const) {
      const view = projectFloatingComposer(state.getSnapshot(), { floating, readiness, tabId: "a" });
      assert.equal(view.interactive, true);
      assert.equal(view.peeked, false);
      assert.equal(view.handles, false);
    }
  }
  state.toggle("b", true);
  const view = projectFloatingComposer(state.getSnapshot(), {
    floating: true, readiness: "ready", tabId: "a", forceExpanded: true,
  });
  assert.equal(view.density, "expanded");
  assert.equal(view.peeked, true);
  assert.equal(view.interactive, false);
});

test("automatic intent remains separate from global enable and focused-tab intent", () => {
  const state = new FloatingComposerState();
  state.focus("a");
  state.toggle("b", true);
  state.autoCollapse("a", true, false, true);
  assert.equal(state.getSnapshot().enabled, false);
  assert.equal(state.getSnapshot().focusedTab, "a");
  state.show("a", true);
  assert.equal(state.getSnapshot().collapsedTabs.get("a"), "auto-collapse");
  state.toggle("a", true);
  assert.equal(state.getSnapshot().enabled, true);
  assert.equal(state.getSnapshot().collapsedTabs.has("a"), false);
  assert.equal(state.getSnapshot().focusedTab, "a");
});

test("route reads refresh retention while release trims unsubscribed oldest routes", () => {
  const registry = new FloatingComposerRegistry();
  const a = registry.get("a"), b = registry.get("b");
  for (let i = 0; i < 18; i++) registry.get(`route-${i}`);
  assert.equal(registry.get("a"), a);
  registry.get("overflow");
  registry.release("overflow");
  assert.equal(registry.get("a"), a);
  assert.notEqual(registry.get("b"), b);
});

test("wheel idle boundaries and acceleration use the gesture peak and rolling clock", () => {
  for (const [origin, idle] of [["peek", 400], ["composer", 150]] as const) {
    const swipe = new ComposerWheelSwipeController();
    assert.equal(swipe.isContinuation({ deltaY: 1, timeStamp: 0 }), false);
    swipe.beginSwipe({ deltaY: 80, timeStamp: 0 }, origin);
    assert.equal(swipe.isContinuation({ deltaY: 30, timeStamp: 100 }), true);
    assert.equal(swipe.isContinuation({ deltaY: 10, timeStamp: 100 + idle - 1 }), true);
    assert.equal(swipe.isContinuation({ deltaY: 5, timeStamp: 100 + idle - 1 + idle }), false);
    assert.equal(swipe.isContinuation({ deltaY: 1, timeStamp: 100 + idle + idle }), false);
  }
  const swipe = new ComposerWheelSwipeController();
  swipe.beginSwipe({ deltaY: 1, timeStamp: 0 }, "peek");
  assert.equal(swipe.isContinuation({ deltaY: 80, timeStamp: 10 }), true);
  assert.equal(swipe.isContinuation({ deltaY: -30, timeStamp: 100 }), true);
  assert.equal(swipe.isContinuation({ deltaY: 38, timeStamp: 200 }), true);
  assert.equal(swipe.isContinuation({ deltaY: -47, timeStamp: 210 }), false);
});

test("route release and eviction settle pending presentation without erasing intent", () => {
  const registry = new FloatingComposerRegistry();
  const active = registry.get("active");
  const off = active.subscribe(() => {});
  active.hide("tab");
  registry.release("active");
  assert.equal(active.getSnapshot().phase, "hidden");
  assert.equal(active.getSnapshot().collapsedTabs.get("tab"), "manual");
  const oldest = registry.get("oldest");
  oldest.hide("tab");
  for (let i = 0; i < 22; i++) registry.get(`route-${i}`);
  registry.release("missing");
  assert.notEqual(registry.get("oldest"), oldest);
  assert.equal(oldest.getSnapshot().phase, "hidden");
  assert.equal(registry.get("active"), active);
  off();
});

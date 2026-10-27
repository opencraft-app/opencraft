import assert from "node:assert/strict";
import test from "node:test";
import { canInvokeHostPanelCommand, isHostPanelGeometry, isHostPanelState, resolveHostPanelGeometry,
  type HostPanelState } from "@opencraft/workbench-panels/host-presentation";

const state: HostPanelState = { ownerId: "thread-a", available: true, open: true, fullWidth: false,
  activeTabId: "file", tabs: [
    { id: "file", title: "Notes", kind: "resource", closable: true, preview: true },
    { id: "browser", title: "Browser", kind: "browser", closable: false, preview: false },
  ], actions: [{ id: "browser.new", label: "Browser", icon: "browser" }] };

test("host panel uses available space and preserves product state through continuous resizing", () => {
  for (const width of [390, 1024, 500, 672, 1200, 800, 390]) {
    const layout = resolveHostPanelGeometry(width, state, 54);
    assert.equal(layout.overlay, width < 672);
    assert.equal(isHostPanelGeometry(layout), true);
    if (layout.overlay) assert.equal(layout.panelWidth, width);
    else { assert.ok(layout.panelWidth >= 320); assert.ok(width - layout.panelWidth >= 352); }
    assert.equal(state.activeTabId, "file");
  }
  assert.equal(resolveHostPanelGeometry(1200, { ...state, fullWidth: true }, 54).panelWidth, 1200);
  assert.equal(resolveHostPanelGeometry(1200, { ...state, open: false }, 54).panelWidth, 0);
  assert.equal(resolveHostPanelGeometry(1200, { ...state, available: false }, 54).panelWidth, 0);
  assert.equal(resolveHostPanelGeometry(1200, null, 54).panelWidth, 0);
});

test("late commands cannot operate on another conversation or an unknown tab/action", () => {
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-b", action: "close", tabId: "file" }), false);
  assert.equal(canInvokeHostPanelCommand({ ...state, available: false }, { ownerId: "thread-a", action: "open", open: true }), false);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "select", tabId: "missing" }), false);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "close", tabId: "browser" }), false);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "move", tabId: "file", beforeTabId: "missing" }), false);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "launch", actionId: "execute-shell" }), false);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "close", tabId: "file" }), true);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "move", tabId: "file", beforeTabId: null }), true);
  assert.equal(canInvokeHostPanelCommand(state, { ownerId: "thread-a", action: "launch", actionId: "browser.new" }), true);
});

test("host wire rejects impossible geometry and incoherent tab identities", () => {
  const geometry = resolveHostPanelGeometry(900, state, 54);
  for (const change of [{ containerWidth: 0 }, { panelWidth: -1 }, { panelWidth: 901 }, { chromeHeight: NaN }, { overlay: "true" }]) {
    assert.equal(isHostPanelGeometry({ ...geometry, ...change }), false);
  }
  assert.equal(isHostPanelState(state), true);
  assert.equal(isHostPanelState({ ...state, tabs: [state.tabs[0], state.tabs[0]] }), false);
  assert.equal(isHostPanelState({ ...state, activeTabId: "missing" }), false);
});

test("held motion follows both directions and release projects from the current presentation", async () => {
  const { hostPanelDragProgress, hostPanelReleaseOpen, isHostPanelGesture } = await import("@opencraft/workbench-panels/host-presentation");
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9);
  for (const width of [390, 520, 834, 1366]) {
    close(hostPanelDragProgress(0, -width * 0.3, width), 0.3);
    close(hostPanelDragProgress(0.7, width * 0.2, width), 0.5);
    assert.equal(hostPanelReleaseOpen(0.3, 0, width), false);
    assert.equal(hostPanelReleaseOpen(0.7, 0, width), true);
    close(hostPanelDragProgress(0.4, -width * 0.1, width), 0.5);
    close(hostPanelDragProgress(0.4, width * 0.1, width), 0.3);
  }
  assert.equal(hostPanelReleaseOpen(0.3, -1000, 390), true);
  assert.equal(hostPanelReleaseOpen(0.7, 1000, 390), false);
  const gesture = { id: 1, phase: "move", translationX: -120, velocityX: 0 };
  assert.equal(isHostPanelGesture(gesture), true);
  for (const change of [{ id: 0 }, { id: 1.5 }, { phase: "commit" }, { translationX: NaN }, { velocityX: Infinity }]) {
    assert.equal(isHostPanelGesture({ ...gesture, ...change }), false);
  }
});

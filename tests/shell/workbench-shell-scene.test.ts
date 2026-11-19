import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  WorkbenchPanelService,
  createConversationPanelState,
  reduceConversationPanelState,
} from "@opencraft/workbench-panels";
import { resolveShellSpace } from "../../packages/workbench-runtime/src/shell-space";
import { projectShellScene, type ShellForeground } from "../../packages/workbench-runtime/src/shell-scene";
const project = (width: number, foreground: ShellForeground, open = true, full = false, touch = true) =>
  projectShellScene({
    space: resolveShellSpace({
      width,
      navigationOpen: false,
      navigationDetent: "hidden",
      navigationWidth: 137,
      contextOpen: false,
      contextWidth: 288,
      rightOpen: open,
      rightFullWidth: full,
    }),
    foreground,
    touch,
    toolsAvailable: true,
    toolsOpen: open,
    toolsMaximized: full,
  });
test("owner navigation survives A terminal -> A primary -> B -> A without closing resources", async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(WorkbenchPanelService);
  await fiber;
  const panels = ctx.workbenchPanels;
  let disposals = 0;
  panels.register({
    kind: "terminal",
    createTab: () => ({
      id: "terminal",
      kind: "terminal",
      region: "right",
      title: "Terminal",
      closable: true,
      preview: false,
    }),
    disposeTab() {
      disposals++;
    },
  });
  panels.open("A", "terminal", {});
  panels.dispatch("A", { type: "select-foreground", foreground: "primary" });
  panels.open("B", "terminal", {});
  const a = panels.getOwnerSnapshot("A");
  assert.equal(a.foreground, "primary");
  assert.equal(a.right.activeTabId, "terminal");
  assert.equal(a.right.open, true);
  assert.equal(disposals, 0);
  assert.deepEqual(
    [390, 1024, 390].map((w) => project(w, a.foreground).content.kind),
    ["primary", "split", "primary"],
  );
  assert.deepEqual(
    [390, 1024, 390].map((w) => project(w, panels.getOwnerSnapshot("B").foreground).content.kind),
    ["tools", "split", "tools"],
  );
  await fiber.dispose();
});
test("input modality changes presentation only; both foregrounds survive all sizes", () => {
  for (const width of [320, 390, 767, 768, 799, 800, 834, 1024, 1366])
    for (const foreground of ["primary", "tools"] as const)
      for (const open of [false, true])
        for (const full of [false, true]) {
          const a = project(width, foreground, open, full, true),
            b = project(width, foreground, open, full, false);
          assert.deepEqual(a.content, b.content);
          assert.equal(a.content.foreground, foreground);
        }
});
test("resource restoration, title updates and removal do not navigate away from primary", () => {
  let state = createConversationPanelState({ ownerId: "A" });
  const tab = {
    id: "t",
    kind: "terminal",
    region: "right" as const,
    title: "Terminal",
    closable: true,
    preview: false,
  };
  for (const action of [
    { type: "open-tab", tab, activate: false },
    { type: "update-tab", region: "right", tabId: "t", patch: { title: "Updated" } },
    { type: "close-tab", region: "right", tabId: "t" },
  ] as const) {
    state = reduceConversationPanelState(state, action);
    assert.equal(state.foreground, "primary");
  }
  state = reduceConversationPanelState(state, { type: "open-tab", tab });
  assert.equal(state.foreground, "tools");
  state = reduceConversationPanelState(state, { type: "select-foreground", foreground: "primary" });
  state = reduceConversationPanelState(state, { type: "activate-tab", region: "right", tabId: "t" });
  assert.equal(state.foreground, "tools");
});
test("empty tool outlet remains a valid destination after close", () => {
  const tab = {
    id: "t",
    kind: "terminal",
    region: "right" as const,
    title: "Terminal",
    closable: true,
    preview: false,
  };
  const state = reduceConversationPanelState(createConversationPanelState({ ownerId: "A" }), { type: "open-tab", tab });
  for (const action of [{ type: "close-tab", region: "right", tabId: "t" }] as const) {
    const empty = reduceConversationPanelState(state, action);
    assert.equal(empty.right.tabs.length, 0);
    assert.equal(empty.right.open, true);
    assert.equal(empty.foreground, "tools");
    assert.equal(project(390, empty.foreground, empty.right.open).content.kind, "tools");
  }
});
test("resize visibility writes never become navigation; explicit hide does", () => {
  let state = createConversationPanelState({ ownerId: "A" });
  state = reduceConversationPanelState(state, { type: "select-foreground", foreground: "tools" });
  state = reduceConversationPanelState(state, {
    type: "set-region-open",
    region: "right",
    open: false,
    reason: "resize",
  });
  assert.equal(state.foreground, "tools");
  state = reduceConversationPanelState(state, {
    type: "set-region-open",
    region: "right",
    open: false,
    reason: "manual",
  });
  assert.equal(state.foreground, "primary");
});

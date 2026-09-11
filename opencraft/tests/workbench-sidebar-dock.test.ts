import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveSidebarFloatingIntent,
  resolveSidebarPresentation,
  shouldMountFloatingSidebarPresenceOwner,
  SIDEBAR_EDGE_REVEAL_WIDTH,
} from "../apps/workbench-web/src/sidebar-dock-model";
import {
  getSidebarMaximumWidth,
  resolveSidebarWidth,
  SIDEBAR_MINIMUM_WIDTH,
} from "../apps/workbench-web/src/components/sidebar-resize-handle";
import {
  ChromeActionFocusRegistry,
  type ChromeActionFocusHost,
} from "../apps/workbench-web/src/chrome-actions/focus-registry";

const sidebarBotsSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/sidebar-bots.tsx",
    import.meta.url,
  ),
  "utf8",
);

const sidebarSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/sidebar.tsx",
    import.meta.url,
  ),
  "utf8",
);

const workbenchStyles = readFileSync(
  new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
  "utf8",
);

test("sidebar actions and account identity share one stable leading slot", () => {
  assert.equal(
    sidebarSource.match(/<SidebarActionIcon>/gu)?.length,
    4,
    "every primary and footer sidebar action reserves the shared leading slot",
  );
  assert.match(
    workbenchStyles,
    /\.sidebar-panel\s*\{[\s\S]*?--sidebar-leading-slot-size:\s*28px;/u,
  );
  assert.match(
    workbenchStyles,
    /\.sidebar-action__icon\s*\{[\s\S]*?width:\s*var\(--sidebar-leading-slot-size\);[\s\S]*?place-items:\s*center;/u,
  );
  assert.match(
    workbenchStyles,
    /\.sidebar-account__trigger\s*\{[\s\S]*?grid-template-columns:\s*var\(--sidebar-leading-slot-size\) minmax\(0, 1fr\) 18px;/u,
  );
});

test("sidebar entity creation presents through the application overlay layer", () => {
  assert.match(sidebarBotsSource, /import \{ createPortal \} from "react-dom";/u);
  assert.match(
    sidebarBotsSource,
    /return createPortal\([\s\S]*?sidebar-bot-dialog-backdrop[\s\S]*?,\s*document\.body,\s*\);/u,
  );
});

test("zero-Host and extension routes delegate physical chrome to the shared AppShell", () => {
  const hostlessWorkbench = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/hostless-workbench.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(hostlessWorkbench, /<AppShell\b/u);
  assert.match(hostlessWorkbench, /<AppShellHeader\b/u);
  assert.match(hostlessWorkbench, /<AppShellNavigationControls\b/u);
  assert.doesNotMatch(hostlessWorkbench, /<ApplicationShellRoot\b/u);
  assert.doesNotMatch(hostlessWorkbench, /<aside\b/u);
  assert.doesNotMatch(hostlessWorkbench, /HOSTLESS_SIDEBAR_WIDTH/u);
});

const floatingIntent = (
  overrides: Partial<Parameters<typeof resolveSidebarFloatingIntent>[0]> = {},
) => resolveSidebarFloatingIntent({
  docked: false,
  currentlyRequested: false,
  pointerX: null,
  panelWidth: 275,
  triggerPeeked: false,
  triggerSuppressed: false,
  ...overrides,
});

test("a hidden desktop sidebar is acquired only from Codex's four-pixel edge", () => {
  assert.equal(floatingIntent({ pointerX: SIDEBAR_EDGE_REVEAL_WIDTH }), true);
  assert.equal(floatingIntent({ pointerX: SIDEBAR_EDGE_REVEAL_WIDTH + 0.01 }), false);
});

test("an acquired floating sidebar retains pointer ownership across its full width", () => {
  assert.equal(floatingIntent({ currentlyRequested: true, pointerX: 274.9 }), true);
  assert.equal(floatingIntent({ currentlyRequested: true, pointerX: 275.1 }), false);
});

test("the delayed header trigger may reveal the panel away from the screen edge", () => {
  assert.equal(floatingIntent({ pointerX: 44, triggerPeeked: true }), true);
  assert.equal(floatingIntent({ pointerX: 44, triggerPeeked: true, triggerSuppressed: true }), false);
});

test("a docked sidebar always owns presentation over floating pointer intent", () => {
  assert.equal(floatingIntent({ docked: true, pointerX: 0, triggerPeeked: true }), false);
});

test("floating presence waits until the docked layout animation is fully gone", () => {
  assert.equal(resolveSidebarPresentation({
    docked: false,
    layoutMounted: true,
    layoutResizing: false,
    floatingRequested: true,
    floatingResizing: false,
  }), "layout-transition");
  assert.equal(resolveSidebarPresentation({
    docked: false,
    layoutMounted: false,
    layoutResizing: false,
    floatingRequested: true,
    floatingResizing: false,
  }), "floating");
});

test("floating resize owns presence until pointer capture is released", () => {
  assert.equal(resolveSidebarPresentation({
    docked: false,
    layoutMounted: false,
    layoutResizing: false,
    floatingRequested: false,
    floatingResizing: true,
  }), "floating");
});

test("docking retires the floating presence owner without an exit overlay", () => {
  assert.equal(shouldMountFloatingSidebarPresenceOwner({
    docked: false,
    layoutMounted: false,
    layoutResizing: false,
  }), true, "an undocked hidden host stays mounted to own pointer-leave exits");
  assert.equal(shouldMountFloatingSidebarPresenceOwner({
    docked: true,
    layoutMounted: false,
    layoutResizing: false,
  }), false, "dock commit removes the owner atomically");
  assert.equal(shouldMountFloatingSidebarPresenceOwner({
    docked: false,
    layoutMounted: true,
    layoutResizing: false,
  }), false, "layout transition owns the visual surface until it finishes");
});

test("layout resize preserves Codex's 120px collapse shelf", () => {
  const maximum = getSidebarMaximumWidth(1440);
  assert.deepEqual(resolveSidebarWidth(119.9, maximum), {
    collapsed: true,
    magnetized: true,
    width: SIDEBAR_MINIMUM_WIDTH,
  });
  assert.deepEqual(resolveSidebarWidth(120, maximum), {
    collapsed: false,
    magnetized: true,
    width: SIDEBAR_MINIMUM_WIDTH,
  });
});

test("focus follows a Chrome action when its floating host is removed", () => {
  const registry = new ChromeActionFocusRegistry();
  const focusCalls: string[] = [];
  let floatingOwnsFocus = true;
  const mainHost: ChromeActionFocusHost = {
    connected: true,
    ownsFocus: () => false,
    focus: () => focusCalls.push("main"),
  };
  const floatingHost: ChromeActionFocusHost = {
    connected: true,
    ownsFocus: () => floatingOwnsFocus,
    focus: () => focusCalls.push("floating"),
  };

  registry.register("sidebar-toggle", mainHost);
  const unregisterFloating = registry.register("sidebar-toggle", floatingHost);
  unregisterFloating();

  assert.deepEqual(focusCalls, ["main"]);
  floatingOwnsFocus = false;
  unregisterFloating();
  assert.deepEqual(focusCalls, ["main"], "unregister must be idempotent");
});

test("removing an unfocused Chrome action host never steals focus", () => {
  const registry = new ChromeActionFocusRegistry();
  const focusCalls: string[] = [];
  const host = (ownsFocus: boolean): ChromeActionFocusHost => ({
    connected: true,
    ownsFocus: () => ownsFocus,
    focus: () => focusCalls.push("focused"),
  });

  registry.register("sidebar-toggle", host(false));
  const unregisterFloating = registry.register("sidebar-toggle", host(false));
  unregisterFloating();

  assert.deepEqual(focusCalls, []);
});

test("a transient Chrome action transfers focus before its visual host exits", () => {
  const registry = new ChromeActionFocusRegistry();
  const focusCalls: string[] = [];
  let transientOwnsFocus = true;

  registry.register("sidebar-toggle", {
    connected: true,
    role: "persistent",
    ownsFocus: () => !transientOwnsFocus,
    focus: () => {
      transientOwnsFocus = false;
      focusCalls.push("persistent");
    },
  });
  registry.register("sidebar-toggle", {
    connected: true,
    role: "transient",
    ownsFocus: () => transientOwnsFocus,
    focus: () => focusCalls.push("transient"),
  });

  assert.equal(
    registry.transferFocus("sidebar-toggle", "transient", "persistent"),
    true,
  );
  assert.deepEqual(focusCalls, ["persistent"]);
  assert.equal(transientOwnsFocus, false);
});

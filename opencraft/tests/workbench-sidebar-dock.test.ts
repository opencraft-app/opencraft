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
  beginSidecarPrimaryResize,
  previewSidecarPrimaryResize,
  resolveSidecarPrimarySettleTarget,
} from "../apps/workbench-web/src/components/sidecar-primary-resize";
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

test("one Sidecar owns two platform panes with independent frame, clip, and viewport geometry", () => {
  const appShellSource = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/app-shell.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const sidecarSource = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/sidecar.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const sidecarStyles = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/sidecar.scss",
      import.meta.url,
    ),
    "utf8",
  );
  const navigationSource = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/shell-navigation/index.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const navigationStyles = readFileSync(
    new URL(
      "../apps/workbench-web/src/components/shell-navigation/shell-navigation.scss",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    appShellSource.match(/<SidecarPane\b/gu)?.length,
    2,
    "primary and context content use the same Sidecar pane primitive",
  );
  assert.equal(appShellSource.match(/<Sidecar\b/gu)?.length, 1);
  assert.match(appShellSource, /contentOpacity=\{navigationAnimation\}/u);
  assert.match(appShellSource, /contentOpacity=\{sidebarProgress\}/u);
  assert.doesNotMatch(appShellSource, /navigationContentOpacity/u);
  assert.match(appShellSource, /viewportSize=\{primaryMotion\.viewportWidth\}/u);
  assert.match(sidecarSource, /<motion\.section[\s\S]*?sidecar-pane__clip[\s\S]*?<motion\.div/u);
  assert.match(
    sidecarSource,
    /const viewportStyle:[\s\S]*?minWidth:\s*viewportSize[\s\S]*?opacity:\s*contentOpacity[\s\S]*?width:\s*viewportSize/u,
  );
  assert.match(
    sidecarStyles,
    /\.sidecar-pane__clip\s*\{[\s\S]*?width:\s*100%;[\s\S]*?overflow:\s*hidden;/u,
    "the clip, not the frame or business viewport, owns ink containment",
  );
  assert.match(
    sidecarStyles,
    /\.sidecar-pane__viewport\s*\{[\s\S]*?> \*\s*\{[\s\S]*?width:\s*100%;[\s\S]*?flex:\s*1 1 auto;/u,
    "feature content stretches through its pane instead of choosing intrinsic geometry",
  );
  assert.match(navigationSource, /data-shell-navigation-motion="geometry"/u);
  assert.match(navigationSource, /useTransform\(\s*\[progress, expandedWidth\]/u);
  assert.match(navigationStyles, /--shell-navigation-label-opacity/u);
  assert.doesNotMatch(navigationStyles, /data-shell-navigation-pane-mode[\s\S]*?display:\s*none/u);
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

test("device settings replace shared context/content slots without a private layout controller", () => {
  for (const path of ["../apps/workbench-web/src/app.tsx", "../apps/workbench-web/src/components/hostless-workbench.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /useSettingsPresentation|settingsPresentation/);
    assert.doesNotMatch(source, /allowDock: !routeSettingsOpen|sidebar(?:TransientEnabled|Resizable|Collapsible)=\{!routeSettingsOpen\}/);
    assert.match(source, /settingsActive: routeSettingsOpen/);
    assert.match(source, /presentation=\{managementSettingsOpen \? "dialog" : "sidebar"\}/);
    assert.match(source, /routeSettingsOpen \? settingsNavigation/);
  }
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

test("application pane keeps pointer frames continuous while selecting only an adjacent detent", () => {
  const maximum = getSidebarMaximumWidth(1440);
  const expanded = beginSidecarPrimaryResize({
    clientX: 260,
    detent: "expanded",
    expandedWidth: 260,
    compactWidth: 72,
  });
  assert.deepEqual(previewSidecarPrimaryResize({
    clientX: 20,
    compactWidth: 72,
    expandedMinimumWidth: 240,
    maximumWidth: maximum,
    transaction: expanded,
  }), {
    candidateDetent: "compact",
    frameWidth: 72,
    magnetized: true,
  }, "one expanded drag cannot skip the compact shelf");
  assert.deepEqual(previewSidecarPrimaryResize({
    clientX: 140,
    compactWidth: 72,
    expandedMinimumWidth: 240,
    maximumWidth: maximum,
    transaction: expanded,
  }), {
    candidateDetent: "compact",
    frameWidth: 140,
    magnetized: true,
  }, "the magnetic candidate does not quantize a held pointer frame");
  const compact = beginSidecarPrimaryResize({
    clientX: 72,
    detent: "compact",
    expandedWidth: 340,
    compactWidth: 72,
  });
  assert.deepEqual(previewSidecarPrimaryResize({
    clientX: 20,
    compactWidth: 72,
    expandedMinimumWidth: 240,
    maximumWidth: maximum,
    transaction: compact,
  }), {
    candidateDetent: "hidden",
    frameWidth: 20,
    magnetized: true,
  }, "a second drag may preview hidden without mutating the committed origin");
  assert.deepEqual(previewSidecarPrimaryResize({
    clientX: 100,
    compactWidth: 72,
    expandedMinimumWidth: 240,
    maximumWidth: maximum,
    transaction: compact,
  }), {
    candidateDetent: "compact",
    frameWidth: 100,
    magnetized: true,
  }, "compact-origin motion also follows the pointer before release");
});

test("application pane release targets are resolved independently from pointer preview", () => {
  const common = {
    compactWidth: 72,
    expandedMinimumWidth: 240,
    maximumWidth: 520,
  };
  assert.equal(resolveSidecarPrimarySettleTarget({ ...common, detent: "hidden", expandedWidth: null }), 0);
  assert.equal(resolveSidecarPrimarySettleTarget({ ...common, detent: "compact", expandedWidth: null }), 72);
  assert.equal(resolveSidecarPrimarySettleTarget({ ...common, detent: "expanded", expandedWidth: 172 }), 240);
  assert.equal(resolveSidecarPrimarySettleTarget({ ...common, detent: "expanded", expandedWidth: 340 }), 340);
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

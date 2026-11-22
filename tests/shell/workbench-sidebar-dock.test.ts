import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import scss from "postcss-scss";

import {
  canHoverRevealSidebar,
  resolveSidebarFloatingIntent,
  resolveSidebarPresentation,
  shouldMountFloatingSidebarPresenceOwner,
  SIDEBAR_EDGE_REVEAL_WIDTH,
} from "../../apps/workbench-web/src/sidebar-dock-model";
import {
  getSidebarMaximumWidth,
  resolveSidebarWidth,
  SIDEBAR_MINIMUM_WIDTH,
} from "../../apps/workbench-web/src/components/sidebar-resize-handle";
import {
  ChromeActionFocusRegistry,
  type ChromeActionFocusHost,
} from "../../apps/workbench-web/src/chrome-actions/focus-registry";

const sidebarBotsSource = readFileSync(
  new URL(
    "../../apps/workbench-web/src/components/sidebar-bots.tsx",
    import.meta.url,
  ),
  "utf8",
);

const sidebarSource = readFileSync(
  new URL(
    "../../apps/workbench-web/src/components/sidebar.tsx",
    import.meta.url,
  ),
  "utf8",
);

const workbenchStyles = readFileSync(
  new URL("../../apps/workbench-web/src/styles/app.scss", import.meta.url),
  "utf8",
);

const designTokens = readFileSync(
  new URL("../../packages/design-system/src/tokens.web.scss", import.meta.url),
  "utf8",
);

test("one Sidecar owns the shared pane frame, clip, and viewport geometry", () => {
  const appShellSource = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/app-shell.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const sidecarSource = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/sidecar.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const sidecarStyles = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/sidecar.scss",
      import.meta.url,
    ),
    "utf8",
  );
  const navigationSource = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/shell-navigation/index.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const navigationStyles = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/shell-navigation/shell-navigation.scss",
      import.meta.url,
    ),
    "utf8",
  );
  const navigationContentSource = readFileSync(
    new URL(
      "../../apps/workbench-web/src/components/shell-navigation/navigation-content.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    appShellSource.match(/<SidecarPane\b/gu)?.length,
    1,
    "the application and context slots share one Sidecar pane",
  );
  assert.equal(appShellSource.match(/<Sidecar\b/gu)?.length, 1);
  assert.match(appShellSource, /contentOpacity=\{sidebarProgress\}/u);
  assert.match(appShellSource, /viewportSize=\{contextViewportWidth\}/u);
  assert.match(sidecarSource, /<motion\.section[\s\S]*?sidecar-pane__clip[\s\S]*?<motion\.div/u);
  assert.match(
    sidecarSource,
    /const viewportStyle:[\s\S]*?minWidth:\s*0[\s\S]*?opacity:\s*contentOpacity[\s\S]*?width:\s*viewportSize/u,
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
  assert.match(navigationSource, /isAnonymousShellAccount\(account\)/u);
  assert.match(navigationSource, /onClick: account\.onOpen/u);
  assert.doesNotMatch(navigationSource, /Keep in sidebar|Unpin from sidebar/u);
  assert.match(navigationContentSource, /id: "account\.signIn", defaultMessage: "Sign in"/u);
  assert.doesNotMatch(navigationSource, /localStorage\.(?:getItem|setItem)/u,
    "Shell Navigation delegates durable state to UiPreferencesRuntime");
  const appSource = readFileSync(new URL("../../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  const hostlessSource = readFileSync(
    new URL("../../apps/workbench-web/src/components/hostless-workbench.tsx", import.meta.url),
    "utf8",
  );
  for (const source of [appSource, hostlessSource]) {
    assert.match(source, /usePersistedSidebarWidth\((?:presentation\.shellNavigation)?\)/u);
    assert.doesNotMatch(source, /localStorage\.getItem\("sidebar-width"\)|localStorage\.setItem\("sidebar-width"/u);
  }
  assert.match(navigationStyles, /--sidebar-leading-slot-size:\s*28px/u);
  assert.doesNotMatch(navigationStyles, /&:last-child/u,
    "portal children cannot change Footer trigger geometry through structural selectors");
});

test("context sidebar actions share one stable leading slot after account moves to the Sidecar footer", () => {
  // Contribution counts are runtime data. Counting JSX source sites rejects a
  // shared renderer without proving any item loses its leading slot. Keep the
  // token/style ownership checks here; actual Sidebar browser checks cover
  // Start, primary contributions, footer contributions and Settings together.
  assert.match(
    designTokens,
    /--size-navigation-leading-slot:\s*28px;/u,
  );
  const navigationStyles=readFileSync(new URL("../../packages/design-system-web/src/navigation.web.scss",import.meta.url),"utf8");
  const navigationItem=readFileSync(new URL("../../apps/workbench-web/src/components/sidebar-navigation-item.tsx",import.meta.url),"utf8");
  assert.match(navigationItem,/<NavigationItem/u);
  assert.match(navigationItem,/className="sidebar-navigation-item__icon" data-navigation-leading=""/u);
  assert.match(navigationStyles,/\.ui-button\.ui-navigation-item > \[data-navigation-leading\]\s*\{[^}]*width: var\(--size-navigation-leading-slot\);[^}]*height: var\(--size-navigation-leading-slot\);[^}]*flex-basis: var\(--size-navigation-leading-slot\);/u);
  assert.match(navigationStyles,/grid-template-columns: var\(--size-sidebar-navigation-leading-slot\) minmax\(0, 1fr\) auto;/u);
  assert.doesNotMatch(sidebarSource, /sidebar-account__trigger/u);
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
      "../../apps/workbench-web/src/components/hostless-workbench.tsx",
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
    const source = readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");
    assert.doesNotMatch(source, /useSettingsPresentation|settingsPresentation/);
    assert.doesNotMatch(source, /allowDock: !routeSettingsOpen|sidebar(?:TransientEnabled|Resizable|Collapsible)=\{!routeSettingsOpen\}/);
    assert.match(source, /settingsActive: sidebarDestination === "settings" \|\| \(routeSettingsOpen && !applicationsSelected\)/);
    assert.match(source, /<SettingsSidebarNavigation\b/u);
    assert.match(source, /routeSettingsOpen \? settingsNavigation/);
  }
  const navigation = readFileSync(new URL("../../apps/workbench-web/src/components/settings-sidebar-navigation.tsx", import.meta.url), "utf8");
  assert.match(navigation, /presentation=\{!choosingSection && managementOpen \? "dialog" : "sidebar"\}/u);
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

test("touch and pen movement cannot acquire a hover-only sidebar", () => {
  assert.equal(canHoverRevealSidebar("mouse"), true);
  assert.equal(canHoverRevealSidebar("touch"), false);
  assert.equal(canHoverRevealSidebar("pen"), false);
  assert.equal(canHoverRevealSidebar(""), false);
});

test("floating dismissal has one Shell hit surface above the conversation", () => {
  const shell = readFileSync(new URL("../../apps/workbench-web/src/components/app-shell.tsx", import.meta.url), "utf8");
  const styles = scss.parse(workbenchStyles);
  const baseRule = (selector: string) => styles.nodes.find(node => node.type === "rule" && node.selector === selector)?.toString();
  const dismiss = baseRule(".app-shell-floating-sidebar-dismiss");
  const panel = baseRule(".app-shell-floating-left-panel");
  const overlay = baseRule(".app-shell-floating-overlay-root");
  const browser = baseRule(".web-browser-presentation-root");
  assert.match(shell, /createPortal\(\s*<div[^>]*className="app-shell-floating-overlay-root"[\s\S]*?floatingOwnsContent && !mobileSidebarEnabled \? \(\s*<(?:motion\.)?button[\s\S]*?className="app-shell-floating-sidebar-dismiss"[\s\S]*?onClick=\{dismissFloatingSidebar\}/u);
  assert.match(shell, /<\/div>, document\.body/u);
  assert.doesNotMatch(shell, /window\.addEventListener\("pointerdown"/u);
  assert.ok(dismiss && panel && overlay && browser);
  assert.match(dismiss, /background:\s*transparent/u);
  assert.match(dismiss, /-webkit-tap-highlight-color:\s*transparent/u);
  assert.match(shell, /floatingOwnsContent \? floatingContextHost : dockedContextHost/u);
  assert.match(shell, /onExitComplete=\{finishFloatingExit\}/u);
  const floatingPanel = readFileSync(new URL("../../apps/workbench-web/src/components/floating-left-panel.tsx", import.meta.url), "utf8");
  assert.match(floatingPanel, /useIsPresent\(\)/u);
  assert.match(floatingPanel, /inert=\{!isPresent \|\| undefined\}/u);
  assert.match(floatingPanel, /pointerEvents: isPresent \? "auto" : "none"/u);
  assert.match(browser, /z-index:\s*var\(--layer-workspace-browser\)/u);
  const browserLayer = Number(designTokens.match(/--layer-workspace-browser:\s*(\d+)/u)?.[1]);
  assert.ok(Number(overlay.match(/z-index:\s*(\d+)/u)?.[1]) > browserLayer,
    "the floating Shell overlay remains above the workspace browser layer");
  assert.ok(Number(dismiss.match(/z-index:\s*(\d+)/u)?.[1]) < Number(panel.match(/z-index:\s*(\d+)/u)?.[1]));
});

test("a hidden desktop sidebar is acquired only from the four-pixel edge", () => {
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

test("layout resize preserves the 120px collapse shelf", () => {
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SessionListItemWire } from "../../vela-chat-client/src";

register(new URL("../../vela-chat-web/tests/css-module-loader.mjs", import.meta.url));

const {
  SessionSidebar,
  VelaDesktopShell,
  browserRuntimeHostBridge,
} = await import("../src");

const root = process.cwd();

const session: SessionListItemWire = {
  id: "ses_visual_contract",
  title: "Visual contract",
  backend: "codex",
  status: "idle",
  working_directory: "/Users/skipzhang/code/velaChat",
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:00.000Z",
  last_activity_at: "2026-06-23T00:00:00.000Z",
  preview: "A recent desktop session",
  pending_request_count: 0,
  running: false,
  model: "gpt-5.5",
  agent_config: {
    model: "gpt-5.5",
    permission_mode: "auto",
    feature_values: {},
  },
};

test("desktop shell renders the codex-desktop style sidebar frame and main inset", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      VelaDesktopShell,
      {
        host: browserRuntimeHostBridge,
        isSidebarVisible: true,
        sidebar: React.createElement(SessionSidebar, {
          sessions: [session],
          currentSessionId: session.id,
          onCreateSession: () => {},
          onSelectSession: () => {},
        }),
        onCreateSession: () => {},
        onToggleSidebar: () => {},
      },
      React.createElement("section", null, "Chat"),
    ),
  );

  assert.match(html, /class="vela-window-chrome"/);
  assert.match(html, /class="vela-sidebar-window-controls"/);
  assert.match(html, /class="vela-window-drag-layer"/);
  assert.match(html, /class="vela-desktop-shell app-shell vela-tri-pane-shell"/);
  assert.match(html, /--vela-window-leading-content-inset:158px/);
  assert.match(html, /data-slot="sidebar-wrapper"/);
  assert.match(html, /class="vela-sidebar-wrapper"/);
  assert.match(html, /class="vela-sidebar-panel"/);
  assert.match(html, /class="vela-sidebar-inset vela-main-inset"/);
  assert.ok(
    html.indexOf("vela-window-chrome") < html.indexOf("vela-sidebar-window-controls"),
    "window controls should live inside the shell chrome safe area",
  );
});

test("session sidebar renders the codex-desktop topbar before session content", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionSidebar, {
      sessions: [session],
      currentSessionId: session.id,
      showTrafficLights: true,
      onCreateSession: () => {},
      onSelectSession: () => {},
    }),
  );

  assert.match(html, /class="vela-sidebar-topbar"/);
  assert.match(html, /class="vela-sidebar-toolbar-spacer"/);
  assert.doesNotMatch(html, /class="vela-sidebar-traffic-zone"/);
  assert.doesNotMatch(html, /class="vela-traffic-lights"/);
  assert.match(html, /class="vela-sidebar-nav"/);
  assert.doesNotMatch(html, /aria-label="Back"/);
  assert.doesNotMatch(html, /aria-label="Forward"/);
  assert.match(html, /class="vela-sidebar-drag-fill"/);
  assert.ok(
    html.indexOf("vela-sidebar-topbar") < html.indexOf("new-session-row"),
    "topbar should reserve the left top chrome area before session content",
  );
});

test("session sidebar renders the codex-desktop settings menu in the footer", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionSidebar, {
      sessions: [session],
      currentSessionId: session.id,
      canClearSessions: true,
      defaultSettingsMenuOpen: true,
      onCreateSession: () => {},
      onOpenSettings: () => {},
      onClearSessions: () => {},
      onSelectSession: () => {},
    }),
  );

  assert.match(html, /class="vela-sidebar-fixed-footer"/);
  assert.match(html, /class="vela-settings-menu-root"/);
  assert.match(html, /class="[^"]*vela-settings-menu-trigger/);
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /data-native-tooltip="Settings"/);
  assert.match(html, /role="menu"/);
  assert.match(html, />Settings</);
  assert.match(html, />Clear chats</);
  assert.doesNotMatch(html, />Remaining usage</);
  assert.doesNotMatch(html, />Invite friends</);
  assert.doesNotMatch(html, />Log out</);
  assert.ok(
    html.indexOf("session-list-surface") < html.indexOf("vela-settings-menu-root"),
    "settings menu should live in the sidebar footer after the session list",
  );
});

test("running session rows stay in the compact text layout", () => {
  const runningSession: SessionListItemWire = {
    ...session,
    id: "ses_running_visual_contract",
    title: "Investigate streaming markdown",
    preview: "Renderer keeps a small release buffer for smooth output",
    status: "running",
    running: true,
    pending_request_count: 0,
  };
  const html = renderToStaticMarkup(
    React.createElement(SessionSidebar, {
      sessions: [runningSession],
      currentSessionId: runningSession.id,
      onCreateSession: () => {},
      onSelectSession: () => {},
    }),
  );

  assert.doesNotMatch(html, /data-slot="session-thumbnail-preview"/);
  assert.doesNotMatch(html, /data-conversation-preview="true"/);
  assert.match(html, /class="vela-session-preview"/);
  assert.match(html, /Renderer keeps a small release buffer/);
  assert.match(html, /class="vela-session-location"/);
  assert.match(html, />velaChat</);
  assert.match(html, /class="vela-session-rail"/);
  assert.doesNotMatch(html, /class="vela-session-status-dot"/);
  assert.doesNotMatch(html, /class="vela-session-icon"/);
  assert.doesNotMatch(html, /class="vela-session-badge"/);
  assert.match(html, /data-activity="running"/);
  assert.match(html, /data-running="true"/);
  assert.doesNotMatch(html, /data-has-thumbnail/);
  assert.doesNotMatch(html, /运行中/);
  assert.doesNotMatch(html, /class="[^"]*card/);
});

test("desktop host CSS makes the shell fill the browser viewport", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(css, /\.vela-sidebar-provider\s*\{/);
  assert.match(css, /\.vela-sidebar-provider\s*\{[^}]*height:\s*100dvh/s);
  assert.match(css, /\.vela-sidebar-provider\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.vela-desktop-shell\s*\{[^}]*height:\s*100%/s);
});

test("desktop host uses unified chrome and drag-region semantics", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const desktopBridge = readFileSync(
    join(root, "apps/vela-desktop-electron/src/desktopBridge.ts"),
    "utf8",
  );
  const settingsPage = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopSettingsPage.tsx"),
    "utf8",
  );
  const sidebarShell = readFileSync(
    join(root, "packages/vela-desktop-shell/src/components/sidebar/VelaSidebarShell.tsx"),
    "utf8",
  );

  assert.match(main, /trafficLightPosition:\s*\{\s*x:\s*18,\s*y:\s*18\s*\}/);
  assert.match(sidebarShell, /interface WindowToolbarButtonModel/);
  assert.match(sidebarShell, /function ToolbarSidebarIcon/);
  assert.match(sidebarShell, /function ToolbarNewThreadIcon/);
  assert.match(sidebarShell, /function windowToolbarButtonModels/);
  assert.match(sidebarShell, /function windowLeadingContentInsetPx/);
  assert.match(sidebarShell, /data-toolbar-button=\{button\.id\}/);
  assert.match(desktopBridge, /showTrafficLights:\s*false/);
  assert.match(settingsPage, /VelaSidebarChrome/);
  assert.match(settingsPage, /SidebarContent/);
  assert.doesNotMatch(settingsPage, /vela-settings-sidebar-topbar/);
  assert.doesNotMatch(css, /\.vela-settings-sidebar-topbar/);
  assert.match(css, /\.vela-settings-sidebar-content\s*\{[^}]*padding:\s*0 0 18px;/s);
  assert.match(css, /\.vela-settings-fixed-controls\s*\{[^}]*padding:\s*0 10px;/s);
  assert.match(css, /\.vela-settings-nav-scroll\s*\{[^}]*padding:\s*4px 10px 8px;/s);
  assert.match(main, /macosChromeMetrics/);
  assert.match(css, /--vela-window-traffic-light-left:\s*18px;/);
  assert.match(css, /--vela-window-traffic-light-top:\s*18px;/);
  assert.match(css, /--vela-window-toolbar-center-y:/);
  assert.match(css, /--vela-window-toolbar-top:/);
  assert.match(css, /--vela-window-toolbar-start-x:/);
  assert.match(css, /--vela-window-toolbar-size:\s*20px;/);
  assert.match(css, /--vela-window-toolbar-icon-size:\s*20px;/);
  assert.match(css, /--vela-window-toolbar-icon-scale:\s*1\.12;/);
  assert.match(css, /--vela-window-toolbar-gap:\s*16px;/);
  assert.match(css, /--vela-window-toolbar-item-gap:\s*0px;/);
  assert.match(css, /\.vela-chat-topbar\s*\{[^}]*--vela-chat-topbar-leading-padding:\s*var\(--vela-chat-topbar-base-padding-left\);/s);
  assert.match(css, /\.vela-chat-topbar\s*\{[^}]*min-height:\s*46px;/s);
  assert.match(css, /\.vela-chat-topbar\s*\{[^}]*padding:\s*6px var\(--vela-chat-topbar-base-padding-right\) 6px var\(--vela-chat-topbar-leading-padding\);/s);
  assert.match(css, /\.vela-chat-topbar\s*\{[^}]*box-shadow:\s*none;/s);
  assert.match(css, /\.vela-chat-topbar::after\s*\{[^}]*bottom:\s*0;/s);
  assert.doesNotMatch(css, /\.vela-chat-topbar::after\s*\{[^}]*top:\s*68px;/s);
  assert.match(css, /\.vela-desktop-shell\[data-state="collapsed"\] \.vela-chat-topbar,\s*\.vela-desktop-shell\[data-sidebar-presentation="overlay"\] \.vela-chat-topbar\s*\{[^}]*--vela-chat-topbar-leading-padding:\s*max\(/s);
  assert.match(css, /\.vela-desktop-shell\[data-state="collapsed"\] \.vela-chat-topbar,\s*\.vela-desktop-shell\[data-sidebar-presentation="overlay"\] \.vela-chat-topbar\s*\{[^}]*var\(--vela-window-leading-content-inset\)/s);
  assert.match(css, /\.vela-desktop-shell:not\(\[data-sidebar-dragging="true"\]\) \.vela-chat-topbar\s*\{[^}]*transition:\s*padding-left var\(--vela-sidebar-toggle-duration\) var\(--vela-sidebar-toggle-ease\);/s);
  assert.match(css, /\.vela-desktop-shell\[data-sidebar-dragging="true"\] \.vela-chat-topbar\s*\{[^}]*transition:\s*none;/s);
  assert.match(css, /\[data-window-drag-region="true"\]\s*\{[^}]*-webkit-app-region:\s*drag;/s);
  assert.match(css, /\[data-window-drag-region="false"\]/);
  assert.match(css, /\.vela-window-chrome\s*\{[^}]*height:\s*var\(--vela-titlebar-height\);/s);
  assert.match(css, /\.vela-window-drag-layer\s*\{[^}]*height:\s*var\(--vela-titlebar-height\);/s);
  assert.match(css, /\.vela-window-traffic-lights\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-window-traffic-lights\s*\{[^}]*left:\s*var\(--vela-window-traffic-light-left\);/s);
  assert.match(css, /\.vela-window-traffic-lights\s*\{[^}]*top:\s*var\(--vela-window-traffic-light-top\);/s);
  assert.match(css, /\.vela-sidebar-window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(css, /\.vela-sidebar-window-controls\s*\{[^}]*top:\s*var\(--vela-window-toolbar-top\);/s);
  assert.match(css, /\.vela-sidebar-window-controls\s*\{[^}]*left:\s*var\(--vela-window-controls-left\);/s);
  assert.match(css, /\.vela-sidebar-window-control-button\s*\{[^}]*width:\s*var\(--vela-window-toolbar-size\);/s);
  assert.match(css, /\.vela-sidebar-chrome-button\s*\{[^}]*width:\s*var\(--vela-window-toolbar-size\);/s);
  assert.match(css, /\.vela-sidebar-topbar\s*\{[^}]*padding:\s*0;/s);
  assert.match(css, /\.vela-sidebar-toolbar-spacer\s*\{[^}]*width:\s*var\(--vela-window-toolbar-start-x\);/s);
  assert.doesNotMatch(css, /\.vela-sidebar-traffic-zone/);
});

test("desktop session list CSS follows the codex-style compact rail layout", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(css, /\.vela-session-sidebar\s*\{[^}]*user-select:\s*none;/s);
  assert.match(css, /\.search-box\s*\{[^}]*min-height:\s*34px;/s);
  assert.match(css, /\.sidebar-section-heading\s*\{[^}]*text-transform:\s*none;/s);
  assert.match(css, /\.vela-session-item\s*\{[^}]*position:\s*relative;/s);
  assert.doesNotMatch(css, /--vela-session-rail-width/);
  assert.match(css, /\.vela-session-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(css, /\.vela-session-main\s*\{[^}]*padding:\s*6px 58px 6px 8px;/s);
  assert.match(css, /\.vela-session-main\s*\{[^}]*min-height:\s*50px;/s);
  assert.doesNotMatch(css, /\.vela-session-thumbnail-preview/);
  assert.doesNotMatch(css, /data-has-thumbnail/);
  assert.match(css, /\.vela-session-preview\s*\{[^}]*font-size:\s*12px;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*right:\s*22px;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*max-width:\s*38px;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*font-size:\s*10px;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*font-weight:\s*420;/s);
  assert.match(css, /\.vela-session-rail\s*\{[^}]*text-align:\s*right;/s);
  assert.match(css, /\.vela-session-archive-action\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-session-item\[data-has-actions="true"\]:hover \.vela-session-archive-action/s);
  assert.match(css, /\.vela-session-item\[data-has-actions="true"\]:hover \.vela-session-rail/s);
  assert.doesNotMatch(css, /\.vela-session-actions-trigger/);
  assert.doesNotMatch(css, /\.vela-session-status-dot/);
  assert.doesNotMatch(css, /\.vela-session-icon/);
  assert.doesNotMatch(css, /\.vela-session-badge/);
  assert.doesNotMatch(css, /\.vela-session-item\s*\{[^}]*box-shadow:\s*0 18px/s);
});

test("desktop sidebar settings menu CSS follows the current Codex dropdown density and motion", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(css, /\.vela-sidebar-footer\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-settings-menu-root\s*\{[^}]*height:\s*38px;/s);
  assert.match(css, /\.vela-settings-menu-trigger\s*\{[^}]*border-radius:\s*12px;/s);
  assert.match(css, /\.vela-settings-menu-trigger\s*\{[^}]*font-weight:\s*700;/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*left:\s*0;/s);
  assert.doesNotMatch(css, /\.vela-settings-popover\s*\{[^}]*right:\s*0;/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*--vela-settings-popover-inset:\s*2px;/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*--vela-settings-popover-start-transform:\s*translateY\(var\(--vela-settings-popover-inset\)\) scale\(0\.98\);/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*width:\s*min\(224px, calc\(100vw - 24px\)\);/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*padding:\s*4px;/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*border-radius:\s*14px;/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*corner-shape:\s*superellipse\(1\.5\);/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*background:\s*color-mix\(in oklab, #ffffff 94%, transparent\);/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*box-shadow:\s*0 12px 32px rgba\(15, 23, 42, 0\.10\),\s*0 2px 4px rgba\(15, 23, 42, 0\.06\);/s);
  assert.match(css, /\.vela-settings-popover\s*\{[^}]*backdrop-filter:\s*blur\(12px\) saturate\(1\.12\);/s);
  assert.match(css, /\.vela-motion-popover\[data-state="open"\]\s*\{[^}]*animation:\s*vela-popover-in 120ms var\(--vela-codex-menu-enter-ease\);/s);
  assert.match(css, /@keyframes vela-popover-in\s*\{[^}]*transform:\s*var\(--vela-settings-popover-start-transform\);/s);
  assert.match(css, /\.vela-settings-menu-item\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\) auto;/s);
  assert.match(css, /\.vela-settings-menu-item\s*\{[^}]*min-height:\s*28px;/s);
  assert.match(css, /\.vela-settings-menu-item\s*\{[^}]*font-size:\s*12px;/s);
  assert.match(css, /\.vela-settings-menu-separator\s*\{[^}]*height:\s*1px;/s);
}
);

test("desktop main frame stays a neutral host surface while ChatUI owns material", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(css, /--vela-main-surface:\s*rgb\(255 255 255 \/ 92%\);/);
  assert.match(css, /--vela-main-surface-radius:\s*20px;/);
  assert.match(css, /--vela-main-edge-hairline:\s*rgba\(60,\s*60,\s*67,\s*0\.13\);/);
  assert.match(css, /\.vela-main-inset\s*\{[^}]*box-sizing:\s*border-box;/s);
  assert.match(css, /\.vela-main-inset\s*\{[^}]*border-top-left-radius:\s*var\(--vela-main-surface-radius\);/s);
  assert.match(css, /\.vela-main-inset\s*\{[^}]*border-left:\s*0;/s);
  assert.match(css, /\.vela-desktop-shell\[data-state="collapsed"\] \.vela-main-inset\s*\{[^}]*border-left-color:\s*transparent;/s);
  assert.doesNotMatch(css, /\.vela-desktop-shell\[data-sidebar-presentation="overlay"\] \.vela-main-inset\s*\{[^}]*border-top-left-radius:\s*0;/s);
  assert.match(css, /\.vela-sidebar-inset::before\s*\{[^}]*linear-gradient\(180deg,\s*rgb\(255 255 255 \/ 98%\) 0%,\s*var\(--vela-main-surface\) 54%\)/s);
  assert.match(css, /\.vela-sidebar-inset::before\s*\{[^}]*inset 2px 0 0 var\(--vela-main-edge-hairline\)/s);
  assert.match(css, /\.vela-sidebar-inset::before\s*\{[^}]*backdrop-filter:\s*blur\(18px\) saturate\(1\.08\);/s);
  assert.doesNotMatch(css, /\.vela-main-inset\s*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /\.vela-main-inset\s*\{[^}]*-webkit-backdrop-filter:/s);
  assert.doesNotMatch(css, /\.vela-main-inset\s*\{[^}]*backdrop-filter:/s);
});

test("collapsed desktop sidebar keeps content mounted for exit motion without a resize handle", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      VelaDesktopShell,
      {
        host: browserRuntimeHostBridge,
        isSidebarVisible: false,
        sidebar: React.createElement("aside", null, "Sidebar content stays mounted"),
        onSidebarWidthChange: () => {},
        onToggleSidebar: () => {},
      },
      React.createElement("section", null, "Chat"),
    ),
  );

  assert.match(html, /data-state="collapsed"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Sidebar content stays mounted/);
  assert.doesNotMatch(html, /data-slot="sidebar-resize-handle"/);
});

test("desktop sidebar toggle motion is main-surface owned and disabled during drag or reduced motion", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(css, /--vela-sidebar-toggle-duration:\s*270ms;/);
  assert.match(css, /--vela-sidebar-toggle-ease:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\);/);
  assert.match(css, /\.vela-sidebar-wrapper\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-sidebar-wrapper\s*\{[^}]*width:\s*var\(--vela-sidebar-width, 300px\);/s);
  assert.doesNotMatch(css, /\.vela-sidebar-wrapper\[data-state="collapsed"\]\s*\{[^}]*width:\s*0;/s);
  assert.match(css, /\.vela-main-inset\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.vela-main-inset\s*\{[^}]*left:\s*var\(--vela-sidebar-width, 300px\);/s);
  assert.match(css, /\.vela-desktop-shell\[data-state="collapsed"\] \.vela-main-inset\s*\{[^}]*left:\s*0;/s);
  assert.match(css, /\.vela-desktop-shell:not\(\[data-sidebar-dragging="true"\]\) \.vela-main-inset\s*\{[^}]*transition:/s);
  assert.match(css, /\.vela-desktop-shell:not\(\[data-sidebar-dragging="true"\]\) \.vela-chat-topbar\s*\{[^}]*transition:\s*padding-left var\(--vela-sidebar-toggle-duration\) var\(--vela-sidebar-toggle-ease\);/s);
  assert.match(css, /\.vela-desktop-shell\[data-sidebar-dragging="true"\] \.vela-main-inset\s*\{[^}]*transition:\s*none;/s);
  assert.match(css, /\.vela-desktop-shell\[data-sidebar-dragging="true"\] \.vela-chat-topbar\s*\{[^}]*transition:\s*none;/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.vela-desktop-shell:not\(\[data-sidebar-dragging="true"\]\) \.vela-main-inset,\s*\.vela-desktop-shell:not\(\[data-sidebar-dragging="true"\]\) \.vela-chat-topbar\s*\{[^}]*transition-duration:\s*0\.01ms;/s);
});

test("desktop main surface renders a codex-style blur veil while covering the sidebar", () => {
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.doesNotMatch(css, /--vela-main-edge-veil-width:/);
  assert.doesNotMatch(css, /\.vela-main-inset\s*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /\.vela-desktop-shell\[data-state="collapsed"\] \.vela-main-inset\s*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(css, /box-shadow var\(--vela-sidebar-toggle-duration\)/);
  assert.doesNotMatch(css, /\.vela-sidebar-inset::after\s*\{/);
});

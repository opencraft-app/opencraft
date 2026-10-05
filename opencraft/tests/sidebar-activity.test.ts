import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stableIdentityColor } from "@opencraft/design-system/identity-color";
import { threadServerOrigin } from "@opencraft/workbench-runtime";

import {
  groupThreadsByActivityDate,
  sidebarActivityMetadata,
  type SidebarActivityThread,
} from "../apps/workbench-web/src/sidebar-activity";
import {
  isSidebarThreadMenuOpen,
  updateOpenSidebarThreadMenu,
} from "../apps/workbench-web/src/components/sidebar-thread-menu-state";

const seconds = (value: Date) => value.getTime() / 1_000;

function thread(
  id: string,
  updatedAt: Date,
  overrides: Partial<SidebarActivityThread> = {},
): SidebarActivityThread {
  return {
    id,
    serverOrigin: threadServerOrigin({ serverId: "local-server", label: "Local" }),
    project: "mono2",
    updatedAt: seconds(updatedAt),
    ...overrides,
  };
}

test("Activity chronology owns sections while equal thread ids retain Server provenance", () => {
  const now = new Date(2026, 8, 21, 12);
  const input = [
    thread("same", new Date(2026, 8, 20, 18), {
      serverOrigin: threadServerOrigin({ serverId: "remote-server", label: "Hermes" }),
    }),
    thread("same", new Date(2026, 8, 21, 9)),
    thread("older", new Date(2026, 8, 19, 16)),
  ];
  const groups = groupThreadsByActivityDate(input, now.getTime(), "en-US");

  assert.deepEqual(groups.map(group => group.label), ["Today", "Yesterday", "Saturday"]);
  assert.deepEqual(groups.flatMap(group => group.threads.map(item => `${item.serverOrigin.serverId}:${item.id}`)), [
    "local-server:same",
    "remote-server:same",
    "local-server:older",
  ]);
});

test("Activity metadata owns project copy while serverOrigin retains Server provenance", () => {
  const local = thread("local", new Date(2026, 8, 21, 9));
  assert.deepEqual(sidebarActivityMetadata(local), { project: "mono2" });
  assert.deepEqual(sidebarActivityMetadata({
    ...local,
    serverOrigin: threadServerOrigin({
      serverId: "server:9.134.163.40",
      label: "9.134.163.40",
    }),
    project: "V8",
  }), { project: "V8" });
});

test("Server origin identity is independent from mutable label, Hub route and activity state", () => {
  const first = threadServerOrigin({ serverId: "lightvela-hermes", label: "Hermes Cloud" });
  const renamed = threadServerOrigin({ serverId: "lightvela-hermes", label: "Hermes" });
  assert.equal(stableIdentityColor(first.serverId), stableIdentityColor(renamed.serverId));
  assert.notEqual(stableIdentityColor(first.serverId), stableIdentityColor("server:ssh:9.134.163.40"));
  assert.throws(() => threadServerOrigin({ serverId: " ", label: "Local" }), /Server ID/u);
});

test("Sidebar owns one menu across rows and input paths; a stale close cannot dismiss its successor", () => {
  const first = { hostId: "host-a", threadId: "thread-a", kind: "dropdown" } as const;
  const second = { hostId: "host-a", threadId: "thread-b", kind: "dropdown" } as const;
  const context = { hostId: "host-a", threadId: "thread-b", kind: "context" } as const;
  let current = updateOpenSidebarThreadMenu(null, first, true);
  assert.equal(isSidebarThreadMenuOpen(current, first), true);
  current = updateOpenSidebarThreadMenu(current, second, true);
  assert.equal(isSidebarThreadMenuOpen(current, first), false);
  assert.equal(isSidebarThreadMenuOpen(current, second), true);
  current = updateOpenSidebarThreadMenu(current, first, false);
  assert.equal(isSidebarThreadMenuOpen(current, second), true);
  current = updateOpenSidebarThreadMenu(current, context, true);
  assert.equal(isSidebarThreadMenuOpen(current, second), false);
  assert.equal(isSidebarThreadMenuOpen(current, context), true);
  assert.equal(isSidebarThreadMenuOpen(current, { ...context, hostId: "host-b" }), false);
  assert.equal(updateOpenSidebarThreadMenu(current, context, false), null);
});

test("Sidebar consumes the shared two-line Activity item instead of Host group rows", () => {
  const sidebar = readFileSync(
    new URL("../apps/workbench-web/src/components/sidebar.tsx", import.meta.url),
    "utf8",
  );
  const item = readFileSync(
    new URL("../apps/workbench-web/src/components/sidebar-activity-item.tsx", import.meta.url),
    "utf8",
  );
  const menu = readFileSync(
    new URL("../apps/workbench-web/src/components/thread-management.tsx", import.meta.url),
    "utf8",
  );
  assert.match(sidebar, /groupThreadsByActivityDate/u);
  assert.match(sidebar, /<SidebarActivityItem/u);
  assert.doesNotMatch(sidebar, /groupThreadsByTarget|sidebar-target-heading/u);
  assert.match(item, /sidebar-activity-item__title/u);
  assert.match(item, /sidebar-activity-item__metadata/u);
  assert.match(item, /sidebar-activity-item__trailing/u);
  assert.match(item, /ServerOriginBadge/u);
  assert.match(item, /Globe2/u);
  assert.match(item, /stableIdentityColor\(origin\.serverId\)/u);
  assert.match(item, /<ThreadActivity/u);
  assert.doesNotMatch(item, /host === null/u);
  assert.match(item, /aria-current=\{selected \? "page" : undefined\}/u);
  assert.doesNotMatch(menu, /hostActions|hostItems|ThreadHostActionCallbacks/u);
  assert.doesNotMatch(sidebar, /onNewTaskForTarget|onOpenTargetSettings/u);
  assert.doesNotMatch(menu, /ContextMenu\.Separator/u);
  assert.match(menu, /aria-busy=\{forking \|\| undefined\}/u);
  assert.match(menu, /data-forking=\{forking \|\| undefined\}/u);
  assert.match(menu, /正在新建分支/u);
  assert.match(menu, /<\/ContextMenu\.Root>\s*<DropdownMenu\.Root open=\{openMenuKind === "dropdown"\}/u);
  assert.match(menu, /<ContextMenu\.Trigger asChild>\s*<div className="sidebar-activity-row__target">\{children\}<\/div>/u);
  assert.match(menu, /modalHandoff\.current = true; setDraft\(target\.title\)/u);
  assert.match(menu, /onCloseAutoFocus=\{onMenuCloseAutoFocus\}/u);
  assert.match(sidebar, /updateOpenSidebarThreadMenu/u);
  assert.match(menu, /<DropdownMenu\.Root open=\{openMenuKind === "dropdown"\}/u);
  assert.match(menu, /<ContextMenu\.Root open=\{openMenuKind === "context"\}/u);
});

test("Activity hover is mouse-only and touch retains a reachable independent menu", () => {
  const sidebar = readFileSync(
    new URL("../apps/workbench-web/src/components/sidebar.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );
  const controls = readFileSync(
    new URL("../packages/design-system/src/controls.web.scss", import.meta.url),
    "utf8",
  );
  const itemRule = styles.slice(styles.indexOf(".sidebar-activity-item {\n  display: grid;"), styles.indexOf(".sidebar-activity-row {"));
  assert.doesNotMatch(itemRule, /&:hover/u);
  assert.match(styles, /\.sidebar-activity-item\s*\{\s*@include controls\.quiet-control\(\$hover: false\)/u);
  assert.match(controls, /@mixin quiet-control\(\$hover: true\)/u);
  assert.match(controls, /@if \$hover\s*\{\s*@include hover-capable/u);
  assert.match(styles, /@media \(any-hover: hover\) and \(any-pointer: fine\)[\s\S]*?:root:not\(\[data-touch-interaction\]\) \.sidebar-activity-list \.sidebar-activity-row:hover > \.sidebar-activity-row__target > \.sidebar-activity-item:not\(\.is-selected\)/u);
  const menuTriggerRule = styles.slice(styles.indexOf(".sidebar-activity-item__menu-trigger {"), styles.indexOf("@media (any-hover: hover) and (any-pointer: fine)"));
  assert.match(menuTriggerRule, /background: transparent;/u);
  assert.doesNotMatch(styles, /\.sidebar-activity-row:has\(> \.sidebar-activity-item\.is-selected\) \.sidebar-activity-item__menu-trigger/u);
  assert.match(styles, /\.sidebar-activity-item__menu-trigger\[data-forking="true"\]\s*\{[^}]*opacity: 1;[^}]*pointer-events: none;/u);
  assert.match(styles, /@media \(hover: none\), \(any-pointer: coarse\)[\s\S]*?\.sidebar-activity-item__menu-trigger\s*\{[^}]*width: 44px;[^}]*height: 44px;[^}]*opacity: 1;[^}]*pointer-events: auto;/u);
  assert.match(styles, /:root\[data-touch-interaction\] \.sidebar-activity-list/u);
  assert.doesNotMatch(sidebar, /onPointerDownCapture|onPointerMoveCapture/u);
});

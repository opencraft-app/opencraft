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
  assert.match(menu, /在 \{hostActions\.label\} 上新建任务/u);
  assert.match(menu, /\{hostActions\.label\} 设置/u);
  assert.match(menu, /ContextMenu\.Separator/u);
});

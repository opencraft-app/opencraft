import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
    hostId: "local",
    hostLabel: "Local",
    project: "mono2",
    updatedAt: seconds(updatedAt),
    ...overrides,
  };
}

test("Activity chronology owns sections while equal thread ids retain Host provenance", () => {
  const now = new Date(2026, 8, 21, 12);
  const input = [
    thread("same", new Date(2026, 8, 20, 18), { hostId: "remote", hostLabel: "9.1.2.3" }),
    thread("same", new Date(2026, 8, 21, 9)),
    thread("older", new Date(2026, 8, 19, 16)),
  ];
  const groups = groupThreadsByActivityDate(input, now.getTime(), "en-US");

  assert.deepEqual(groups.map(group => group.label), ["Today", "Yesterday", "Saturday"]);
  assert.deepEqual(groups.flatMap(group => group.threads.map(item => `${item.hostId}:${item.id}`)), [
    "local:same",
    "remote:same",
    "local:older",
  ]);
});

test("Activity metadata omits repeated Local identity and preserves remote Host labels", () => {
  const local = thread("local", new Date(2026, 8, 21, 9));
  assert.deepEqual(sidebarActivityMetadata(local), { project: "mono2", host: null });
  assert.deepEqual(sidebarActivityMetadata({
    ...local,
    hostId: "ssh:9.134.163.40",
    hostLabel: "9.134.163.40",
    project: "V8",
  }), { project: "V8", host: "9.134.163.40" });
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
  assert.match(item, /aria-current=\{selected \? "page" : undefined\}/u);
  assert.match(menu, /在 \{hostActions\.label\} 上新建任务/u);
  assert.match(menu, /\{hostActions\.label\} 设置/u);
  assert.match(menu, /ContextMenu\.Separator/u);
});

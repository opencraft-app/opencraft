import assert from "node:assert/strict";
import test from "node:test";
import { sidebarActivityIndicator, summarizeSidebarActivity } from "../../apps/workbench-web/src/sidebar-activity";
import { sidebarThreadTree } from "../../apps/workbench-web/src/sidebar-thread-tree";

const row = (id: string, state: Record<string, unknown> = {}) => ({
  id,
  connectionHostId: "local",
  updatedAt: 1,
  status: "ready",
  unread: false,
  goalActive: false,
  ...state,
});

test("activity summaries share mutually exclusive row precedence", () => {
  for (const [state, expected] of [
    [{ status: "ready", unread: true }, "unread"],
    [{ status: "running", unread: true }, "running"],
    [{ status: "review", unread: true, goalActive: true }, "attention"],
    [{ status: "error", unread: true }, "attention"],
    [{ status: "ready", unread: true, goalActive: true }, "goal"],
    [{ status: "ready", unread: false }, "none"],
  ] as const)
    assert.equal(sidebarActivityIndicator(state), expected);
});

test("full group trees include folded descendants, distinguish Hosts and deduplicate roots", () => {
  const tree = sidebarThreadTree([
    row("parent", { unread: true }),
    row("wait", { parentThreadId: "parent", status: "review" }),
    row("error", { parentThreadId: "parent", status: "error" }),
    row("running", { parentThreadId: "parent", status: "running", unread: true }),
    row("goal", { parentThreadId: "parent", goalActive: true, unread: true }),
    row("parent", { connectionHostId: "remote", unread: true }),
    row("hidden", { visibility: "hidden", status: "running" }),
    row("nonparticipant", { unread: true }),
  ]);
  const summary = summarizeSidebarActivity(
    [...tree.roots, ...tree.roots],
    (thread) => thread.unread && thread.id !== "nonparticipant",
  );
  assert.deepEqual(summary, { unread: 2, attention: 2, running: 2 });
});

test("reading, completion and waits update categories without turning navigation into work", () => {
  const first = row("thread", { status: "running", unread: true });
  const summarize = () => summarizeSidebarActivity(sidebarThreadTree([first]).roots);
  assert.deepEqual(summarize(), { unread: 0, attention: 0, running: 1 });
  first.status = "ready";
  assert.deepEqual(summarize(), { unread: 1, attention: 0, running: 0 });
  first.unread = false;
  assert.deepEqual(summarize(), { unread: 0, attention: 0, running: 0 });
  first.status = "review";
  assert.deepEqual(summarize(), { unread: 0, attention: 1, running: 0 });
});

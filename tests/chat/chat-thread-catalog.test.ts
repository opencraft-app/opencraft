import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
import { projectAppServerThread, projectThreadAgent } from "@opencraft/workbench-runtime";

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "01a0473e-1f50-7a56-a9af-d656b84deb09",
    name: "☁️ skip发布运维用",
    preview: "skip发布运维用",
    cwd: "/data/opencraft",
    updatedAt: 100,
    status: { type: "idle" },
    forkedFromId: null,
    parentThreadId: null,
    ...overrides,
  } as Thread;
}

test("same-title root, fork and subagent Threads retain visible lineage identity", () => {
  const root = projectAppServerThread(thread({}), 100_000);
  const fork = projectAppServerThread(thread({ forkedFromId: "root-thread" }), 100_000);
  const subagent = projectAppServerThread(thread({ parentThreadId: "parent-thread" }), 100_000);

  assert.equal(root.title, "skip发布运维用");
  assert.equal(root.project, "opencraft");
  assert.equal(root.lineage, "root");
  assert.equal(fork.lineage, "fork");
  assert.equal(subagent.lineage, "subagent");
});

test("AppServer loading and failure states retain their product meaning", () => {
  assert.equal(projectAppServerThread(thread({ status: { type: "notLoaded" } }), 100_000).status, "ready");
  assert.equal(projectAppServerThread(thread({ status: { type: "idle" } }), 100_000).status, "ready");
  assert.equal(projectAppServerThread(thread({ status: { type: "active", activeFlags: [] } }), 100_000).status, "running");
  assert.equal(projectAppServerThread(thread({ status: { type: "systemError" } }), 100_000).status, "error");
});

test("catalog preserves native creation and recency separately for active ordering", () => {
  const projected = projectAppServerThread(thread({ createdAt: 10, updatedAt: 300, recencyAt: 200 }), 300_000);
  assert.equal(projected.createdAt, 10);
  assert.equal(projected.updatedAt, 200);
  assert.equal(projectAppServerThread(thread({ updatedAt: 300 })).updatedAt, 300);
});

test("thread Agent identity follows the declaring Host and most specific execution namespace, never the model provider", () => {
  const engines = { defaultEngine: "dsh", providers: [
    { id: "codebuddy", label: "CodeBuddy CLI", threadPrefix: "codebuddy_" },
    { id: "codebuddy-ide", label: "CodeBuddy IDE", threadPrefix: "codebuddy_ide_" },
    { id: "cursor", label: "Cursor", threadPrefix: "cursor_" },
    { id: "codex", label: "Codex", threadPrefix: "codex_" },
    { id: "pi-cli", label: "Pi", threadPrefix: "picli_" },
  ] };
  assert.equal(projectAppServerThread(thread({ id: "cursor_native", modelProvider: "openai" }), 100_000, engines).agent?.id, "cursor");
  assert.equal(projectThreadAgent("codebuddy_ide_native", engines)?.id, "codebuddy-ide");
  assert.equal(projectThreadAgent("picli_native", engines)?.label, "Pi");
  assert.equal(projectThreadAgent("native-uuid", engines)?.id, "dsh");
  assert.equal(projectThreadAgent("native-uuid", { defaultEngine: "codex" })?.id, "codex");
  assert.equal(projectAppServerThread(thread({ modelProvider: "openai" })).agent, undefined);
  assert.equal(projectThreadAgent("codex_native", { providers: [{ id: null, threadPrefix: "codex_" }] }), undefined);
});

test("unnamed children use native identity instead of indistinguishable New chat rows", () => {
  const child = { parentThreadId: "parent", name: null, preview: "", agentNickname: "Atlas", agentRole: "reviewer" };
  assert.equal(projectAppServerThread(thread(child)).title, "Atlas");
  assert.equal(projectAppServerThread(thread({ ...child, name: "任务审查" })).title, "任务审查");
  assert.equal(projectAppServerThread(thread({ ...child, name: "  ", preview: "检查侧栏层级" })).title, "检查侧栏层级");
  assert.equal(projectAppServerThread(thread({ ...child, agentNickname: " " })).title, "reviewer · #b84deb09");
  assert.equal(projectAppServerThread(thread({ ...child, agentNickname: null, agentRole: null })).title, "#b84deb09");
  assert.equal(projectAppServerThread(thread({ ...child, id: "child-00000002", agentNickname: null, agentRole: null })).title, "#00000002");
  assert.equal(projectAppServerThread(thread({ name: null, preview: "", parentThreadId: null })).title, "New chat");
});

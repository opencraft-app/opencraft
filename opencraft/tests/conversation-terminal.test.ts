import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerServerRequestInterceptor } from "@opencraft/appserver-client";
import type { AppServerServerRequest } from "@opencraft/appserver-protocol";
import {
  ConversationTerminalSessionRegistry,
  installConversationTerminalDynamicToolHandler,
  OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS,
  OPENCRAFT_TERMINAL_DYNAMIC_TOOLS,
  RegistryConversationTerminalToolHost,
  type AppServerTerminalSession,
  type AppServerTerminalSnapshot,
  type AppServerWorkbenchRuntime,
} from "@opencraft/workbench-runtime";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";

import { createTerminalWorkbenchPanelPlugin } from "../plugins/terminal/src/index";
import { OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS } from "../apps/workbench-web/src/runtime/workbench-dynamic-tools";

class FakeTerminalSession implements AppServerTerminalSession {
  private snapshot: AppServerTerminalSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(readonly processId: string) {
    this.snapshot = Object.freeze({
      revision: 0,
      hostId: "host-1",
      processId,
      connectionGeneration: 1,
      phase: "running",
      output: [],
      exitCode: null,
      error: null,
    });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async write() {}
  async resize() {}
  async terminate() {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      phase: "exited",
      exitCode: 0,
    });
    this.listeners.forEach((listener) => listener());
  }
  async dispose() {
    this.listeners.clear();
  }

  emitBytes(chunks: readonly Uint8Array[]) {
    const start = this.snapshot.output.at(-1)?.sequence ?? 0;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      output: Object.freeze([
        ...this.snapshot.output,
        ...chunks.map((bytes, index) => ({
          sequence: start + index + 1,
          stream: "stdout" as const,
          deltaBase64: Buffer.from(bytes).toString("base64"),
        })),
      ]),
    });
    this.listeners.forEach((listener) => listener());
  }
}

function fixture(bufferLimit = 16_000) {
  const sessions: FakeTerminalSession[] = [];
  const terminal = {
    open() {
      const session = new FakeTerminalSession(`process-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    },
    attach() { throw new Error("not used"); },
    async list() { return { processes: [] }; },
  };
  const runtime = { resources: { terminal } } as unknown as AppServerWorkbenchRuntime;
  const registry = new ConversationTerminalSessionRegistry(() => runtime, bufferLimit);
  return { registry, sessions };
}

function toolHarness(host: RegistryConversationTerminalToolHost) {
  let interceptor: AppServerServerRequestInterceptor | null = null;
  const dispose = installConversationTerminalDynamicToolHandler({
    interceptServerRequest(value) {
      interceptor = value;
      return () => { interceptor = null; };
    },
  }, host, { hostId: "host-1" });
  return {
    async call(request: AppServerServerRequest, fallback: unknown = "fallback") {
      assert.notEqual(interceptor, null);
      return interceptor!(request, async () => fallback);
    },
    dispose,
  };
}

function terminalToolRequest(overrides: Partial<AppServerServerRequest["params"]> = {}): AppServerServerRequest {
  return {
    id: "request-1",
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "read_thread_terminal",
      arguments: {},
      ...overrides,
    },
  } as AppServerServerRequest;
}

test("conversation terminal directory owns ordered sessions, active selection and bounded UTF-8 output", async () => {
  const { registry, sessions } = fixture(11);
  try {
    const first = registry.open({
      resourceOwnerId: "scope-1",
      hostId: "host-1",
      cwd: "/workspace/one",
    });
    const second = registry.open({
      resourceOwnerId: "scope-1",
      hostId: "host-1",
      cwd: "/workspace/two",
    });
    const beforeOutput = registry.getConversationSnapshot("scope-1");
    assert.equal(registry.getConversationSnapshot("scope-1"), beforeOutput);
    assert.deepEqual(beforeOutput.sessionIds, [first, second]);
    assert.equal(beforeOutput.activeSessionId, second);

    const encoded = new TextEncoder().encode("prefix-中文-terminal");
    sessions[0]!.emitBytes([encoded.subarray(0, 8), encoded.subarray(8)]);
    const afterOutput = registry.getConversationSnapshot("scope-1");
    assert.notEqual(afterOutput, beforeOutput);
    assert.ok(afterOutput.revision > beforeOutput.revision);
    registry.setActive(first);
    const snapshot = registry.getSnapshotForConversation("scope-1");
    assert.equal(snapshot?.cwd, "/workspace/one");
    assert.equal(snapshot?.shell, "/bin/bash");
    assert.equal(snapshot?.buffer, "中文-terminal");
    assert.equal(snapshot?.truncated, true);

    registry.release(first);
    assert.equal(registry.getConversationSnapshot("scope-1").activeSessionId, second);
    registry.releaseOwner("scope-1");
    assert.equal(registry.getSnapshotForConversation("scope-1"), null);
  } finally {
    await registry.dispose();
  }
});

test("terminal panel activation updates the conversation current terminal without adopting panel owner identity", async () => {
  const { registry } = fixture();
  const panels = await createWorkbenchPanelReactRuntime();
  try {
    await panels.install(createTerminalWorkbenchPanelPlugin(registry));
    const action = panels.panels.getToolbarActionSnapshot()[0]!;
    const context = {
      ownerId: "route-view-1",
      resourceOwnerId: "conversation-scope-1",
      hostId: "host-1",
      cwd: "/workspace",
    };
    await action.run(context);
    await action.run(context);
    const state = panels.panels.getOwnerSnapshot(context.ownerId);
    const [first, second] = state.right.tabs.filter((tab) => tab.kind === "terminal");
    assert.equal(registry.getConversationSnapshot(context.resourceOwnerId).activeSessionId, second?.resource);

    panels.panels.dispatch(context.ownerId, {
      type: "activate-tab",
      region: "right",
      tabId: first!.id,
    });
    assert.equal(registry.getConversationSnapshot(context.resourceOwnerId).activeSessionId, first?.resource);
  } finally {
    await panels.dispose();
    await registry.dispose();
  }
});

test("read_thread_terminal is an unnamespaced no-argument tool scoped by Host and Thread", async () => {
  assert.deepEqual(OPENCRAFT_TERMINAL_DYNAMIC_TOOLS.map((spec) => spec.name), [
    "read_thread_terminal",
  ]);
  assert.deepEqual(
    OPENCRAFT_WORKBENCH_DYNAMIC_TOOLS.flatMap((spec) =>
      spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : [spec.name]),
    ["open_in_vela", "get_tab_context", "browser_use", "read_thread_terminal", "search_tools", "get_tool", "call_tool"],
  );
  assert.deepEqual(OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS.map(spec => spec.type === "namespace" ? spec.name : null), ["connectors"]);
  assert.ok(OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS.every(spec => spec.type === "namespace" && spec.tools.every(tool => tool.deferLoading === true)));
  const { registry, sessions } = fixture();
  const sessionId = registry.open({
    resourceOwnerId: "scope-1",
    hostId: "host-1",
    cwd: "/workspace",
  });
  sessions[0]!.emitBytes([new TextEncoder().encode("$ npm test\npassed\n")]);
  registry.setActive(sessionId);
  const seen: Array<{ hostId: string; threadId: string }> = [];
  const host = new RegistryConversationTerminalToolHost(registry, (context) => {
    seen.push(context);
    return context.hostId === "host-1" && context.threadId === "thread-1" ? "scope-1" : null;
  });
  const harness = toolHarness(host);
  try {
    const result = await harness.call(terminalToolRequest());
    assert.equal((result as { success: boolean }).success, true);
    assert.match(
      (result as { contentItems: Array<{ text: string }> }).contentItems[0]!.text,
      /cwd: \/workspace[\s\S]*\$ npm test[\s\S]*passed/u,
    );
    assert.deepEqual(seen, [{ hostId: "host-1", threadId: "thread-1" }]);

    const invalid = await harness.call(terminalToolRequest({ arguments: { sessionId } }));
    assert.equal((invalid as { success: boolean }).success, false);
    assert.match((invalid as { contentItems: Array<{ text: string }> }).contentItems[0]!.text, /takes no arguments/u);

    const isolated = await harness.call(terminalToolRequest({ threadId: "other-thread" }));
    assert.equal((isolated as { success: boolean }).success, false);
    assert.match((isolated as { contentItems: Array<{ text: string }> }).contentItems[0]!.text, /bound to this Thread/u);

    assert.equal(await harness.call(terminalToolRequest({ namespace: "other" })), "fallback");
  } finally {
    harness.dispose();
    await registry.dispose();
  }
});

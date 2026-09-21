import assert from "node:assert/strict";
import test from "node:test";

import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import {
  countDynamicToolDefinitions,
  verifyDynamicToolRegistration,
} from "@opencraft/workbench-runtime";

class TerminalFailureTransport implements DuplexTransport {
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(): Promise<void> {
    this.currentStatus = {
      state: "failed",
      reason: "resource not found",
      failure: { code: "remote-resource-not-found", recovery: "manual" },
    };
    for (const listener of this.statusListeners) listener(this.currentStatus);
    return Promise.reject(new Error("resource not found"));
  }

  send(): Promise<void> {
    return Promise.reject(new Error("transport is closed"));
  }

  subscribeMessage(): () => void {
    return () => undefined;
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.currentStatus = { state: "closed" };
  }
}

class GenerationTransport implements DuplexTransport {
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  closed = false;

  constructor(private readonly connectSucceeds: boolean) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("transport generation is closed"));
    if (!this.connectSucceeds) {
      this.setStatus({ state: "failed", reason: "first generation failed" });
      return Promise.reject(new Error("first generation failed"));
    }
    this.setStatus({ state: "open" });
    return Promise.resolve();
  }

  send(frame: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("transport generation is closed"));
    const request = JSON.parse(frame) as { id?: string | number; method?: string };
    if (request.method === "initialize") {
      queueMicrotask(() => {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            codexHome: "/tmp/codex",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "generation-test/1",
          },
        });
        for (const listener of this.messageListeners) listener(response);
      });
    }
    return Promise.resolve();
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setStatus({ state: "closed" });
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

test("Workbench does not automatically reconnect a terminal transport failure", async () => {
  const timers: unknown[] = [];
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "terminal-host",
    transport: new TerminalFailureTransport(),
    autoReconnect: true,
    clock: {
      setTimeout(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimeout(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  });

  try {
    await assert.rejects(runtime.connect(), /resource not found/u);
    assert.equal(runtime.getSnapshot().phase, "error");
    assert.equal(timers.length, 0);
  } finally {
    await runtime.dispose();
  }
});

test("Workbench reconnect replaces a transport generation closed by failed initialization", async () => {
  const generations = [new GenerationTransport(false), new GenerationTransport(true)];
  let created = 0;
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "replace-transport",
    createTransport: () => generations[created++]!,
    autoReconnect: false,
  });

  try {
    await assert.rejects(runtime.connect(), /first generation failed/u);
    assert.equal(generations[0]!.closed, true);
    await runtime.reconnect();
    assert.equal(created, 2);
    assert.equal(generations[1]!.closed, false);
    assert.equal(runtime.getSnapshot().phase, "ready");
  } finally {
    await runtime.dispose();
  }
});

test("Workbench stops automatic retry after failed initialization closes a fixed transport", async () => {
  const timers: unknown[] = [];
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "fixed-transport",
    transport: new GenerationTransport(false),
    autoReconnect: true,
    clock: {
      setTimeout(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimeout(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  });

  try {
    await assert.rejects(runtime.connect(), /first generation failed/u);
    assert.equal(timers.length, 0);
  } finally {
    await runtime.dispose();
  }
});

test("Workbench rejects ambiguous fixed and factory transport ownership", () => {
  assert.throws(() => createAppServerWorkbenchRuntime({
    hostId: "ambiguous-transport",
    transport: new GenerationTransport(true),
    createTransport: () => new GenerationTransport(true),
  }), /exactly one transport ownership mode/u);
});

test("Thread capability readiness counts namespace tools and rejects a partial Host lease", () => {
  const dynamicTools = [
    {
      type: "namespace" as const,
      name: "vela_browser",
      description: "Browser tools",
      tools: [
        { type: "function" as const, name: "get_tab_context", description: "Read", inputSchema: { type: "object" } },
        { type: "function" as const, name: "browser_use", description: "Operate", inputSchema: { type: "object" } },
      ],
    },
    { type: "function" as const, name: "open_in_vela", description: "Open", inputSchema: { type: "object" } },
  ];

  assert.equal(countDynamicToolDefinitions(dynamicTools), 3);
  assert.doesNotThrow(() => verifyDynamicToolRegistration(dynamicTools, { registered: 3 }));
  assert.throws(
    () => verifyDynamicToolRegistration(dynamicTools, { registered: 0 }),
    /registered 0 of 3 dynamic tools/u,
  );
});

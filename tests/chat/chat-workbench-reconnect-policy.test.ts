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

  constructor(private readonly failureCode = "remote-resource-not-found") {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(): Promise<void> {
    this.currentStatus = {
      state: "failed",
      reason: "resource not found",
      failure: { code: this.failureCode, recovery: "manual" },
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
  connectCalls = 0;
  private readonly recoveryListeners = new Set<() => void>();
  subscribeRecoveryHint(listener: () => void): () => void { this.recoveryListeners.add(listener); return () => this.recoveryListeners.delete(listener); }
  recoveryHint(): void { for (const listener of this.recoveryListeners) listener(); }
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  closed = false;

  constructor(private readonly connectSucceeds: boolean) {}

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(): Promise<void> {
    this.connectCalls++;
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
            codexHome: "/tmp/reconnect-fixture",
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

  setStatus(status: TransportStatus): void {
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
    assert.equal(runtime.getSnapshot().transport.failure?.code, "remote-resource-not-found");
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
    // Logical failure settles before physical transport cleanup.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(generations[0]!.closed, true);
    await runtime.reconnect();
    assert.equal(created, 2);
    assert.equal(generations[1]!.closed, false);
    assert.equal(runtime.getSnapshot().phase, "ready");
  } finally {
    await runtime.dispose();
  }
});

test("Workbench automatic reconnect backs off to a one-minute ceiling", async () => {
  const scheduled: Array<{ readonly callback: () => void; readonly delay: number }> = [];
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "backoff-host",
    createTransport: () => new GenerationTransport(false),
    autoReconnect: true,
    clock: {
      setTimeout(callback, delay) {
        scheduled.push({ callback, delay });
        return callback;
      },
      clearTimeout(timer) {
        const index = scheduled.findIndex(entry => entry.callback === timer);
        if (index >= 0) scheduled.splice(index, 1);
      },
    },
  });

  try {
    await assert.rejects(runtime.connect(), /first generation failed/u);
    for (const expectedDelay of [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000]) {
      assert.equal(scheduled.length, 1);
      const next = scheduled.shift()!;
      assert.equal(next.delay, expectedDelay);
      next.callback();
      // A pending attempt owns a deadline before its failure schedules the retry.
      await new Promise<void>(resolve => setImmediate(resolve));
      for (let attempt = 0; attempt < 10 && scheduled.length === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
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
    await new Promise<void>(resolve => setImmediate(resolve));
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

test("Thread capability readiness distinguishes cold deferral from partial Host leases", () => {
  const dynamicTools = [
    {
      type: "namespace" as const,
      name: "opencraft_browser",
      description: "Browser tools",
      tools: [
        { type: "function" as const, name: "get_tab_context", description: "Read", inputSchema: { type: "object" } },
        { type: "function" as const, name: "browser_use", description: "Operate", inputSchema: { type: "object" } },
      ],
    },
    { type: "function" as const, name: "open_in_opencraft", description: "Open", inputSchema: { type: "object" } },
  ];

  assert.equal(countDynamicToolDefinitions(dynamicTools), 3);
  assert.doesNotThrow(() => verifyDynamicToolRegistration(dynamicTools, { registered: 3 }));
  assert.doesNotThrow(() => verifyDynamicToolRegistration(
    dynamicTools,
    { registered: 0, deferred: true },
    { allowDeferred: true },
  ));
  assert.throws(
    () => verifyDynamicToolRegistration(dynamicTools, { registered: 0, deferred: true }),
    /registered 0 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDynamicToolRegistration(dynamicTools, { registered: 0 }),
    /registered 0 of 3 dynamic tools/u,
  );
  assert.throws(
    () => verifyDynamicToolRegistration(dynamicTools, { registered: 2, deferred: true }, { allowDeferred: true }),
    /registered 2 of 3 dynamic tools/u,
  );
});

test("factory startup failure survives cleanup and clears only on a fresh attempt", async () => {
  let created = 0;
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "startup-failure",
    createTransport: () => created++ === 0 ? new TerminalFailureTransport() : new GenerationTransport(true),
    autoReconnect: false,
  });
  const observed: Array<{ phase: string; code: string | undefined }> = [];
  runtime.subscribe(() => observed.push({ phase: runtime.getSnapshot().phase, code: runtime.getSnapshot().transport.failure?.code }));
  try {
    await assert.rejects(runtime.connect(), /resource not found/);
    assert.equal(runtime.getSnapshot().transport.failure?.code, "remote-resource-not-found");
    assert.equal(runtime.getSnapshot().transport.failure?.recovery, "manual");
    assert.ok(observed.filter(item => item.phase === "error").every(item => item.code === "remote-resource-not-found"));
    await runtime.reconnect();
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(runtime.getSnapshot().transport.failure, undefined);
    assert.equal(created, 2);
  } finally { await runtime.dispose(); }
});

test("manual retries replace configuration failures with the current attempt's classification", async () => {
  let created = 0;
  const codes = ["intervention:configuration-required", "intervention:authentication-required"];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "classified-startup", autoReconnect: false,
    createTransport: () => created < codes.length ? new TerminalFailureTransport(codes[created++]) : new GenerationTransport(true) });
  try {
    await assert.rejects(runtime.connect());
    assert.equal(runtime.getSnapshot().transport.failure?.code, codes[0]);
    await assert.rejects(runtime.reconnect());
    assert.equal(runtime.getSnapshot().transport.failure?.code, codes[1]);
    await runtime.connect();
    assert.equal(runtime.getSnapshot().phase, "ready");
    assert.equal(runtime.getSnapshot().transport.failure, undefined);
  } finally { await runtime.dispose(); }
});


test("short-lived reconnects retain escalation, stable readiness resets it and disposal cancels timers", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const generations: GenerationTransport[] = [];
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "flapping-host", autoReconnect: true, reconnectStableMs: 60_000,
    createTransport: () => { const transport = new GenerationTransport(true); generations.push(transport); return transport; },
    clock: {
      setTimeout(callback, delay) { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      clearTimeout(timer) { const index = scheduled.indexOf(timer as typeof scheduled[number]); if (index >= 0) scheduled.splice(index, 1); },
    },
  });
  try {
    await runtime.connect();
    const staleStability = scheduled[0]!.callback;
    for (const delay of [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 60_000]) {
      generations.at(-1)!.setStatus({ state: "failed", failure: { code: "SSH_LINK_LOST", recovery: "automatic" } });
      assert.deepEqual(scheduled.map(timer => timer.delay), [delay]);
      scheduled.shift()!.callback();
      for (let i = 0; i < 20 && runtime.getSnapshot().phase !== "ready"; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(runtime.getSnapshot().phase, "ready");
      assert.deepEqual(scheduled.map(timer => timer.delay), [60_000]);
      staleStability(); // A cancelled callback arriving late cannot reset a new generation.
      assert.deepEqual(scheduled.map(timer => timer.delay), [60_000]);
    }
    scheduled.shift()!.callback();
    generations.at(-1)!.setStatus({ state: "failed" });
    assert.deepEqual(scheduled.map(timer => timer.delay), [500]);
    await runtime.reconnect();
    assert.equal(scheduled.length, 1);
  } finally { await runtime.dispose(); }
  assert.equal(scheduled.length, 0);
});

test("foreground advances a scheduled reconnect; duplicate hints do not bypass the cooldown", async () => {
  const scheduled = new Set<unknown>();
  const generations: GenerationTransport[] = [];
  const runtime = createAppServerWorkbenchRuntime({
    hostId: "foreground-host", autoReconnect: true, reconnectDelaysMs: [60_000],
    createTransport: () => { const transport = new GenerationTransport(true); generations.push(transport); return transport; },
    clock: { setTimeout(callback, delay) { const timer = { callback, delay }; scheduled.add(timer); return timer; },
      clearTimeout(timer) { scheduled.delete(timer); } },
  });
  try {
    await runtime.connect();
    const old = generations[0]!;
    old.setStatus({ state: "failed", failure: { code: "SSH_LINK_LOST", recovery: "automatic" } });
    assert.equal(scheduled.size, 1);
    old.recoveryHint(); old.recoveryHint();
    for (let i=0;i<20 && runtime.getSnapshot().phase!=="ready";i++) await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(runtime.getSnapshot().phase,"ready");
    assert.equal(old.connectCalls,2);
    old.setStatus({state:"failed",failure:{code:"SSH_LINK_LOST",recovery:"automatic"}});
    old.recoveryHint(); await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(old.connectCalls,2,"event burst does not bypass cooldown after a short-lived reconnect");
    assert.equal(runtime.getSnapshot().phase,"reconnecting");
  } finally { await runtime.dispose(); }
  assert.equal(scheduled.size,0);
});

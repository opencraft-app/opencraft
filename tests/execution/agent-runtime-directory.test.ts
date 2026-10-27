import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeDirectory,
  HostRuntimeRegistry,
  type AgentRuntimeSession,
} from "@opencraft/workbench-runtime";

class FakeAgentRuntime implements AgentRuntimeSession {
  private readonly listeners = new Set<() => void>();
  private phase: "idle" | "connecting" | "ready" | "disposed" = "idle";
  private releaseConnection: (() => void) | null = null;
  readonly calls: string[] = [];
  readonly resources = {
    protocol: {
      request: async (method: string) => {
        this.calls.push(method);
        return { ok: true } as never;
      },
    },
  };

  constructor(readonly hostId: string, private readonly delayed = false) {}

  getSnapshot = () => ({ hostId: this.hostId, phase: this.phase, error: null });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(): Promise<void> {
    if (this.phase === "ready") return;
    this.phase = "connecting";
    this.publish();
    if (this.delayed) await new Promise<void>((resolve) => { this.releaseConnection = resolve; });
    this.phase = "ready";
    this.publish();
  }

  release(): void {
    this.releaseConnection?.();
    this.releaseConnection = null;
  }

  async dispose(): Promise<void> {
    this.phase = "disposed";
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

function registryFor(runtime: FakeAgentRuntime) {
  return new HostRuntimeRegistry<AgentRuntimeSession>([{
    descriptor: {
      hostId: runtime.hostId,
      label: "Local",
      kind: "local",
      transportEndpoint: "OpenCraft Daemon",
      executionLocation: "This device",
      workspaceBrowseRoots: [],
    },
    createRuntime: () => runtime,
  }]);
}

test("protocol requests wait for application runtime binding and Host readiness", async () => {
  const runtime = new FakeAgentRuntime("local", true);
  const registry = registryFor(runtime);
  const directory = new AgentRuntimeDirectory();
  const phases: string[] = [];
  const stop = directory.subscribe("local", () => phases.push(directory.getSnapshot("local").phase));
  const request = directory.request("local", "runtime/status/read", {});
  await Promise.resolve();
  assert.deepEqual(runtime.calls, []);
  assert.equal(directory.getSnapshot("local").phase, "bootstrapping");
  directory.bindRegistry(registry);
  await Promise.resolve();
  assert.equal(directory.getSnapshot("local").phase, "connecting");
  assert.deepEqual(runtime.calls, []);
  runtime.release();
  assert.deepEqual(await request, { ok: true });
  assert.deepEqual(runtime.calls, ["runtime/status/read"]);
  assert.equal(directory.getSnapshot("local").phase, "ready");
  assert.ok(phases.includes("connecting"));
  stop();
  await registry.dispose();
});

test("a terminal application startup failure rejects pending runtime requests", async () => {
  const directory = new AgentRuntimeDirectory();
  const request = directory.request("local", "runtime/status/read", {});
  directory.markUnavailable(new Error("No Agent Runtime is configured"));
  await assert.rejects(request, /No Agent Runtime is configured/u);
  assert.equal(directory.getSnapshot("local").phase, "error");
});

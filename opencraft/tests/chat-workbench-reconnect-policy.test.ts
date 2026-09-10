import assert from "node:assert/strict";
import test from "node:test";

import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

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

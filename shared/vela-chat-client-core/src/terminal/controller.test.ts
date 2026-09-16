import assert from "node:assert/strict";
import test from "node:test";

import type {TerminalSession} from "../platform/api.js";
import {
  TerminalController,
  type TerminalOpener,
} from "./controller.js";
import type {
  TerminalCallbacks,
  TerminalConnection,
} from "./tat-pty.js";

function session(id: string): TerminalSession {
  return {
    authentication: {appId: 1, instanceId: "rins-test", uin: "10001"},
    expiresAt: "2026-08-01T03:05:00.000Z",
    protocol: "tencent-tat-pty-v1",
    sessionId: id,
    terminal: {cols: 80, maxIdleSeconds: 3600, rows: 24},
    webSocketUrl: "wss://terminal.example.test/connect",
  };
}

class FakeOpener implements TerminalOpener {
  public callbacks: TerminalCallbacks[] = [];
  public connections: Array<TerminalConnection & {closed: boolean; writes: Uint8Array[]}> = [];
  public sessions: TerminalSession[] = [];

  public async open(value: TerminalSession, callbacks: TerminalCallbacks) {
    const connection = {
      closed: false,
      writes: [] as Uint8Array[],
      close() { this.closed = true; },
      resize() {},
      write(data: Uint8Array) { this.writes.push(data); },
    };
    this.sessions.push(value);
    this.callbacks.push(callbacks);
    this.connections.push(connection);
    return connection;
  }
}

test("TerminalController obtains a fresh one-time session for every open", async () => {
  const opener = new FakeOpener();
  let issued = 0;
  const controller = new TerminalController({
    createSession: async () => session(`session-${++issued}`),
    opener,
  });

  await controller.open();
  await controller.open();

  assert.deepEqual(opener.sessions.map((item) => item.sessionId), [
    "session-1", "session-2",
  ]);
  assert.equal(opener.connections[0]?.closed, true);
  assert.equal(controller.snapshot().status, "ready");
});

test("TerminalController bounds output and reports truncation", async () => {
  const opener = new FakeOpener();
  const controller = new TerminalController({
    createSession: async () => session("session-1"),
    maxOutputBytes: 5,
    opener,
  });
  await controller.open();

  opener.callbacks[0]?.onOutput(new TextEncoder().encode("hello"));
  opener.callbacks[0]?.onOutput(new TextEncoder().encode("!"));

  assert.equal(
    new TextDecoder().decode(controller.snapshot().output),
    "ello!",
  );
  assert.equal(controller.snapshot().truncated, true);
});

test("TerminalController maps native line and control keys to PTY bytes", async () => {
  const opener = new FakeOpener();
  const controller = new TerminalController({
    createSession: async () => session("session-1"),
    opener,
  });
  await controller.open();

  controller.submitLine("pwd");
  controller.sendControl("ctrl_c");
  controller.sendControl("tab");
  controller.sendControl("arrow_up");

  assert.deepEqual(
    opener.connections[0]?.writes.map((value) => Array.from(value)),
    [
      Array.from(new TextEncoder().encode("pwd\r")),
      [0x03],
      [0x09],
      [0x1b, 0x5b, 0x41],
    ],
  );
});

test("TerminalController ignores stale async opens after close", async () => {
  const opener = new FakeOpener();
  let resolveSession: ((value: TerminalSession) => void) | undefined;
  const controller = new TerminalController({
    createSession: () => new Promise((resolve) => {
      resolveSession = resolve;
    }),
    opener,
  });

  const opening = controller.open();
  controller.close();
  resolveSession?.(session("stale-session"));
  await opening;

  assert.equal(opener.sessions.length, 0);
  assert.equal(controller.snapshot().status, "closed");
});

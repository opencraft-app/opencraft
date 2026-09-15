import assert from "node:assert/strict";
import test from "node:test";

import { SshInteractiveTerminalService } from "../src/services/ssh-interactive-terminal.ts";

function serviceContext() {
  const releases = [];
  const aliases = [];
  return {
    appServer: { register: () => () => {} },
    userDirectory: {
      identityForConnection: () => ({
        id: "user-1", username: "root", linuxUid: 20000, linuxGid: 20000,
      }),
    },
    workspaceFilesystem: {
      enabled: true,
      v2: true,
      attachmentFor: (viewId) => {
        assert.equal(viewId, "main");
        return { capabilityId: "root-capability" };
      },
    },
    workspaceView: {
      bindLeaseAlias: (...args) => aliases.push(["bind", ...args]),
      unbindLeaseAlias: (...args) => aliases.push(["unbind", ...args]),
    },
    threadWriteLease: {
      acquire: () => ({ acquired: true }),
      release: (...args) => releases.push(args),
      errorFor: () => new Error("busy"),
    },
    releases,
    aliases,
  };
}

test("management terminal uses the root Workspace v2 attachment", () => {
  const previousWorkspaces = globalThis.hostWorkspaces;
  const previousTerminal = globalThis.hostTerminal;
  const calls = [];
  globalThis.hostWorkspaces = {
    openTerminal: (...args) => {
      calls.push(["open", ...args]);
      return { cwd: "/workspace/projects", shell: "/bin/bash" };
    },
    writeTerminal: (...args) => calls.push(["write", ...args]),
    resizeTerminal: (...args) => calls.push(["resize", ...args]),
    drainTerminal: (...args) => {
      calls.push(["drain", ...args]);
      return { outputBytes: [111, 107], exited: false, cwd: "/workspace/projects" };
    },
    closeTerminal: (...args) => calls.push(["close", ...args]),
  };
  globalThis.hostTerminal = {
    spawnForUser: () => assert.fail("host terminal must not be used"),
    write: () => assert.fail("host terminal must not be used"),
    resize: () => assert.fail("host terminal must not be used"),
    drain: () => assert.fail("host terminal must not be used"),
    kill: () => assert.fail("host terminal must not be used"),
  };
  try {
    const service = Object.create(SshInteractiveTerminalService.prototype);
    service.ctx = serviceContext();
    service.sessions = new Map();
    const opened = service.open({ connectionId: "connection-1", sessionId: "session-1", cols: 120, rows: 40 });
    assert.equal(opened.backend, "workspace-v2");
    assert.equal(opened.cwd, "/workspace/projects");
    assert.deepEqual(calls.shift(), ["open", "terminal-session-1", "root-capability", 120, 40]);

    const drained = service.write("session-1", new Uint8Array([97]));
    assert.deepEqual(drained.outputBytes, [111, 107]);
    assert.deepEqual(calls.splice(0, 2), [
      ["write", "terminal-session-1", new Uint8Array([97])],
      ["drain", "terminal-session-1"],
    ]);
    service.resize("session-1", 100, 30);
    service.close("session-1");
    assert.deepEqual(calls, [
      ["resize", "terminal-session-1", 100, 30],
      ["close", "terminal-session-1"],
    ]);
    assert.equal(service.ctx.releases.length, 1);
  } finally {
    globalThis.hostWorkspaces = previousWorkspaces;
    globalThis.hostTerminal = previousTerminal;
  }
});

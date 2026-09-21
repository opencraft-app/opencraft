import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceFilesystemService,
  workspaceSqliteHome,
} from "../src/services/workspace-filesystem.js";

function filesystemService(attachment) {
  const service = Object.create(WorkspaceFilesystemService.prototype);
  service.v2 = true;
  service.enabled = true;
  service.mount = "/workspace";
  service.v2Attachments = new Map();
  service.v2Processes = new Map();
  service.watchSequence = 0;
  service.watchEntries = new Map();
  service.watchConsumers = new Map();
  service.ctx = { workspaceAttachment: attachment };
  return service;
}

test("workspace filesystem uses its opaque v2 attachment capability", () => {
  const previousWorkspaces = globalThis.hostWorkspaces;
  const calls = [];
  globalThis.hostWorkspaces = {
    enabled: true,
    root: () => ({ threadId: "root-thread" }),
    metadata(...args) { calls.push(["metadata", ...args]); return { isFile: true }; },
    readDirectory(...args) { calls.push(["readDirectory", ...args]); return []; },
    readFile(...args) { calls.push(["readFile", ...args]); return [104, 105]; },
    writeFile(...args) { calls.push(["writeFile", ...args]); },
  };
  const attachment = {
    attach(params) {
      calls.push(["attach", params.threadId, params.engineId, params.cwd]);
      return { capabilityId: "capability-1", detach() {} };
    },
  };
  try {
    const service = filesystemService(attachment);
    assert.deepEqual(service.metadata("/workspace/projects/repo/a.txt", "thread-a"), { isFile: true });
    assert.deepEqual(service.readDirectory("/workspace/projects/repo", "thread-a"), []);
    assert.deepEqual(service.readFile("/workspace/projects/repo/a.txt", "thread-a"), [104, 105]);
    service.writeFile({ path: "/workspace/projects/repo/a.txt" }, [98, 121, 101], "thread-a");
    assert.deepEqual(calls, [
      ["attach", "thread-a", "desktop-filesystem:thread-a", "/workspace"],
      ["metadata", "capability-1", "/workspace/projects/repo/a.txt"],
      ["readDirectory", "capability-1", "/workspace/projects/repo"],
      ["readFile", "capability-1", "/workspace/projects/repo/a.txt"],
      ["writeFile", "capability-1", "/workspace/projects/repo/a.txt", [98, 121, 101]],
    ]);
  } finally {
    globalThis.hostWorkspaces = previousWorkspaces;
  }
});

test("workspace v2 Codex process uses the principal attachment transport", () => {
  const previousWorkspaces = globalThis.hostWorkspaces;
  const previousProcess = globalThis.hostProcess;
  const calls = [];
  globalThis.hostWorkspaces = {
    enabled: true,
    root: () => ({ threadId: "management-root" }),
    startProcess(...args) { calls.push(["start", ...args]); },
    writeProcess(...args) { calls.push(["write", ...args]); },
    drainProcess() {
      return {
        stdoutBytes: Buffer.from('{"id":1,"result":{}}\npartial'),
        stderrBytes: Buffer.from("warning\n"),
        exited: false,
        exitCode: -1,
      };
    },
    closeProcess(...args) { calls.push(["close", ...args]); },
  };
  globalThis.hostProcess = new Proxy({}, {
    get() { throw new Error("host process provider must not be used"); },
  });
  const handle = {
    capabilityId: "codex-capability",
    detach(reason) { calls.push(["detach", reason]); },
  };
  try {
    const service = filesystemService({
      attach(params) {
        calls.push(["attach", params.threadId, params.engineId, params.principal.username]);
        return handle;
      },
    });
    const user = {
      id: "user:alice",
      username: "alice",
      homePath: "/data/hypernode/.runtime/users/alice-stable",
    };
    service.spawnAppServer("process-1", "/workspace/projects/repo", user, "thread-a");
    service.send("process-1", { id: 1, method: "initialize" });
    const drained = service.drain("process-1");
    service.kill("process-1");

    assert.deepEqual(drained.stdoutLines, ['{"id":1,"result":{}}']);
    assert.deepEqual(drained.stderrLines, ["warning"]);
    assert.equal(service.v2Processes.get("process-1"), undefined);
    assert.deepEqual(calls[0], ["attach", "thread-a", "codex:process-1", "alice"]);
    assert.equal(calls[1][0], "start");
    assert.equal(calls[1][1], "process-1");
    assert.equal(calls[1][2], "codex-capability");
    assert.deepEqual(calls[1][4], ["codex", "app-server", "--listen", "stdio://"]);
    assert.equal(
      calls[1][5].CODEX_SQLITE_HOME,
      "/run/hypernode-users/alice-stable/.codex/hypernode/workspace-sqlite/thread-a",
    );
    assert.equal(
      calls[1][5].CODEX_HOME,
      "/workspace/.codex",
    );
    assert.deepEqual(calls.slice(-3), [
      ["write", "process-1", '{"id":1,"method":"initialize"}\n'],
      ["close", "process-1"],
      ["detach", "processClosed"],
    ]);
  } finally {
    globalThis.hostWorkspaces = previousWorkspaces;
    globalThis.hostProcess = previousProcess;
  }
});

test("workspace SQLite state is isolated by durable view without moving account state", () => {
  const home = "/run/hypernode-users/alice-stable";
  assert.equal(
    workspaceSqliteHome(home, "01a05b80-a679-7443-bd47-a571a28759b2"),
    `${home}/.codex/hypernode/workspace-sqlite/01a05b80-a679-7443-bd47-a571a28759b2`,
  );
  assert.throws(() => workspaceSqliteHome(home, "../other-view"), /valid view id/);
});

test("workspace v2 maps the legacy main selector to the durable root thread", () => {
  const previous = globalThis.hostWorkspaces;
  globalThis.hostWorkspaces = { enabled: true, root: () => ({ threadId: "management-root" }) };
  try {
    const calls = [];
    const service = filesystemService({
      attach(params) {
        calls.push(params.threadId);
        return { capabilityId: "root-capability", detach() {} };
      },
    });
    assert.equal(service.attachmentFor("main").capabilityId, "root-capability");
    assert.deepEqual(calls, ["management-root"]);
  } finally {
    globalThis.hostWorkspaces = previous;
  }
});

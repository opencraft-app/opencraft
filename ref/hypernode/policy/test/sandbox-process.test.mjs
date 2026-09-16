import assert from "node:assert/strict";
import test from "node:test";

import {
  mockOutsideSandboxProbe,
  SandboxProcessService,
} from "../src/services/sandbox-process.js";

function harness() {
  const messages = [];
  const audits = [];
  const service = Object.create(SandboxProcessService.prototype);
  service.ctx = {
    appServer: { audit: (...args) => audits.push(args) },
    userDirectory: { find: () => ({ id: "alice", homePath: "/srv/users/alice" }) },
    workspaceFilesystem: {
	  v2: false,
      toVirtual: (path) => path.replace("/srv/workspace", "/workspace"),
      owns: (path) => path === "/workspace" || path.startsWith("/workspace/"),
      normalize: (path) => path,
      ownsControlPath: (path) => path === "/workspace/.codex" || path.startsWith("/workspace/.codex/"),
      controlPathForUser: (path) => path.replace("/workspace/.codex", "/localhost/.codex"),
      readFile: (path) => Uint8Array.from(Buffer.from(`workspace:${path}`, "utf8")),
	  execute: () => { throw new Error("unexpected workspace execution"); },
    },
    virtualFilesystem: {
      toVirtual: (path) => path.replace("/srv/users/alice", "/localhost"),
      owns: (path) => path === "/localhost" || path.startsWith("/localhost/"),
      normalize: (path) => path,
      readFile: (path) => Uint8Array.from(Buffer.from(`virtual:${path}`, "utf8")),
    },
  };
  const connection = {
    identity: { id: "alice" },
    socket: { send: (message) => messages.push(structuredClone(message)) },
  };
  return { service, connection, messages, audits };
}

test("known capability and Git probes have deterministic outside-sandbox results", () => {
  assert.deepEqual(mockOutsideSandboxProbe(["git", "--version"]), {
    exitCode: 0, stdout: "git version 2.43.0\n", stderr: "",
  });
  assert.equal(mockOutsideSandboxProbe(["bash", "-lc", "gh --version"]).exitCode, 127);
  assert.equal(mockOutsideSandboxProbe(["git", "rev-parse", "--git-dir"]).exitCode, 128);
  assert.equal(mockOutsideSandboxProbe(["git", "config", "--get", "core.fsmonitor"]).exitCode, 1);
  assert.equal(mockOutsideSandboxProbe(["bash", "-lc", "echo unsafe"]), null);
});

test("physical sandbox cwd is projected and forwarded", () => {
  const { service, connection, messages } = harness();
  const message = {
    id: "spawn",
    method: "process/spawn",
    params: { cwd: "/srv/workspace/@main/projects/repo", command: ["git", "status"], processHandle: "p" },
  };
  assert.equal(service.intercept(message, connection), false);
  assert.equal(message.params.cwd, "/workspace/@main/projects/repo");
  assert.deepEqual(messages, []);
});

test("Workspace v2 process probes execute through the attachment capability", () => {
  const { service, connection, messages, audits } = harness();
  service.ctx.workspaceFilesystem.v2 = true;
  service.ctx.workspaceFilesystem.attachmentFor = () => ({ capabilityId: "capability:main" });
  connection.connectionId = "connection-1";
  const calls = [];
  const drains = [
    { stdoutBytes: new Uint8Array(), stderrBytes: new Uint8Array(), exited: false },
    { stdoutBytes: Uint8Array.from(Buffer.from("true\n")), stderrBytes: new Uint8Array(), exited: true, exitCode: 0 },
  ];
  const previousHostWorkspaces = globalThis.hostWorkspaces;
  globalThis.hostWorkspaces = {
    startProcess: (...args) => calls.push(["start", ...args]),
    drainProcess: (...args) => { calls.push(["drain", ...args]); return drains.shift(); },
    closeProcess: (...args) => calls.push(["close", ...args]),
  };
  try {
    assert.equal(service.intercept({
      id: "spawn-v2",
      method: "process/spawn",
      params: {
        cwd: "/workspace/projects/repo",
        command: ["git", "rev-parse", "--is-inside-work-tree"],
        processHandle: "git-probe",
        streamStdoutStderr: true,
        timeoutMs: 2500,
      },
    }, connection), true);
    assert.deepEqual(messages, [{ id: "spawn-v2", result: {} }]);
    assert.deepEqual(calls[0].slice(0, 6), [
      "start", "appserver-process:connection-1:1", "capability:main", "/workspace/projects/repo",
      ["git", "rev-parse", "--is-inside-work-tree"], {},
    ]);
    service.intercept(null, connection);
    assert.equal(messages[1].method, "process/outputDelta");
    assert.equal(Buffer.from(messages[1].params.deltaBase64, "base64").toString("utf8"), "true\n");
    assert.equal(messages[2].method, "process/exited");
    assert.equal(messages[2].params.exitCode, 0);
    assert.ok(calls.some((entry) => entry[0] === "close"));
    assert.equal(audits[0][2].workspaceAttachmentProcess, true);
  } finally {
    globalThis.hostWorkspaces = previousHostWorkspaces;
  }
});

test("streamStdin without tty remains a non-PTY workspace process", () => {
  const { service, connection, messages } = harness();
  service.ctx.workspaceFilesystem.v2 = true;
  service.ctx.workspaceFilesystem.attachmentFor = () => ({ capabilityId: "capability:main" });
  const previousHostWorkspaces = globalThis.hostWorkspaces;
  globalThis.hostWorkspaces = {
    startProcess: () => {},
    drainProcess: () => ({ stdoutBytes: new Uint8Array(), stderrBytes: new Uint8Array(), exited: true, exitCode: 0 }),
    closeProcess: () => {},
  };
  try {
    assert.equal(service.intercept({
      id: "spawn-stream-stdin",
      method: "process/spawn",
      params: {
        cwd: "/workspace/projects/repo",
        command: ["git", "remote"],
        processHandle: "git-remote",
        streamStdin: true,
        streamStdoutStderr: true,
      },
    }, connection), true);
    assert.equal(messages[1].method, "process/exited");
    assert.equal(messages[1].params.exitCode, 0);
  } finally {
    globalThis.hostWorkspaces = previousHostWorkspaces;
  }
});

test("Workspace v2 Desktop terminal follows the native interactive process lifecycle", () => {
  const { service, connection, messages, audits } = harness();
  connection.connectionId = "connection-1";
  service.ctx.workspaceFilesystem.v2 = true;
  service.ctx.workspaceFilesystem.attachmentFor = (viewId) => ({
    capabilityId: `capability:${viewId}`,
  });
  const calls = [];
  const drains = [
    { outputBytes: Uint8Array.from(Buffer.from("prompt$ ")), exited: false },
    { outputBytes: Uint8Array.from(Buffer.from("hello\r\n")), exited: false },
    { outputBytes: new Uint8Array(), exited: true, exitCode: 0 },
  ];
  const previousHostWorkspaces = globalThis.hostWorkspaces;
  globalThis.hostWorkspaces = {
    openTerminal: (...args) => calls.push(["open", ...args]),
    writeTerminal: (...args) => calls.push(["write", args[0], Buffer.from(args[1]).toString("utf8")]),
    resizeTerminal: (...args) => calls.push(["resize", ...args]),
    drainTerminal: (...args) => {
      calls.push(["drain", ...args]);
      return drains.shift();
    },
    closeTerminal: (...args) => calls.push(["close", ...args]),
  };
  try {
    assert.equal(service.intercept({
      id: "spawn-terminal",
      method: "process/spawn",
      params: {
        cwd: "/workspace/projects",
        command: ["sh", "-c", "exec /bin/bash -il"],
        processHandle: "terminal-1",
        tty: true,
        streamStdin: true,
        streamStdoutStderr: true,
        size: { cols: 120, rows: 40 },
      },
    }, connection), true);
    assert.deepEqual(calls[0].slice(0, 4), [
      "open", "appserver-terminal:connection-1:1", "capability:main", 120,
    ]);
    assert.equal(calls[0][4], 40);
    assert.equal(calls[1][0], "write");
    assert.match(calls[1][2], /^exec 'sh' '-c' 'exec \/bin\/bash -il'\r$/);
    assert.deepEqual(messages[0], { id: "spawn-terminal", result: {} });
    assert.equal(messages[1].method, "process/outputDelta");
    assert.equal(Buffer.from(messages[1].params.deltaBase64, "base64").toString(), "prompt$ ");

    assert.equal(service.intercept({
      id: "resize-terminal",
      method: "process/resizePty",
      params: { processHandle: "terminal-1", size: { cols: 90, rows: 30 } },
    }, connection), true);
    assert.deepEqual(calls.find((entry) => entry[0] === "resize").slice(2), [90, 30]);

    assert.equal(service.intercept({
      id: "stdin-terminal",
      method: "process/writeStdin",
      params: {
        processHandle: "terminal-1",
        deltaBase64: Buffer.from("echo hello\r").toString("base64"),
      },
    }, connection), true);
    assert.ok(calls.some((entry) => entry[0] === "write" && entry[2] === "echo hello\r"));
    assert.ok(messages.some((entry) => entry.method === "process/outputDelta" &&
      Buffer.from(entry.params.deltaBase64, "base64").toString() === "hello\r\n"));

    service.intercept(null, connection);
    assert.ok(messages.some((entry) => entry.method === "process/exited" &&
      entry.params.processHandle === "terminal-1" && entry.params.exitCode === 0));
    assert.ok(calls.some((entry) => entry[0] === "close"));
    assert.equal(audits[0][2].workspaceAttachmentTerminal, true);
  } finally {
    globalThis.hostWorkspaces = previousHostWorkspaces;
  }
});

test("Desktop cat preview reads a workspace file even when cwd is root", () => {
  const { service, connection, messages, audits } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: {
      cwd: "/",
      command: ["cat", "/workspace/@main/projects/repo/README.md"],
      processHandle: "preview",
      outputBytesCap: 4096,
      streamStdoutStderr: false,
    },
  }, connection), true);
  assert.deepEqual(messages[0], { id: "spawn", result: {} });
  assert.equal(messages[1].method, "process/exited");
  assert.equal(messages[1].params.processHandle, "preview");
  assert.equal(messages[1].params.exitCode, 0);
  assert.equal(messages[1].params.stdout, "workspace:/workspace/@main/projects/repo/README.md");
  assert.equal(audits[0][2].sandboxFileRead, true);
});

test("Desktop cat preview honors outputBytesCap", () => {
  const { service, connection, messages } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: {
      cwd: "/",
      command: ["/bin/cat", "/workspace/@main/projects/repo/README.md"],
      processHandle: "preview",
      outputBytesCap: 9,
      streamStdoutStderr: true,
    },
  }, connection), true);
  assert.equal(messages[1].method, "process/outputDelta");
  assert.equal(Buffer.from(messages[1].params.deltaBase64, "base64").toString("utf8"), "workspace");
  assert.equal(messages[1].params.capReached, true);
  assert.equal(messages[2].params.stdoutCapReached, true);
});

test("Desktop cat treats a null outputBytesCap as unlimited", () => {
  const { service, connection, messages } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: {
      cwd: "/",
      command: ["cat", "/workspace/@main/projects/repo/README.md"],
      processHandle: "uncapped-preview",
      outputBytesCap: null,
      streamStdoutStderr: true,
    },
  }, connection), true);
  assert.equal(messages[1].method, "process/outputDelta");
  assert.equal(
    Buffer.from(messages[1].params.deltaBase64, "base64").toString("utf8"),
    "workspace:/workspace/@main/projects/repo/README.md",
  );
  assert.equal(messages[1].params.capReached, false);
  assert.equal(messages[2].method, "process/exited");
  assert.equal(messages[2].params.stdoutCapReached, false);
});

test("Desktop cat treats /workspace/.codex visualizations as a virtual user control path", () => {
  const { service, connection, messages } = harness();
  const publicPath = "/workspace/.codex/visualizations/2026/08/25/thread/hello-world.html";
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: {
      cwd: "/",
      command: ["cat", publicPath],
      processHandle: "visualization-preview",
      outputBytesCap: 4096,
      streamStdoutStderr: true,
    },
  }, connection), true);
  assert.deepEqual(messages[0], { id: "spawn", result: {} });
  assert.equal(messages[1].method, "process/outputDelta");
  assert.equal(messages[1].params.processHandle, "visualization-preview");
  assert.equal(
    Buffer.from(messages[1].params.deltaBase64, "base64").toString("utf8"),
    "virtual:/localhost/.codex/visualizations/2026/08/25/thread/hello-world.html",
  );
  assert.equal(messages[2].method, "process/exited");
  assert.equal(messages[2].params.processHandle, "visualization-preview");
  assert.equal(messages[2].params.exitCode, 0);
  assert.equal(messages[2].params.stdout, "");
});

test("cat outside a governed filesystem remains rejected", () => {
  const { service, connection, messages } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: { cwd: "/", command: ["cat", "/etc/passwd"], processHandle: "preview" },
  }, connection), true);
  assert.equal(messages[0].error.code, -32067);
});

test("Desktop temporary artifact reads continue to the active Thread backend", () => {
  const { service, connection, messages } = harness();
  connection.activeThreadId = "thread-1";
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: { cwd: "/", command: ["cat", "/tmp/cumora.png"], processHandle: "preview" },
  }, connection), false);
  assert.deepEqual(messages, []);
});

test("outside Git probes complete the official process lifecycle", () => {
  const { service, connection, messages, audits } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: {
      cwd: "/data/hypernode",
      command: ["git", "rev-parse", "--git-dir"],
      processHandle: "probe",
      streamStdoutStderr: true,
    },
  }, connection), true);
  assert.deepEqual(messages[0], { id: "spawn", result: {} });
  assert.equal(messages[1].method, "process/outputDelta");
  assert.equal(messages[1].params.processHandle, "probe");
  assert.equal(messages[2].method, "process/exited");
  assert.equal(messages[2].params.exitCode, 128);
  assert.equal(audits.length, 1);
});

test("arbitrary outside-sandbox processes are rejected", () => {
  const { service, connection, messages } = harness();
  assert.equal(service.intercept({
    id: "spawn",
    method: "process/spawn",
    params: { cwd: "/", command: ["bash", "-lc", "echo unsafe"], processHandle: "probe" },
  }, connection), true);
  assert.equal(messages[0].error.code, -32067);
  assert.equal(messages[0].error.data.kind, "sandboxBoundaryViolation");
});

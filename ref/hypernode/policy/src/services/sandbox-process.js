import { Service } from "@deepseek-ai/cordis";
import { isBackendLocalArtifactRead } from "./backend-local-process.ts";

function base64FromText(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function textFromBytes(bytes) {
  if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
  return Buffer.from(bytes).toString("utf8");
}

function executableName(command) {
  return String(command?.[0] ?? "").split("/").at(-1);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function mockOutsideSandboxProbe(command) {
  if (!Array.isArray(command) || command.length === 0) return null;
  const executable = executableName(command);
  const invocation = command.map(String).join(" ");
  const script = command.slice(1).map(String).join(" ");

  if ((executable === "gh" || /\bgh\s+--version\b/.test(script)) && /--version\b/.test(invocation)) {
    return { exitCode: 127, stdout: "", stderr: "gh: command not found\n" };
  }
  if ((executable === "git" || /\bgit\b/.test(script)) && /--version\b/.test(invocation)) {
    return { exitCode: 0, stdout: "git version 2.43.0\n", stderr: "" };
  }
  if (executable !== "git") return null;

  // Desktop probes stale repository roots with a small, fixed family of Git
  // reads.  Report the external path as a non-repository without ever touching
  // the HyperNode host filesystem.
  if (command.includes("config")) return { exitCode: 1, stdout: "", stderr: "" };
  return {
    exitCode: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any parent up to mount point /)\n",
  };
}

export class SandboxProcessService extends Service {
  constructor(ctx) {
    super(ctx, "sandboxProcess");
    this.ctx = ctx;
    this.interactiveProcesses = new Map();
  this.backgroundProcesses = new Map();
    this.interactiveSequence = 0;
    ctx.effect(() => ctx.appServer.intercept((message, connection) => this.intercept(message, connection)));
    ctx.effect(() => ctx.appServer.onClose((connection) => this.closeProcesses(connection)));
  }

  interactiveFor(connection, create = false) {
    if (!this.interactiveProcesses) this.interactiveProcesses = new Map();
    let processes = this.interactiveProcesses.get(connection);
    if (!processes && create) {
      processes = new Map();
      this.interactiveProcesses.set(connection, processes);
    }
    return processes;
  }

  backgroundFor(connection, create = false) {
  if (!this.backgroundProcesses) this.backgroundProcesses = new Map();
  let processes = this.backgroundProcesses.get(connection);
  if (!processes && create) {
    processes = new Map();
    this.backgroundProcesses.set(connection, processes);
  }
  return processes;
  }

  send(connection, message) {
    if (typeof this.ctx.appServer.send === "function") this.ctx.appServer.send(connection, message);
    else connection.socket.send(message);
  }

  sendInteractiveError(connection, id, message, kind = "workspaceInteractiveProcessError") {
    this.send(connection, { id, error: { code: -32068, message, data: { kind } } });
  }

  startWorkspaceInteractiveProcess(requestId, params, connection) {
    const processes = this.interactiveFor(connection, true);
    if (processes.has(params.processHandle)) {
      this.sendInteractiveError(
        connection, requestId, `processHandle is already active: ${params.processHandle}`,
        "duplicateProcessHandle",
      );
      return true;
    }
    const viewId = this.viewFor(connection);
    let terminalId;
    try {
      if (!Number.isFinite(this.interactiveSequence)) this.interactiveSequence = 0;
      const workspace = this.ctx.workspaceFilesystem.attachmentFor(viewId);
      const size = params.size ?? {};
      terminalId = `appserver-terminal:${connection.connectionId ?? connection.sessionId ?? "local"}:${++this.interactiveSequence}`;
      globalThis.hostWorkspaces.openTerminal(
        terminalId,
        workspace.capabilityId,
        Number(size.cols) || 80,
        Number(size.rows) || 24,
      );
      processes.set(params.processHandle, {
        connection,
        processHandle: params.processHandle,
        terminalId,
        exited: false,
      });

      // The attachment primitive opens a real PTY shell. Desktop's terminal
      // spawn asks that shell to exec the selected login shell; preserve the
      // argv boundary instead of flattening it without quoting.
      if (Array.isArray(params.command) && params.command.length > 0) {
        const command = `exec ${params.command.map(shellQuote).join(" ")}\r`;
        globalThis.hostWorkspaces.writeTerminal(terminalId, Uint8Array.from(Buffer.from(command, "utf8")));
      }

      this.send(connection, { id: requestId, result: {} });
      this.ctx.appServer.audit(connection, "rpc.response", {
        id: requestId,
        method: "process/spawn",
        resultKeys: [],
        workspaceAttachmentTerminal: true,
      });
      this.drainInteractiveProcess(processes.get(params.processHandle));
    } catch (error) {
      if (terminalId) globalThis.hostWorkspaces.closeTerminal(terminalId);
      processes.delete(params.processHandle);
      this.sendInteractiveError(connection, requestId, error?.message ?? String(error));
    }
    return true;
  }

  finishInteractiveProcess(process, exitCode = 0, error = "") {
    if (!process || process.exited) return;
    process.exited = true;
    const processes = this.interactiveFor(process.connection);
    processes?.delete(process.processHandle);
    if (processes?.size === 0) this.interactiveProcesses.delete(process.connection);
    globalThis.hostWorkspaces.closeTerminal(process.terminalId);
    if (error) this.send(process.connection, {
      method: "process/outputDelta",
      params: {
        processHandle: process.processHandle,
        stream: "stderr",
        deltaBase64: base64FromText(`${error}\n`),
        capReached: false,
      },
    });
    this.send(process.connection, {
      method: "process/exited",
      params: {
        processHandle: process.processHandle,
        exitCode,
        stdout: "",
        stderr: "",
        stdoutCapReached: false,
        stderrCapReached: false,
      },
    });
  }

  drainInteractiveProcess(process) {
    if (!process || process.exited) return;
    try {
      const result = globalThis.hostWorkspaces.drainTerminal(process.terminalId);
      const output = Uint8Array.from(result.outputBytes ?? []);
      if (output.length > 0) this.send(process.connection, {
        method: "process/outputDelta",
        params: {
          processHandle: process.processHandle,
          stream: "stdout",
          deltaBase64: base64FromBytes(output),
          capReached: false,
        },
      });
      if (result.exited === true) {
        this.finishInteractiveProcess(process, Number(result.exitCode ?? 0), result.error ?? "");
      }
    } catch (error) {
      this.finishInteractiveProcess(process, 127, error?.message ?? String(error));
    }
  }

  pollInteractiveProcesses(connection) {
    const processes = this.interactiveFor(connection);
    if (!processes) return;
    for (const process of [...processes.values()]) this.drainInteractiveProcess(process);
  }

  finishBackgroundProcess(process, result) {
  if (!process || process.exited) return;
  process.exited = true;
  const processes = this.backgroundFor(process.connection);
  processes?.delete(process.processHandle);
  if (processes?.size === 0) this.backgroundProcesses.delete(process.connection);
  globalThis.hostWorkspaces.closeProcess(process.processId);
  this.send(process.connection, {
    method: "process/exited",
    params: {
    processHandle: process.processHandle,
    exitCode: Number(result.exitCode ?? 0),
    stdout: "",
    stderr: "",
    stdoutCapReached: result.stdoutCapReached === true,
    stderrCapReached: result.stderrCapReached === true,
    },
  });
  }

  drainBackgroundProcess(process) {
  if (!process || process.exited) return;
  try {
    const result = globalThis.hostWorkspaces.drainProcess(process.processId);
    const stdout = Uint8Array.from(result.stdoutBytes ?? []);
    const stderr = Uint8Array.from(result.stderrBytes ?? []);
    if (stdout.length > 0) this.send(process.connection, {
    method: "process/outputDelta",
    params: {
      processHandle: process.processHandle, stream: "stdout",
      deltaBase64: base64FromBytes(stdout), capReached: result.stdoutCapReached === true,
    },
    });
    if (stderr.length > 0 || (result.exited === true && result.error)) this.send(process.connection, {
    method: "process/outputDelta",
    params: {
      processHandle: process.processHandle, stream: "stderr",
      deltaBase64: stderr.length > 0 ? base64FromBytes(stderr) : base64FromText(`${result.error}\n`),
      capReached: result.stderrCapReached === true,
    },
    });
    if (result.exited === true) this.finishBackgroundProcess(process, result);
  } catch (error) {
    this.send(process.connection, {
    method: "process/outputDelta",
    params: {
      processHandle: process.processHandle, stream: "stderr",
      deltaBase64: base64FromText(`${error?.message ?? error}\n`), capReached: false,
    },
    });
    this.finishBackgroundProcess(process, { exitCode: 127 });
  }
  }

  pollBackgroundProcesses(connection) {
  const processes = this.backgroundFor(connection);
  if (!processes) return;
  for (const process of [...processes.values()]) this.drainBackgroundProcess(process);
  }

  closeInteractiveProcesses(connection) {
    const processes = this.interactiveFor(connection);
    if (!processes) return;
    this.interactiveProcesses.delete(connection);
    for (const process of processes.values()) {
      process.exited = true;
      globalThis.hostWorkspaces.closeTerminal(process.terminalId);
    }
  }

  closeProcesses(connection) {
  this.closeInteractiveProcesses(connection);
  const processes = this.backgroundFor(connection);
  if (!processes) return;
  this.backgroundProcesses.delete(connection);
  for (const process of processes.values()) {
    process.exited = true;
    globalThis.hostWorkspaces.closeProcess(process.processId);
  }
  }

  interceptInteractiveControl(message, connection) {
    const params = message.params ?? {};
    const process = this.interactiveFor(connection)?.get(params.processHandle);
    if (!process) return false;
    try {
      if (message.method === "process/writeStdin") {
        if (typeof params.deltaBase64 === "string" && params.deltaBase64.length > 0) {
          globalThis.hostWorkspaces.writeTerminal(
            process.terminalId,
            Uint8Array.from(Buffer.from(params.deltaBase64, "base64")),
          );
        }
        this.send(connection, { id: message.id, result: {} });
        if (params.closeStdin === true) this.finishInteractiveProcess(process, 0);
        else this.drainInteractiveProcess(process);
      } else if (message.method === "process/resizePty") {
        const size = params.size ?? {};
        globalThis.hostWorkspaces.resizeTerminal(
          process.terminalId, Number(size.cols) || 80, Number(size.rows) || 24,
        );
        this.send(connection, { id: message.id, result: {} });
      } else if (message.method === "process/kill") {
        this.send(connection, { id: message.id, result: {} });
        this.finishInteractiveProcess(process, 137);
      }
    } catch (error) {
      this.sendInteractiveError(connection, message.id, error?.message ?? String(error));
    }
    return true;
  }

  userFor(connection) {
    return connection.identity?.id ? this.ctx.userDirectory.find(connection.identity.id) : null;
  }

  viewFor(connection) {
    return typeof connection.activeThreadId === "string"
      ? this.ctx.workspaceView.viewIdForThread(connection.activeThreadId)
      : "main";
  }

  projectCwd(cwd, connection) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
    const user = this.userFor(connection);
    let projected = this.ctx.workspaceFilesystem.toVirtual(cwd, user, this.viewFor(connection));
    projected = this.ctx.virtualFilesystem.toVirtual(projected, user);
    if (this.ctx.workspaceFilesystem.ownsControlPath(projected) ||
        this.ctx.workspaceFilesystem.owns(projected) ||
        this.ctx.virtualFilesystem.owns(projected)) {
      return projected;
    }
    return null;
  }

  projectFile(path, connection) {
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    const user = this.userFor(connection);
    try {
      const viewId = this.viewFor(connection);
      let projected = this.ctx.workspaceFilesystem.toVirtual(path, user, viewId);
      projected = this.ctx.virtualFilesystem.toVirtual(projected, user);
      if (this.ctx.workspaceFilesystem.ownsControlPath(projected) ||
          this.ctx.workspaceFilesystem.owns(projected)) {
        return {
          path: this.ctx.workspaceFilesystem.normalize(projected), filesystem: "workspace", user, viewId,
        };
      }
      if (this.ctx.virtualFilesystem.owns(projected)) {
        return { path: this.ctx.virtualFilesystem.normalize(projected), filesystem: "virtual", user };
      }
    } catch {
      return null;
    }
    return null;
  }

  readFile(projected) {
    if (projected.filesystem === "workspace") {
      if (this.ctx.workspaceFilesystem.ownsControlPath(projected.path)) {
        return this.ctx.virtualFilesystem.readFile(
          this.ctx.workspaceFilesystem.controlPathForUser(projected.path),
          projected.user,
        );
      }
      return this.ctx.workspaceFilesystem.readFile(projected.path, projected.viewId);
    }
    return this.ctx.virtualFilesystem.readFile(projected.path, projected.user);
  }

  sandboxFileRead(params, connection) {
    const command = params.command;
    if (!Array.isArray(command) || command.length !== 2 || executableName(command) !== "cat") return null;
    const projected = this.projectFile(command[1], connection);
    if (!projected) return null;
    try {
      const source = Uint8Array.from(this.readFile(projected));
      // Desktop includes `outputBytesCap` in the process request even when the
      // caller did not set a cap.  Across the Electron -> JSON-RPC boundary
      // that value arrives as null.  Native app-server treats null as
      // unlimited; Number(null) is 0 and would silently turn every remote
      // visualization read into an empty fragment.
      const requestedCap = params.outputBytesCap == null
        ? null
        : Number(params.outputBytesCap);
      const cap = requestedCap != null && Number.isFinite(requestedCap) && requestedCap >= 0
        ? Math.floor(requestedCap)
        : source.length;
      const stdoutBytes = source.length > cap ? source.slice(0, cap) : source;
      return {
        projected,
        result: {
          exitCode: 0,
          stdout: textFromBytes(stdoutBytes),
          stdoutBytes,
          stdoutCapReached: source.length > cap,
          stderr: "",
          stderrCapReached: false,
        },
      };
    } catch (error) {
      return {
        projected,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: `cat: ${projected.path}: ${error?.message ?? error}\n`,
          stdoutCapReached: false,
          stderrCapReached: false,
        },
      };
    }
  }

  sendExited(connection, params, result) {
    const streamed = params.tty === true || params.streamStdoutStderr === true;
    if (streamed && result.stdout) connection.socket.send({
      method: "process/outputDelta",
      params: {
        processHandle: params.processHandle,
        stream: "stdout",
        deltaBase64: result.stdoutBytes ? base64FromBytes(result.stdoutBytes) : base64FromText(result.stdout),
        capReached: result.stdoutCapReached === true,
      },
    });
    if (streamed && result.stderr) connection.socket.send({
      method: "process/outputDelta",
      params: {
        processHandle: params.processHandle,
        stream: "stderr",
        deltaBase64: base64FromText(result.stderr),
        capReached: result.stderrCapReached === true,
      },
    });
    connection.socket.send({
      method: "process/exited",
      params: {
        processHandle: params.processHandle,
        exitCode: result.exitCode,
        stdout: streamed ? "" : result.stdout,
        stdoutCapReached: result.stdoutCapReached === true,
        stderr: streamed ? "" : result.stderr,
        stderrCapReached: result.stderrCapReached === true,
      },
    });
  }

  executeWorkspaceProcess(requestId, params, connection, cwd) {
    if (!this.ctx.workspaceFilesystem.v2) return false;
    if (params.tty === true) {
      return this.startWorkspaceInteractiveProcess(requestId, { ...params, cwd }, connection);
    }
  const processes = this.backgroundFor(connection, true);
  if (processes.has(params.processHandle)) {
    this.sendInteractiveError(
    connection, requestId, `processHandle is already active: ${params.processHandle}`,
    "duplicateProcessHandle",
    );
    return true;
  }
  if (!Number.isFinite(this.backgroundSequence)) this.backgroundSequence = 0;
  const viewId = this.viewFor(connection);
  const workspace = this.ctx.workspaceFilesystem.attachmentFor(viewId);
  const processId = `appserver-process:${connection.connectionId ?? connection.sessionId ?? "local"}:${++this.backgroundSequence}`;
  try {
    globalThis.hostWorkspaces.startProcess(
    processId,
    workspace.capabilityId,
    cwd,
    Array.isArray(params.command) ? params.command : [],
    params.env ?? {},
    Number(params.timeoutMs) || 0,
    params.timeoutMs === null,
    Number(params.outputBytesCap) || 0,
    params.outputBytesCap === null,
    );
  } catch (error) {
    this.sendInteractiveError(connection, requestId, error?.message ?? String(error), "workspaceProcessStartError");
    return true;
  }
  const process = { connection, processHandle: params.processHandle, processId, exited: false };
  processes.set(params.processHandle, process);
  connection.socket.send({ id: requestId, result: {} });
    this.ctx.appServer.audit(connection, "rpc.response", {
      id: requestId,
      method: "process/spawn",
      resultKeys: [],
      workspaceAttachmentProcess: true,
    });
  this.drainBackgroundProcess(process);
    return true;
  }

  intercept(message, connection) {
    if (message == null) {
      this.pollInteractiveProcesses(connection);
    this.pollBackgroundProcesses(connection);
      return false;
    }
    if (["process/writeStdin", "process/resizePty", "process/kill"].includes(message.method) &&
    message.id !== undefined) {
    if (this.interceptInteractiveControl(message, connection)) return true;
    const process = this.backgroundFor(connection)?.get(message.params?.processHandle);
    if (process) {
    if (message.method === "process/kill") {
      globalThis.hostWorkspaces.closeProcess(process.processId);
      this.send(connection, { id: message.id, result: {} });
      this.finishBackgroundProcess(process, { exitCode: 137 });
    } else {
      // The native Desktop sometimes marks read-only probes streamStdin even
      // though it never writes. Preserve the request lifecycle deterministically.
      this.send(connection, { id: message.id, result: {} });
      this.drainBackgroundProcess(process);
    }
    return true;
    }
    }
    if (message?.method !== "process/spawn" || message.id === undefined) return false;
    const params = message.params ?? {};
    if (typeof params.processHandle !== "string" || params.processHandle.length === 0) {
      connection.socket.send({
        id: message.id,
        error: { code: -32602, message: "processHandle must not be empty" },
      });
      return true;
    }

    const fileRead = this.sandboxFileRead(params, connection);
    if (fileRead) {
      connection.socket.send({ id: message.id, result: {} });
      this.ctx.appServer.audit(connection, "rpc.response", {
        id: message.id,
        method: message.method,
        resultKeys: [],
        sandboxFileRead: true,
      });
      this.sendExited(connection, params, fileRead.result);
      console.info(
        `[sandbox-process] file read path=${fileRead.projected.path} exitCode=${fileRead.result.exitCode}`,
      );
      return true;
    }

    // /tmp artifacts live inside the active per-Thread Codex container. The
    // transparent runtime owns that namespace and must complete the native
    // process/spawn -> outputDelta -> exited lifecycle. Check this before cwd
    // projection because Desktop intentionally uses cwd=/ for preview reads.
    if (connection.activeThreadId && isBackendLocalArtifactRead(message)) return false;

    const projectedCwd = this.projectCwd(params.cwd, connection);
    if (projectedCwd) {
      if (this.ctx.workspaceFilesystem.v2) {
        return this.executeWorkspaceProcess(message.id, params, connection, projectedCwd);
      }
      if (projectedCwd !== params.cwd) message.params = { ...params, cwd: projectedCwd };
      return false;
    }

    const result = mockOutsideSandboxProbe(params.command);
    if (!result) {
      connection.socket.send({
        id: message.id,
        error: {
          code: -32067,
          message: `process cwd is outside the HyperNode sandbox: ${params.cwd}`,
          data: { kind: "sandboxBoundaryViolation", cwd: params.cwd },
        },
      });
      return true;
    }

    connection.socket.send({ id: message.id, result: {} });
    this.ctx.appServer.audit(connection, "rpc.response", {
      id: message.id,
      method: message.method,
      resultKeys: [],
      sandboxProbe: true,
    });
    this.sendExited(connection, params, result);
    console.info(
      `[sandbox-process] mocked cwd=${params.cwd} command=${JSON.stringify(params.command)} exitCode=${result.exitCode}`,
    );
    return true;
  }
}

SandboxProcessService.inject = [
  "appServer", "userDirectory", "virtualFilesystem", "workspaceFilesystem", "workspaceView",
];

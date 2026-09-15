import { Context, Service } from "@deepseek-ai/cordis";
import { VSSHService } from "./services/vssh.js";
import { installWebCrypto, drainWebCrypto } from "./runtime/web-crypto.ts";

installWebCrypto();

class AgentStorageService extends Service {
  constructor(ctx) {
    super(ctx, "storage");
    this.available = false;
    this.sql = { exec() { return { toArray: () => [], one: () => ({}) }; } };
  }
}

class AgentUserDirectoryService extends Service {
  constructor(ctx) {
    super(ctx, "userDirectory");
    this.identities = new Map();
  }

  allowNoneAuth(context) {
    this.identities.set(context.connectionId, {
      id: `workspace-agent:${String(context.username || "root")}`,
      username: String(context.username || "root"),
      authentication: "none",
    });
    return true;
  }

  acceptsPublicKey() { return false; }
  authenticatePublicKey() { return false; }
  identityForConnection(connectionId) { return this.identities.get(connectionId) ?? null; }
}

class AgentPortForwardService extends Service {
  constructor(ctx) { super(ctx, "portForward"); }
  open() { throw new Error("workspace agent port forwarding is not enabled"); }
  write() {}
  closeWrite() {}
  drain() { return { dataBytes: new Uint8Array(), closed: true, error: null }; }
  close() {}
}

const ctx = new Context();
const streams = new Map();
const pendingTerminals = new Map();
let sequence = 0;
const WORKSPACE_STDIO_FAST_COMMAND = "@hypernode workspace-stdio hypernode-fs@v1";

function processDecision(processId) {
  const result = hostProcess.drain(processId);
  const stdout = (result.stdoutLines ?? []).map((line) => `${line}\n`).join("");
  const stderr = (result.stderrLines ?? []).map((line) => `${line}\n`).join("");
  return {
    allow: true,
    stdout,
    stderr: result.error ? `${stderr}${result.error}\n` : stderr,
    exitCode: result.exitCode ?? 0,
    done: result.exited === true,
  };
}

const boot = (async () => {
  await ctx.plugin(AgentStorageService);
  await ctx.plugin(AgentUserDirectoryService);
  await ctx.plugin(AgentPortForwardService);
  await ctx.plugin(VSSHService);
})();

globalThis.hypernodeBootPromise = boot;
globalThis.policy = {
  authenticate: () => ({ allow: false }),
  authenticateNone: () => ({ allow: true }),
  authenticatePublicKey: () => ({ allow: false }),
  onExec(context) {
    if (String(context.command ?? "") === WORKSPACE_STDIO_FAST_COMMAND) {
      hostFilesystem.openWorkspaceStdio(context.sessionId);
      streams.set(context.sessionId, { kind: "workspace-stdio" });
      return { allow: true, stream: "workspace-stdio", stdout: "", stderr: "", exitCode: 0 };
    }
    const processId = `workspace-agent:${++sequence}`;
    hostProcess.spawnShell(processId, ".", String(context.command ?? ""), context.env ?? {});
    streams.set(context.sessionId, { kind: "process", processId });
    return { allow: true, stream: "workspace-exec", stdout: "", stderr: "", exitCode: 0 };
  },
  onRequest(context) {
	if (context.request === "pty-req") {
	  pendingTerminals.set(context.sessionId, {
		cols: context.cols || 80,
		rows: context.rows || 24,
	  });
	  return { allow: true, stdout: "", stderr: "", exitCode: 0 };
	}
	if (context.request === "shell") {
	  const dimensions = pendingTerminals.get(context.sessionId) ?? { cols: 80, rows: 24 };
	  const terminalId = `workspace-terminal:${String(context.sessionId)}`;
	  const attached = hostTerminal.spawnInWorkspace(
		terminalId, "/workspace/projects", dimensions.cols, dimensions.rows,
	  );
	  streams.set(context.sessionId, { kind: "terminal", terminalId });
	  return {
		allow: true,
		stream: "workspace-terminal",
		stdout: "",
		stderr: "",
		exitCode: 0,
		cwd: attached.cwd,
		shell: attached.shell,
	  };
	}
	if (context.request === "window-change") {
	  const stream = streams.get(context.sessionId);
	  if (stream?.kind === "terminal") {
		hostTerminal.resize(stream.terminalId, context.cols || 80, context.rows || 24);
	  } else {
		pendingTerminals.set(context.sessionId, { cols: context.cols || 80, rows: context.rows || 24 });
	  }
	  return { allow: true, stdout: "", stderr: "", exitCode: 0 };
	}
	return { allow: ["env", "signal", "break"].includes(context.request), stdout: "", stderr: "", exitCode: 0 };
  },
  onStreamData(context) {
    const stream = streams.get(context.sessionId);
    if (!stream) return { allow: false, stderr: "unknown workspace stream\n", exitCode: 125, done: true };
	if (stream.kind === "workspace-stdio") {
      hostFilesystem.writeWorkspaceStdio(context.sessionId, Array.from(context.dataBytes ?? new Uint8Array()));
      const result = hostFilesystem.drainWorkspaceStdio(context.sessionId);
      return {
        allow: true,
        stdoutBytes: result.dataBytes ?? [],
        stderr: result.error ? `${result.error}\n` : "",
        exitCode: result.error ? 1 : 0,
        done: result.done === true,
      };
	}
	if (stream.kind === "terminal") {
	  hostTerminal.write(stream.terminalId, context.dataBytes ?? new Uint8Array());
	  const result = hostTerminal.drain(stream.terminalId);
	  return {
		allow: true,
		stdoutBytes: result.outputBytes ?? [],
		stderr: result.error ? `${result.error}\n` : "",
		exitCode: result.exitCode ?? 0,
		done: result.exited === true,
	  };
	}
    hostProcess.write(stream.processId, new TextDecoder().decode(context.dataBytes ?? new Uint8Array()));
    return processDecision(stream.processId);
  },
  onStreamPoll(context) {
    const stream = streams.get(context.sessionId);
    if (!stream) return { allow: true, stdout: "", stderr: "", exitCode: 0, done: true };
	if (stream.kind === "workspace-stdio") {
      const result = hostFilesystem.drainWorkspaceStdio(context.sessionId);
      const decision = {
        allow: true,
        stdoutBytes: result.dataBytes ?? [],
        stderr: result.error ? `${result.error}\n` : "",
        exitCode: result.error ? 1 : 0,
        done: result.done === true,
      };
      if (decision.done) {
        streams.delete(context.sessionId);
        hostFilesystem.closeWorkspaceStdio(context.sessionId);
      }
	  return decision;
	}
	if (stream.kind === "terminal") {
	  const result = hostTerminal.drain(stream.terminalId);
	  const decision = {
		allow: true,
		stdoutBytes: result.outputBytes ?? [],
		stderr: result.error ? `${result.error}\n` : "",
		exitCode: result.exitCode ?? 0,
		done: result.exited === true,
	  };
	  if (decision.done) {
		streams.delete(context.sessionId);
		pendingTerminals.delete(context.sessionId);
		hostTerminal.kill(stream.terminalId);
	  }
	  return decision;
	}
    const decision = processDecision(stream.processId);
    if (decision.done) {
      streams.delete(context.sessionId);
      hostProcess.kill(stream.processId);
    }
    return decision;
  },
  onStreamClose(context) {
	const stream = streams.get(context.sessionId);
	streams.delete(context.sessionId);
	pendingTerminals.delete(context.sessionId);
	if (stream?.kind === "workspace-stdio") hostFilesystem.closeWorkspaceStdio(context.sessionId);
	else if (stream?.kind === "terminal") hostTerminal.kill(stream.terminalId);
	else if (stream?.processId) hostProcess.terminate(stream.processId, 1000);
    return { allow: true };
  },
  onTCPOpen(context) { return ctx.vssh.open(context); },
  onTCPData(context) { return ctx.vssh.data(context); },
  onTCPPoll(context) { return ctx.vssh.poll(context); },
  onTCPClose(context) { return ctx.vssh.close(context); },
  onTick() {
    drainWebCrypto();
    for (const connection of ctx.vssh.connections.values()) connection.poll();
  },
};

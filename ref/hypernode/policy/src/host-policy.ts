import type { HypernodeContext } from "./types/context.ts";
import type {
  AppServerHostStream,
  HostDecision,
  HostPolicy,
  HostSessionContext,
  HostStream,
} from "./types/host-policy.ts";
import { POLICY_CONFIG } from "./config.ts";
import { drainWebCrypto } from "./runtime/web-crypto.ts";
import { webSocketVServer } from "./services/direct-websocket-transport.ts";
import { executableFromCommandVProbe } from "./services/shell-executable-probe.ts";

type HostContext = HypernodeContext<
  | "appServer"
  | "httpIngress"
  | "outboundTcp"
  | "remoteControl"
  | "sshInteractiveTerminal"
  | "textDeltaPacer"
  | "threadSearch"
  | "userDirectory"
>;

interface HostPolicyOptions {
  ensureServices(): void;
}

interface HostPolicyState {
  authentications: number;
  commands: number;
  appServerBooted: boolean;
  streams: Map<string, HostStream>;
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function notifyHostOutput(): void {
  globalThis.hostEvents?.notify?.();
}

function emptyDecision(allow = true): HostDecision {
  return { allow, stdout: "", stderr: "", exitCode: 0 };
}

function terminalOutput(result: {
  outputBytes?: Uint8Array | number[];
  error?: string;
  exitCode?: number;
  exited?: boolean;
}): HostDecision {
  return {
    allow: true,
    stdout: "",
    stdoutBytes: result.outputBytes ?? [],
    stderr: result.error ? `${result.error}\n` : "",
    exitCode: result.exitCode ?? 0,
    done: result.exited === true,
  };
}

function parseProbeSentinel(command: string): number[] | null {
  const sentinel = command.match(/(?:\\[0-7]{3}){8}/)?.[0];
  if (sentinel === undefined) return null;
  const bytes: number[] = [];
  for (const match of sentinel.matchAll(/\\([0-7]{3})/g)) {
    const octal = match[1];
    if (octal === undefined) return null;
    bytes.push(Number.parseInt(octal, 8));
  }
  return bytes.length === 8 ? bytes : null;
}

function appServerOutput(stream: AppServerHostStream, output: Uint8Array): HostDecision {
  return {
    allow: true,
    sensitive: stream.connection.lastOutputSensitive,
    stdout: "",
    stdoutBytes: output,
    stderr: "",
    exitCode: 0,
  };
}

export function createHostPolicy(context: HostContext, options: HostPolicyOptions): HostPolicy {
  const state: HostPolicyState = {
    authentications: 0,
    commands: 0,
    appServerBooted: false,
    streams: new Map(),
  };

  const ensureServices = (): void => options.ensureServices();
  const authenticationDecision = (allow: boolean): HostDecision => {
    state.authentications += 1;
    return { ...emptyDecision(), allow };
  };

  return {
    onTCPOpen(tcpContext) {
      return context.httpIngress.open(tcpContext);
    },

    onTCPData(tcpContext) {
      return context.httpIngress.data(tcpContext);
    },

    onTCPPoll(tcpContext) {
      return context.httpIngress.poll(tcpContext);
    },

    onTCPClose(tcpContext) {
      return context.httpIngress.close(tcpContext);
    },

    onTick() {
      ensureServices();
      if (drainWebCrypto() > 0) notifyHostOutput();
      context.appServer.tick();
      context.threadSearch.tick();
      context.textDeltaPacer.tick();
      context.outboundTcp.tick();
      context.mcpRegistry.tick();
      context.remoteControl.tick();
      context.wecomBot.tick();
      context.codeReviewBot.tick();
    },

    authenticateNone(authContext) {
      return authenticationDecision(context.userDirectory.allowNoneAuth(authContext));
    },

    authenticatePublicKey(authContext) {
      return authenticationDecision(
        context.userDirectory.authenticatePublicKey(authContext),
      );
    },

    authenticate(authContext) {
      return authenticationDecision(
        authContext.username === "codex" && secrets.verifyPassword(authContext.password),
      );
    },

    onRequest(sessionContext) {
      if (sessionContext.request === "shell") {
        context.sshInteractiveTerminal.open(sessionContext);
        state.streams.set(sessionContext.sessionId, { kind: "terminal", chunks: 0 });
        return { ...emptyDecision(), stream: "terminal" };
      }
      if (sessionContext.request === "window-change") {
        const stream = state.streams.get(sessionContext.sessionId);
        if (stream?.kind === "terminal") {
          context.sshInteractiveTerminal.resize(
            sessionContext.sessionId,
            sessionContext.cols,
            sessionContext.rows,
          );
        }
        return emptyDecision();
      }
      return {
        ...emptyDecision(["env", "pty-req", "signal", "break"].includes(
          sessionContext.request ?? "",
        )),
      };
    },

    onStreamData(sessionContext) {
      const stream = state.streams.get(sessionContext.sessionId);
      if (stream === undefined) {
        return { ...emptyDecision(false), stderr: "unknown stream\n", exitCode: 125 };
      }
      const bytes = Uint8Array.from(sessionContext.dataBytes ?? []);
      stream.chunks += 1;
      if (stream.kind === "terminal") {
        return terminalOutput(context.sshInteractiveTerminal.write(sessionContext.sessionId, bytes));
      }
      return appServerOutput(stream, stream.connection.feed(bytes));
    },

    onStreamPoll(sessionContext) {
      const stream = state.streams.get(sessionContext.sessionId);
      if (stream === undefined) return emptyDecision();
      if (stream.kind === "terminal") {
        return terminalOutput(context.sshInteractiveTerminal.poll(sessionContext.sessionId));
      }
      return appServerOutput(stream, stream.connection.poll());
    },

    onStreamClose(sessionContext) {
      const stream = state.streams.get(sessionContext.sessionId);
      if (stream?.kind === "terminal") {
        context.sshInteractiveTerminal.close(sessionContext.sessionId);
      } else {
        stream?.connection.close();
      }
      state.streams.delete(sessionContext.sessionId);
      return emptyDecision();
    },

    onExec(sessionContext) {
      state.commands += 1;
      const command = String(sessionContext.command ?? "").trim();
      if (command.includes("CODEX_REMOTE_PAYLOAD")) {
        const bytes = parseProbeSentinel(command);
        if (bytes === null) {
          return { ...emptyDecision(), stderr: "missing Codex probe sentinel\n", exitCode: 2 };
        }
        if (command.includes("command -v codex")) {
          return { ...emptyDecision(), stdoutBytes: bytes };
        }
        if (command.includes("codex --version")) {
          return {
            ...emptyDecision(),
            stdout: `codex-cli ${POLICY_CONFIG.cliVersion}\n`,
            stdoutBytes: bytes,
          };
        }
        if (
          command.includes("features.code_mode_host=true") &&
          command.includes("app-server --listen unix://")
        ) {
          state.appServerBooted = true;
          return { ...emptyDecision(), stdoutBytes: bytes };
        }
        if (command.includes("codex app-server proxy")) {
          const identity = context.userDirectory.identityForConnection(sessionContext.connectionId);
          state.streams.set(sessionContext.sessionId, {
            kind: "appserver",
            chunks: 0,
            connection: webSocketVServer.connect(sessionContext.sessionId, {
              connectionId: sessionContext.connectionId,
              identity,
            }),
          });
          return {
            ...emptyDecision(),
            stdoutBytes: bytes,
            stream: "codex-app-server-proxy",
          };
        }
        return {
          ...emptyDecision(),
          stdoutBytes: bytes,
          stderr: `hypernode observed wrapped command #${state.commands}\n`,
          exitCode: 127,
        };
      }
      return executeObservationCommand(context, state, sessionContext, command);
    },
  };
}

function executeObservationCommand(
  context: HostContext,
  state: HostPolicyState,
  sessionContext: HostSessionContext,
  command: string,
): HostDecision {
  if (command === "") return emptyDecision();
  if (command === "pwd") return { ...emptyDecision(), stdout: "/workspace\n" };
  if (command === "whoami" || command === "id -un") {
    const identity = context.userDirectory.identityForConnection(sessionContext.connectionId);
    return { ...emptyDecision(), stdout: `${identity?.username ?? "root"}\n` };
  }
  if (command === "uname" || command === "uname -s") {
    return { ...emptyDecision(), stdout: "Linux\n" };
  }
  if (command === "uname -a") {
    return {
      ...emptyDecision(),
      stdout: "Linux hypernode 6.8.0-hypernode x86_64 GNU/Linux\n",
    };
  }
  if (command === "true" || command === ":") return emptyDecision();
  if (command === "false") return { ...emptyDecision(), exitCode: 1 };
  if (command.startsWith("echo ")) {
    return { ...emptyDecision(), stdout: line(command.slice(5)) };
  }
  if (command === "env" || command === "printenv") {
    return {
      ...emptyDecision(),
      stdout: "HOME=/workspace\nUSER=codex\nSHELL=/bin/bash\nTERM=xterm-256color\n",
    };
  }
  const executableProbe = executableFromCommandVProbe(command);
  if (executableProbe !== null) {
    const known = ["sh", "bash", "uname", "pwd", "whoami", "env", "printf", "echo"];
    return known.includes(executableProbe)
      ? { ...emptyDecision(), stdout: `/usr/bin/${executableProbe}\n` }
      : { ...emptyDecision(), exitCode: 1 };
  }
  return {
    ...emptyDecision(),
    stderr: `hypernode observed command #${state.commands}: ${command}\n`,
    exitCode: 127,
  };
}

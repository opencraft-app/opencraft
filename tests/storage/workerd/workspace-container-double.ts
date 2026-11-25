// In-isolate double of a Durable Object's `ctx.container` for the WorkspaceHost
// Durable Object in workerd (no Cloudflare Containers, no child processes).
// tests/execution/fixtures/cloudflare-container.ts runs real processes in Node;
// workerd has none, so this double plays the guest side in JavaScript with the
// same observable contract (workspace-host-split §3.6 probe results):
//
// - `exec` of the identity probe answers boot id, CPU count, cgroup memory and
//   placement; `exec` of the shared broker (`@opencraft/sandbox/broker`) speaks its
//   NDJSON frames, and only the fixed endpoint relay may be started under it;
// - the relay connects to the container's `workspace-agent` endpoints: `control`
//   (probe/describe) and the Engine Host on `pi` (HTTP control routes and a JSON-RPC
//   WebSocket, as the real Engine Host serves them on its Unix socket);
// - `monitor()` settles when the container stops (exit 0 or reasonless destroy
//   resolve, a crash rejects with `exitCode`), `destroy()` ends every exec;
// - a Durable Object reset drops exec handles: every broker reads EOF;
// - each start is a new incarnation (boot id, placement, agent incarnation) with
//   empty engine state: the container disk is a cache.
// Module state outlives a Durable Object reset in the same isolate, as a real
// container outlives its object.
import { CLOUDFLARE_IDENTITY_SOURCE } from "@opencraft/sandbox-cloudflare";
import type {
  ContainerExecOptions,
  ContainerExecProcess,
  ContainerInfo,
  ContainerStartOptions,
  DurableObjectContainer,
} from "@opencraft/sandbox-cloudflare/bindings";
import { brokerSource } from "@opencraft/sandbox/broker";
import { endpointRelaySource } from "@opencraft/sandbox/endpoint";
import { SIDE_CHAT_INSTRUCTIONS, type ProcessSnapshot } from "@opencraft/appserver-protocol";
import type { Project } from "@opencraft/appserver-protocol/generated/v2";
import {
  encodeTerminalOwnerFrame, terminalOwnerFrameReader, TERMINAL_OWNER_PROTOCOL,
} from "../../../apps/local-agent-host/src/terminal-owner-wire.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
};

/** The peer side of one endpoint connection, inside the container. */
interface Peer {
  send(bytes: Uint8Array): void;
  end(): void;
}
interface Owner {
  data(bytes: Uint8Array): void;
  end(): void;
}

export interface EngineTurn {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  inputId: string | null;
  steered?: { type: "userMessage"; id: string; clientId: string; content: unknown[] }[];
}
/** Every input an Engine Host accepted, across incarnations (what the test asserts never repeats). */
export interface EngineInput {
  readonly agent: string;
  readonly threadId: string;
  readonly inputId: string;
  readonly text: string;
  readonly turnId: string;
}

type ContainerExit = { code: number } | { reason: unknown };
interface Instance {
  readonly boot: string;
  readonly placement: string;
  readonly options: ContainerStartOptions;
  stopped: boolean;
  outcome?: ContainerExit;
  readonly monitors: Set<(outcome: ContainerExit) => void>;
  readonly execs: Set<{ stop(code: number): void; eof(): void }>;
  agent: ReturnType<typeof newAgent>;
}

const newAgent = () => ({
  id: hex(16),
  startedAt: new Date().toISOString(),
  token: hex(24),
  fileToken: hex(32),
  turns: new Map<string, EngineTurn[]>(),
  provisionalCodexThreads: new Set<string>(),
  archivedCodexThreads: new Set<string>(),
  codexThreadNames: new Map<string, string>(),
  codexHistoryModes: new Map<string, "legacy" | "paginated">(),
  forkOrigins: new Map<string, string>(),
  sideChats: new Set<string>(),
  bridgeOutboxId: hex(16),
  bridgeAck: 0,
  bridgeEvents: [{
    seq: 1, route: JSON.stringify(["fixture-server", "fixture-thread"]), generation: "fixture-generation",
    payload: { method: "thread/name/updated", params: { threadName: "Workspace Bridge" } } as unknown,
  }],
  bridgeCommands: new Map<string, unknown>(),
  bridgeThreads: new Map<string, { id: string; cwd: string; ephemeral: false; historyMode: string; status: { type: string }; turns: unknown[] }>(),
  pendingApprovals: new Map<string, { threadId: string; turn: EngineTurn; lane: string }>(),
  terminals: new Map<string, { owner: string; snapshot: ProcessSnapshot }>(),
  files: new Map<string, string>(),
  projects: new Map<string, Project>(),
  threadProjects: new Map<string, { projectId: string; cwd: string }>(),
  terminalObservers: new Set<(value: unknown) => void>(),
  retiredTerminals: new Set<string>(),
  next: 0,
});

export class ContainerDouble implements DurableObjectContainer {
  readonly images = Object.freeze({ workspace: "registry.example.test/opencraft-workspace@sha256:" + "0".repeat(64) });
  readonly starts: ContainerStartOptions[] = [];
  readonly modelIntercepts: { host: string; running: boolean }[] = [];
  readonly timeouts: number[] = [];
  readonly inputs: EngineInput[] = [];
  destroys = 0;
  /** Engine Host routes and JSON-RPC methods served, in order (`GET /health`, `rpc thread/turns/list`, …). */
  readonly served: string[] = [];
  #current: Instance | undefined;
  #last: Instance | undefined;
  readonly #snapshots = new Map<string, Pick<ReturnType<typeof newAgent>,
    "turns" | "archivedCodexThreads" | "codexThreadNames" | "codexHistoryModes" | "forkOrigins" | "sideChats" |
    "projects" | "threadProjects" | "bridgeOutboxId" | "bridgeAck" | "bridgeEvents" | "bridgeThreads" | "bridgeCommands">>();
  oversizedNextCodexPage = false;
  dropNextCodexStartReply = false;
  holdNextCodexTurnReply = false;
  rejectNextCodexInitialize = false;
  rejectNextSnapshot = false;
  terminalCleanupUnavailable = false;
  #modelEgress?: { host: string; entry: { fetch(request: Request): Promise<Response> } };

  async interceptOutboundHttp(host: string, entry: { fetch(request: Request): Promise<Response> }): Promise<void> {
    this.modelIntercepts.push({ host, running: this.running });
    this.#modelEgress = { host, entry };
  }

  async modelRequest(method: string, route: string): Promise<Response> {
    const intercept = this.#modelEgress;
    const origin = this.#current?.options.env?.OPENCRAFT_CODEX_EGRESS_ORIGIN;
    const provider = this.#current?.options.env?.OPENCRAFT_CODEX_EGRESS_PROVIDER;
    if (!origin || !provider || !intercept) return new Response(null, { status: 503 });
    return intercept.entry.fetch(new Request(new URL(`/__opencraft_egress/${encodeURIComponent(provider)}/${route}`, origin), { method }));
  }
  #codexReadGate: PromiseWithResolvers<void> | null = null;
  #codexStartGate: PromiseWithResolvers<void> | null = null;

  pauseCodexStarts(): void {
    this.#codexStartGate ??= Promise.withResolvers<void>();
  }

  releaseCodexStarts(): void {
    const gate = this.#codexStartGate;
    this.#codexStartGate = null;
    gate?.resolve();
  }

  pauseCodexReads(): void {
    this.#codexReadGate ??= Promise.withResolvers<void>();
  }

  releaseCodexReads(): void {
    const gate = this.#codexReadGate;
    this.#codexReadGate = null;
    gate?.resolve();
  }

  get running() {
    return !!this.#current && !this.#current.stopped;
  }
  get agent() {
    return this.#current?.agent.id;
  }

  publishBridgeTitle(title: string) {
    const agent = this.#current?.agent;
    if (!this.running || !agent || !title) throw new Error("Bridge fixture is unavailable");
    agent.bridgeEvents.push({ ...agent.bridgeEvents[0]!, seq: agent.bridgeEvents.length + 1,
      payload: { method: "thread/name/updated", params: { threadName: title } } });
  }

  start(options: ContainerStartOptions): void {
    if (this.running) throw new Error("Container is already running");
    const saved = options.containerSnapshot && this.#snapshots.get(options.containerSnapshot.id);
    if (!(options.image || saved) || typeof options.enableInternet !== "boolean") throw new RangeError("Invalid start options");
    this.starts.push(options);
    this.#current = this.#last = {
      boot: crypto.randomUUID(),
      placement: hex(16),
      options,
      stopped: false,
      monitors: new Set(),
      execs: new Set(),
      agent: { ...newAgent(), ...structuredClone(saved || {}) },
    };
  }
  async inspect(): Promise<ContainerInfo | null> {
    const current = this.#current;
    return current && !current.stopped ? { image: current.options.image ?? "", labels: { ...current.options.labels } } : null;
  }
  async snapshotContainer() {
    if (this.rejectNextSnapshot) {
      this.rejectNextSnapshot = false;
      throw new Error("Container snapshot unavailable");
    }
    const current = this.#current;
    if (!current || current.stopped) throw new Error("Container is not running");
    const id = crypto.randomUUID();
    const { turns, archivedCodexThreads, codexThreadNames, codexHistoryModes, forkOrigins, sideChats,
      projects, threadProjects, bridgeOutboxId, bridgeAck, bridgeEvents, bridgeThreads, bridgeCommands } = current.agent;
    this.#snapshots.set(id, structuredClone({ turns, archivedCodexThreads, codexThreadNames, codexHistoryModes, forkOrigins, sideChats,
      projects, threadProjects, bridgeOutboxId, bridgeAck, bridgeEvents, bridgeThreads, bridgeCommands }));
    return { id, size: current.agent.turns.size };
  }
  monitor(): Promise<void> {
    const instance = this.#current ?? this.#last;
    if (!instance) throw new Error("This Durable Object has no container");
    return new Promise<void>((resolve, reject) => {
      const settle = (outcome: ContainerExit) => {
        if ("code" in outcome && outcome.code !== 0)
          reject(Object.assign(new Error(`Container exited with code ${outcome.code}`), { exitCode: outcome.code }));
        else if ("reason" in outcome && outcome.reason !== undefined) reject(outcome.reason);
        else resolve();
      };
      if (instance.outcome) settle(instance.outcome);
      else instance.monitors.add(settle);
    });
  }
  async setInactivityTimeout(durationMs: number): Promise<void> {
    if (!(durationMs > 0) || durationMs > 6 * 3600_000) throw new RangeError("Invalid inactivity timeout");
    this.timeouts.push(durationMs);
  }
  async destroy(reason?: unknown): Promise<void> {
    const instance = this.#current;
    if (!instance || instance.stopped) return;
    this.destroys++;
    this.#stop(instance, { reason });
  }
  /** The container's main process exits by itself (a crash when `code` is nonzero). */
  crash(code: number): void {
    const instance = this.#current;
    if (instance && !instance.stopped) this.#stop(instance, { code });
  }
  /** The agent restarts inside the same container: a new agent incarnation, empty engine state. */
  restartAgent(): void {
    if (this.#current && !this.#current.stopped) this.#current.agent = newAgent();
  }
  /** A Durable Object reset: exec handles are gone, so every broker reads EOF on its control input. */
  resetDurableObject(): void {
    for (const exec of this.#current?.execs ?? []) exec.eof();
    this.#current?.monitors.clear();
  }
  /** Ends every running Turn of the current engine as completed. */
  completeTurns(): number {
    let count = 0;
    for (const turns of this.#current?.agent.turns.values() ?? [])
      for (const turn of turns)
        if (turn.status === "inProgress") {
          turn.status = "completed";
          count++;
        }
    return count;
  }
  #stop(instance: Instance, outcome: ContainerExit) {
    instance.stopped = true;
    instance.outcome = outcome;
    if (this.#current === instance) this.#modelEgress = undefined;
    for (const exec of [...instance.execs]) exec.stop(137);
    for (const settle of instance.monitors) settle(outcome);
    instance.monitors.clear();
  }

  async exec(command: string[], options: ContainerExecOptions = {}): Promise<ContainerExecProcess> {
    const instance = this.#current;
    if (!instance || instance.stopped) throw new Error("Container is not running");
    let exit!: (code: number) => void;
    const exitCode = new Promise<number>((resolve) => {
      exit = resolve;
    });
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    });
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      instance.execs.delete(handle);
      try {
        output.close();
      } catch {}
      exit(code);
    };
    const write = (text: string) => {
      if (!finished) output.enqueue(encoder.encode(text));
    };
    let owner: Owner | undefined;
    const handle = {
      stop: (code: number) => {
        owner = undefined;
        finish(code);
      },
      eof: () => {
        // The broker kills its session on control-input EOF.
        owner?.end();
        owner = undefined;
        finish(0);
      },
    };
    instance.execs.add(handle);
    if (command.includes(CLOUDFLARE_IDENTITY_SOURCE)) {
      const size = instance.options.instance;
      const custom = typeof size === "object" ? size : { vcpu: 4, memoryMib: 12288 };
      write(
        JSON.stringify({
          boot: instance.boot,
          cpus: Math.ceil(custom.vcpu),
          memory: String(custom.memoryMib * 1024 ** 2),
          placement: instance.placement,
        }) + "\n",
      );
      finish(0);
      return { stdout, stdin: null, stderr: null, pid: 1000, exitCode, kill: () => finish(137) };
    }
    if (command[4] !== brokerSource || options.stdin !== "pipe")
      throw new Error("The container double runs only the identity probe and the shared broker");
    // The shared broker, frame for frame.
    let line = "",
      started = false;
    const emit = (frame: Record<string, unknown>) => write(JSON.stringify(frame) + "\n");
    const ended = () => {
      emit({ type: "exit", code: 0, signal: null });
      handle.stop(0);
    };
    const frame = (message: Record<string, any>) => {
      if (message.type === "start" && !started) {
        started = true;
        const argv = message.command?.command as string[] | undefined;
        const endpoint =
          argv && argv[3] === "-c" && argv[4] === endpointRelaySource && argv.length === 6
            ? argv[5]!.slice(argv[5]!.lastIndexOf("/") + 1)
            : undefined;
        const serve = endpoint ? this.#endpoint(instance, endpoint) : undefined;
        if (!serve) {
          emit({ type: "error", reason: "start-failed" });
          handle.stop(2);
          return;
        }
        emit({ type: "started" });
        owner = serve({
          send: (bytes) => emit({ type: "output", stream: "stdout", data: b64(bytes) }),
          end: ended,
        });
      } else if (message.type === "stdin" && owner) owner.data(unb64(message.data));
      else if (message.type === "eof" && owner) owner.end();
      else if (message.type === "terminate") {
        owner = undefined;
        emit({ type: "exit", code: null, signal: "SIGKILL" });
        handle.stop(0);
      }
    };
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        line += decoder.decode(chunk, { stream: true });
        for (let end = line.indexOf("\n"); end >= 0; end = line.indexOf("\n")) {
          const text = line.slice(0, end);
          line = line.slice(end + 1);
          try {
            frame(JSON.parse(text));
          } catch {
            emit({ type: "error" });
            handle.stop(2);
          }
        }
      },
      close: () => handle.eof(),
      abort: () => handle.eof(),
    });
    return { stdin, stdout, stderr: null, pid: 1001, exitCode, kill: () => handle.stop(137) };
  }

  /** The agent's named endpoints. */
  #endpoint(instance: Instance, name: string): ((peer: Peer) => Owner) | undefined {
    if (name === "control") return (peer) => this.#control(instance, peer);
    if (name === "terminal") return (peer) => this.#terminal(instance, peer);
    if (name === "codex-bridge" && instance.options.env?.OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT === "true")
      return (peer) => this.#engineHost(instance, peer, name);
    if (name === "pi" || name === "codex-control" || name === "codex-native" || name === "files")
      return (peer) => this.#engineHost(instance, peer, name);
    return undefined;
  }

  #control(instance: Instance, peer: Peer): Owner {
    let text = "";
    return {
      data: (bytes) => {
        text += decoder.decode(bytes, { stream: true });
        const end = text.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(text.slice(0, end));
        const agent = instance.agent;
        const bridge = instance.options.env?.OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT === "true";
        const answer =
          request.type === "probe"
            ? {
                protocol: 1,
                type: "healthy",
                state: "ready",
                roles: ["workspace"],
                incarnation: { id: agent.id, evidence: `double:${instance.boot}`, startedAt: agent.startedAt },
                endpoints: ["control", "pi", "codex-control", "codex-native", "terminal", "files", ...(bridge ? ["codex-bridge"] : [])],
                endpointGeneration: 0,
              }
            : request.type === "describe" && request.name === "pi"
              ? {
                  protocol: 1,
                  type: "endpoint",
                  name: "pi",
                  descriptor: {
                    schemaVersion: 1,
                    websocketUrl: `ws+unix:///run/opencraft-agent/engine-host.sock:/rpc?token=${agent.token}`,
                    token: agent.token,
                    pid: 42,
                    machineId: instance.options.env?.OPENCRAFT_MACHINE_ID,
                    engines: ["pi"],
                    defaultEngine: "pi",
                    dataDirectory: "/var/lib/opencraft-workspace/pi",
                  },
                }
              : request.type === "describe" && (["codex-control", "terminal", "files"].includes(request.name) || (bridge && request.name === "codex-bridge"))
                ? {
                    protocol: 1,
                    type: "endpoint",
                    name: request.name,
                    descriptor: { token: request.name === "files" ? agent.fileToken : agent.token },
                  }
                : { protocol: 1, type: "error" };
        peer.send(encoder.encode(JSON.stringify(answer) + "\n"));
        peer.end();
      },
      end: () => peer.end(),
    };
  }

  #terminal(instance: Instance, peer: Peer): Owner {
    let attached = false;
    const send = (value: unknown) => peer.send(encodeTerminalOwnerFrame(value));
    const { terminals, terminalObservers, retiredTerminals } = instance.agent;
    const notify = (value: unknown) => { for (const observe of terminalObservers) observe(value); };
    const exit = (snapshot: ProcessSnapshot) => {
      if (snapshot.phase !== "running") return;
      snapshot.phase = "exited";
      snapshot.exitCode = 0;
      notify({ method: "process/exited", params: { processHandle: snapshot.processHandle, exitCode: 0 } });
    };
    const data = terminalOwnerFrameReader(value => {
      const request = value as {
        type?: string; token?: string; protocol?: number; id: number; method: string;
        params: {
          processHandle?: string; deltaBase64: string; afterSequence: number; cwd: string; command: string[];
          resourceOwnerId?: string; activate?: boolean; aliases?: { owner: string; resourceOwnerId: string }[];
        };
        identity: { owner: string; lifecycleAuthority?: boolean; scope: { threadId: string | null; projectId: string | null } };
      };
      if (!attached) {
        if (request.type !== "attach" || request.token !== instance.agent.token || request.protocol !== TERMINAL_OWNER_PROTOCOL)
          return peer.end();
        attached = true;
        terminalObservers.add(send);
        return send({ type: "attached", protocol: TERMINAL_OWNER_PROTOCOL, terminalAdmission: 1 });
      }
      const { id, method, params, identity } = request;
      const { processHandle } = params;
      this.served.push(`terminal ${method}`);
      const answer = (result: unknown) => send({ id, result });
      const matches = (terminal: { owner: string; snapshot: ProcessSnapshot }) => terminal.owner === identity.owner &&
        (!identity.scope.threadId || terminal.snapshot.context?.threadId === identity.scope.threadId);
      if (method === "process/releaseThread") {
        const { threadId } = identity.scope;
        if (!threadId || !identity.lifecycleAuthority || this.terminalCleanupUnavailable) return send({ id, error: "unavailable" });
        if (params.activate) retiredTerminals.delete(threadId);
        else {
          retiredTerminals.add(threadId);
          for (const { owner, snapshot } of terminals.values()) {
            const context = snapshot.context;
            if (context?.threadId === threadId || (context?.threadId === null &&
              params.aliases?.some(alias => alias.owner === owner && alias.resourceOwnerId === context.resourceOwnerId))) exit(snapshot);
          }
        }
        return answer({ pending: 0 });
      }
      if (method === "process/list") {
        return answer({ processes: [...terminals.values()].filter(matches).map(({ snapshot: { output: _output, ...metadata } }) => metadata) });
      }
      if (!processHandle) return send({ id, error: "invalid" });
      if (method === "process/spawn" && !terminals.has(processHandle)) {
        if (identity.scope.threadId && retiredTerminals.has(identity.scope.threadId)) return send({ id, error: "archived" });
        terminals.set(processHandle, { owner: identity.owner, snapshot: {
          processHandle, phase: "running", exitCode: null, nextSequence: 0, truncated: false, output: [],
          context: { ...identity.scope, resourceOwnerId: params.resourceOwnerId ?? null, cwd: params.cwd, shell: params.command[0]! },
        } });
        return answer({ processHandle });
      }
      const terminal = terminals.get(processHandle);
      if (!terminal || !matches(terminal)) return send({ id, error: "missing" });
      const { snapshot } = terminal;
      if (method === "process/attach") {
        return answer({ ...snapshot, output: snapshot.output.filter(output => output.sequence > params.afterSequence) });
      }
      answer({});
      if (method === "process/writeStdin") {
        const output = { processHandle, sequence: ++snapshot.nextSequence, stream: "stdout" as const, deltaBase64: params.deltaBase64 };
        snapshot.output.push(output);
        notify({ method: "process/outputDelta", params: output });
      }
      if (method === "process/kill") exit(snapshot);
    });
    return { data, end: () => { terminalObservers.delete(send); peer.end(); } };
  }

  /** The Engine Host on its private socket: control routes over HTTP/1.1, App Server JSON-RPC over WebSocket. */
  #engineHost(instance: Instance, peer: Peer, name: "pi" | "codex-control" | "codex-native" | "codex-bridge" | "files"): Owner {
    const agent = instance.agent;
    const nativeSubscriptions = new Set<string>();
    const nativeStreams = new Map<string, AbortController>();
    const { pendingApprovals } = agent;
    let nativeLane = "";
    let buffer = new Uint8Array(0),
      socket = false;
    const respond = (status: number, value: unknown) => {
      const body = encoder.encode(JSON.stringify(value));
      peer.send(
        concat(
          encoder.encode(
            `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${body.byteLength}\r\nconnection: close\r\n\r\n`,
          ),
          body,
        ),
      );
      peer.end();
    };
    const lastTurn = (threadId: string) => agent.turns.get(threadId)?.at(-1) ?? null;
    const route = (method: string, target: string, headers: Map<string, string>, body: string) => {
      const url = new URL(target, "http://engine.invalid");
      this.served.push(`${name === "codex-bridge" ? "bridge " : ""}${method} ${url.pathname}`);
      const token = name === "files" ? agent.fileToken : agent.token;
      if (headers.get("authorization") !== `Bearer ${token}`) return respond(401, { error: "unauthorized" });
      if (name === "codex-bridge") {
        if (method === "GET" && url.pathname === "/health")
          return respond(200, { pid: 43, incarnation: `bridge:${agent.id}`, generations: [] });
        if (method === "GET" && url.pathname === "/snapshot")
          return respond(200, { ack: agent.bridgeAck, routes: [...agent.bridgeThreads.keys()].map(route => ({ route })),
            nativeSessions: [...agent.bridgeThreads].map(([route, thread]) => ({ route, native_id: thread.id, restorable: 1 })), interactions: [] });
        if (method === "GET" && url.pathname === "/events" && url.searchParams.get("fenced") === "1") {
          const cursor = Number(url.searchParams.get("cursor"));
          if (cursor < agent.bridgeAck || cursor > agent.bridgeEvents.length) return respond(409, { error: "invalid cursor" });
          return respond(200, { outboxId: agent.bridgeOutboxId, acknowledged: agent.bridgeAck, high: agent.bridgeEvents.length,
            events: agent.bridgeEvents.slice(cursor) });
        }
        if (method === "POST" && url.pathname === "/ack") {
          const { outboxId, cursor } = JSON.parse(body);
          if (outboxId !== agent.bridgeOutboxId || cursor < agent.bridgeAck || cursor > agent.bridgeEvents.length)
            return respond(409, { error: "invalid acknowledgement" });
          agent.bridgeAck = cursor;
          return respond(200, null);
        }
        if (method === "POST" && url.pathname === "/command") {
          const call = JSON.parse(body);
          const key = JSON.stringify([call.serverId, call.threadId]);
          if (call.method !== "session/create") return respond(404, { error: "missing" });
          const thread = { id: crypto.randomUUID(), ephemeral: false as const, cwd: "/workspace",
            historyMode: call.params.native.historyMode, status: { type: "idle" }, turns: [] };
          agent.bridgeThreads.set(key, thread);
          agent.bridgeEvents.push({ seq: agent.bridgeEvents.length + 1, route: key, generation: "fixture-generation",
            payload: { method: "thread/identity", params: { providerThreadId: thread.id } } });
          agent.bridgeCommands.set(call.commandId, { state: "accepted", response: { result: { thread, model: "m", cwd: thread.cwd } } });
          return respond(200, { state: "registered", commandId: call.commandId });
        }
        if (method === "GET" && url.pathname === "/command")
          return respond(200, agent.bridgeCommands.get(url.searchParams.get("id") ?? "") ?? null);
        if (method === "POST" && url.pathname === "/observe") {
          const { threadId, serverId } = JSON.parse(body);
          const thread = agent.bridgeThreads.get(JSON.stringify([serverId, threadId]));
          return thread ? respond(200, { thread }) : respond(404, { error: "missing" });
        }
        return respond(404, { error: "missing" });
      }
      if (name === "files") {
        if (method !== "POST" || url.pathname !== "/workspace/rpc") return respond(404, { error: "missing" });
        const { method: operation, params: { path, dataBase64 } } = JSON.parse(body);
        if (operation === "fs/writeFile") {
          agent.files.set(path, dataBase64);
          return respond(200, { result: {} });
        }
        if (operation === "fs/readFile" && agent.files.has(path))
          return respond(200, { result: { dataBase64: agent.files.get(path) } });
        if (operation === "fs/readDirectory")
          return respond(200, { result: { entries: [{ fileName: "demo", isDirectory: true, isFile: false }] } });
        if (operation === "fs/getMetadata") {
          const isSymlink = path.endsWith("/link");
          return respond(200, { result: { isDirectory: !isSymlink, isFile: false, isSymlink, createdAtMs: 1000, modifiedAtMs: 1000 } });
        }
        return respond(404, { error: "missing" });
      }
      if (name === "codex-control") {
        if (method !== "GET" || !["/health", "/native-health"].includes(url.pathname))
          return respond(404, { error: "missing" });
        return respond(200, {
          protocolVersion: 1,
          pid: 40,
          codexPid: 41,
          executionIncarnation: `codex-process:${agent.id}`,
          callbackProtocolVersion: 1,
          callbackIncarnation: `codex-callback:${agent.id}`,
          threadTitleToolVersion: 1,
        });
      }
      if (method === "GET" && url.pathname === "/health")
        return respond(200, {
          ok: true,
          protocolVersion: 1,
          pid: 42,
          machineId: instance.options.env?.OPENCRAFT_MACHINE_ID,
          defaultEngine: "pi",
          engines: ["pi"],
          storage: {},
        });
      if (method === "GET" && url.pathname === "/execution-origin") {
        const threadId = url.searchParams.get("threadId")!;
        return respond(200, { threadId, pid: 42, incarnation: `process:${agent.id}`, turn: lastTurn(threadId) });
      }
      if (method === "POST" && url.pathname === "/host-inputs") {
        const { action, threadId, inputId, text } = JSON.parse(body);
        const turns = agent.turns.get(threadId) ?? [];
        const existing = turns.find((turn) => turn.inputId === inputId);
        if (action === "receipt")
          return respond(200, { receipt: existing ? { state: "delivered", turnId: existing.id } : null });
        if (existing) return respond(200, { receipt: { state: "delivered", turnId: existing.id } });
        for (const turn of turns) if (turn.status === "inProgress") turn.status = "completed";
        const turn: EngineTurn = { id: `turn-${agent.id.slice(0, 6)}-${++agent.next}`, status: "inProgress", inputId };
        agent.turns.set(threadId, [...turns, turn]);
        this.inputs.push({ agent: agent.id, threadId, inputId, text, turnId: turn.id });
        return respond(200, { receipt: { state: "delivered", turnId: turn.id } });
      }
      return respond(404, { error: "missing" });
    };
    const frameOut = (text: string) => {
      const payload = encoder.encode(text);
      const size = payload.byteLength;
      const head = size < 126 ? new Uint8Array([0x81, size]) : new Uint8Array([0x81, 126, size >>> 8, size & 0xff]);
      peer.send(concat(head, payload));
    };
    const offerApproval = (id: string, threadId: string, turnId: string) => {
      frameOut(JSON.stringify({ id, method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "test-approval", command: "printf smoke" },
        __opencraftInteractionKey: `human:${id}`, __opencraftInteractionState: "pending" }));
    };
    const rpc = (text: string) => {
      const message = JSON.parse(text);
      if (message.method === "initialized" && nativeLane) {
        for (const [id, approval] of pendingApprovals) {
          if (approval.lane !== nativeLane) continue;
          nativeSubscriptions.add(approval.threadId);
          offerApproval(id, approval.threadId, approval.turn.id);
        }
      }
      if (message.id === undefined) return;
      if (name === "codex-native" && message.method === undefined) {
        const approval = pendingApprovals.get(message.id);
        if (!approval || approval.lane !== nativeLane || message.__opencraftInteractionKey !== `human:${message.id}` ||
          message.result?.decision !== "accept") return;
        this.served.push("native approval reply");
        pendingApprovals.delete(message.id);
        const { threadId, turn } = approval;
        nativeStreams.delete(turn.id);
        frameOut(JSON.stringify({ method: "serverRequest/resolved", params: { threadId, requestId: message.id } }));
        turn.status = "completed";
        frameOut(JSON.stringify({ method: "turn/completed", params: { threadId, turn } }));
        return;
      }
      this.served.push(`rpc ${message.method}`);
      if (name === "codex-native" && message.method === "initialize" && this.rejectNextCodexInitialize) {
        this.rejectNextCodexInitialize = false;
        frameOut(JSON.stringify({ id: message.id, error: { code: -32603, message: "initialization failed" } }));
        return;
      }
      const codexThreadSettings = {
        model: "m", modelProvider: "opencraft", cwd: "/workspace", runtimeWorkspaceRoots: [],
        approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" },
      };
      if (name === "codex-native" && message.method === "project/create") {
        const { name, roots, metadata = {}, idempotencyKey } = message.params;
        const prior = agent.projects.get(idempotencyKey);
        if (prior && JSON.stringify(prior.roots) !== JSON.stringify(roots)) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32602, message: "Project request reused" } }));
          return;
        }
        const project = prior ?? { id: crypto.randomUUID(), name, roots, metadata, position: agent.projects.size,
          createdAt: 1, updatedAt: 1, recencyAt: null };
        agent.projects.set(idempotencyKey, project);
        frameOut(JSON.stringify({ id: message.id, result: { project } }));
        return;
      }
      if (name === "codex-native" && message.method === "project/list") {
        const { cursor, limit } = message.params;
        const offset = cursor === null ? 0 : Number(cursor);
        const projects = [...agent.projects.values()];
        const data = projects.slice(offset, offset + limit);
        frameOut(JSON.stringify({ id: message.id, result: { data,
          nextCursor: offset + data.length < projects.length ? String(offset + data.length) : null } }));
        return;
      }
      if (name === "codex-native" && ["thread/start", "thread/fork"].includes(message.method)) {
        if (message.params?.fail) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32603, message: "creation failed" } }));
          return;
        }
        const origin = message.method === "thread/fork" ? message.params?.threadId as string | undefined : undefined;
        const historyMode = (origin ? agent.codexHistoryModes.get(origin) : message.params?.historyMode) === "paginated"
          ? "paginated" : "legacy";
        const original = origin ? agent.turns.get(origin) ?? [] : [];
        const { lastTurnId, beforeTurnId } = message.params ?? {};
        const anchor = lastTurnId ?? beforeTurnId;
        const end = anchor === undefined ? original.length : original.findIndex(turn => turn.id === anchor);
        if (end < 0) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32602, message: "Unknown fork anchor" } }));
          return;
        }
        const id = crypto.randomUUID();
        const project = origin ? agent.threadProjects.get(origin) : message.params?.projectId
          ? { projectId: message.params.projectId, cwd: message.params.cwd } : undefined;
        if (project) agent.threadProjects.set(id, project);
        const thread = { id, ephemeral: message.params?.ephemeral === true, historyMode, ...project,
          forkedFromId: origin ?? null, turns: [] };
        if (!thread.ephemeral) agent.turns.set(thread.id, structuredClone(original.slice(0, end + (lastTurnId ? 1 : 0))));
        if (origin) {
          agent.forkOrigins.set(thread.id, origin);
          agent.codexHistoryModes.set(thread.id, historyMode);
          if (message.params.developerInstructions === SIDE_CHAT_INSTRUCTIONS && message.params.deferGoalContinuation === true)
            agent.sideChats.add(thread.id);
        }
        if (message.method === "thread/start" && !thread.ephemeral) {
          agent.codexHistoryModes.set(thread.id, historyMode);
          if (message.params?.historyMode) agent.provisionalCodexThreads.add(thread.id);
        }
        if (this.dropNextCodexStartReply) {
          this.dropNextCodexStartReply = false;
          peer.end();
          return;
        }
        const reply = () => {
          nativeSubscriptions.add(thread.id);
          frameOut(JSON.stringify({ method: "thread/started", params: { thread } }));
          frameOut(JSON.stringify({ id: message.id, result: { thread, ...codexThreadSettings } }));
        };
        if (message.method === "thread/start" && this.#codexStartGate) {
          void this.#codexStartGate.promise.then(reply).catch(() => {});
        } else reply();
        return;
      }
      if (name === "codex-native" && message.method === "thread/list") {
        const { cursor, limit, archived, sortDirection, searchTerm } = message.params;
        const rows = [...agent.turns.keys()].flatMap((id, index) => {
          const name = agent.codexThreadNames.get(id) ?? `Fixture ${id}`;
          if (agent.provisionalCodexThreads.has(id) || agent.archivedCodexThreads.has(id) !== archived ||
            (searchTerm && !name.includes(searchTerm))) return [];
          return [{
            id, name, cwd: "/workspace", ...agent.threadProjects.get(id), historyMode: "legacy", modelProvider: "opencraft",
            createdAt: index + 1, updatedAt: index + 1, ephemeral: false, status: { type: "idle" },
            turns: [{ id: "private-history-payload" }],
          }];
        });
        if (sortDirection === "desc") rows.reverse();
        const start = cursor ? rows.findIndex(row => cursor === `after:${row.id}`) + 1 : 0;
        const data = rows.slice(start, start + limit);
        frameOut(JSON.stringify({ id: message.id, result: { data,
          nextCursor: start + data.length < rows.length ? `after:${data.at(-1)!.id}` : null,
          backwardsCursor: data.length ? `after:${data[0]!.id}` : null,
        } }));
        return;
      }
      if (name === "codex-native" && ["thread/name/set", "thread/archive", "thread/unarchive"].includes(message.method)) {
        const { threadId, name } = message.params;
        if (!agent.turns.has(threadId)) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32600, message: "Thread not found" } }));
          return;
        }
        let result: unknown = {};
        if (message.method === "thread/name/set") {
          agent.codexThreadNames.set(threadId, name);
          if (name === "Unconfirmed fixture title") result = { unexpected: true };
        } else if (message.method === "thread/archive") {
          agent.provisionalCodexThreads.delete(threadId);
          agent.archivedCodexThreads.add(threadId);
        } else {
          agent.archivedCodexThreads.delete(threadId);
          result = { thread: { id: threadId, name: agent.codexThreadNames.get(threadId), cwd: "/workspace",
            createdAt: 1, updatedAt: 2, historyMode: "legacy", ephemeral: false, status: { type: "notLoaded" }, turns: [] } };
        }
        frameOut(JSON.stringify({ id: message.id, result }));
        return;
      }
      if (name === "codex-native" && message.method === "thread/read" && message.params.includeTurns &&
          agent.provisionalCodexThreads.has(message.params.threadId)) {
        frameOut(JSON.stringify({
          id: message.id,
          error: {
            code: -32600,
            message: `thread ${message.params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
          },
        }));
        return;
      }
      if (name === "codex-native" && message.method === "thread/resume" &&
          agent.provisionalCodexThreads.has(message.params.threadId)) {
        frameOut(JSON.stringify({
          id: message.id,
          error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` },
        }));
        return;
      }
      if (name === "codex-native" && message.method === "thread/resume")
        nativeSubscriptions.add(message.params.threadId);
      if (name === "codex-native" && message.method === "thread/settings/update") {
        const { threadId, collaborationMode } = message.params;
        if (agent.sideChats.has(threadId) && nativeSubscriptions.has(threadId) &&
          collaborationMode?.settings.developer_instructions === SIDE_CHAT_INSTRUCTIONS) {
          frameOut(JSON.stringify({ id: message.id, result: {} }));
        } else {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32602, message: "Missing side chat boundary" } }));
        }
        return;
      }
      if (name === "codex-native" && message.method === "turn/steer") {
        const { threadId, expectedTurnId, clientUserMessageId, input } = message.params;
        const turn = lastTurn(threadId);
        if (!turn || turn.id !== expectedTurnId || turn.status !== "inProgress" || !nativeSubscriptions.has(threadId)) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32600, message: "no active turn to steer" } }));
          return;
        }
        const item = { type: "userMessage" as const, id: crypto.randomUUID(), clientId: clientUserMessageId, content: input };
        (turn.steered ??= []).push(item);
        frameOut(JSON.stringify({ method: "item/completed", params: { threadId, turnId: turn.id, completedAtMs: 1050, item } }));
        frameOut(JSON.stringify({ id: message.id, result: { turnId: clientUserMessageId === "unknown-steer" ? "wrong-receipt" : turn.id } }));
        return;
      }
      if (name === "codex-native" && message.method === "turn/interrupt") {
        const { threadId, turnId } = message.params;
        const turn = lastTurn(threadId);
        const stream = nativeStreams.get(turnId);
        if (turn?.id !== turnId || turn.status !== "inProgress" || !stream) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32602, message: "Turn is not running" } }));
          return;
        }
        turn.status = "interrupted";
        stream.abort();
        frameOut(JSON.stringify({ method: "turn/completed", params: { threadId, turn } }));
        setTimeout(() => frameOut(JSON.stringify({ id: message.id, result: {} })), 50);
        return;
      }
      if (name === "codex-native" && message.method === "turn/start") {
        const { threadId, clientUserMessageId, input } = message.params;
        if (agent.sideChats.has(threadId) &&
          message.params.collaborationMode?.settings.developer_instructions !== SIDE_CHAT_INSTRUCTIONS) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32602, message: "Side chat policy missing from Turn" } }));
          return;
        }
        const turn: EngineTurn = { id: crypto.randomUUID(), status: "inProgress", inputId: clientUserMessageId };
        const abort = new AbortController();
        nativeStreams.set(turn.id, abort);
        agent.provisionalCodexThreads.delete(threadId);
        agent.turns.set(threadId, [...(agent.turns.get(threadId) ?? []), turn]);
        if (this.holdNextCodexTurnReply) {
          this.holdNextCodexTurnReply = false;
          return;
        }
        const notify = (method: string, params: object) => {
          if (nativeSubscriptions.has(threadId)) frameOut(JSON.stringify({ method, params }));
        };
        notify("turn/started", { threadId, turn });
        frameOut(JSON.stringify({ id: message.id, result: { turn } }));
        if (input.some((item: { text: string }) => item.text === "test-native-approval")) {
          const id = `approval:${turn.id}`;
          pendingApprovals.set(id, { threadId, turn, lane: nativeLane });
          frameOut(JSON.stringify({ id, method: "item/commandExecution/requestApproval",
            params: { threadId: "foreign-thread", turnId: turn.id, itemId: "foreign-approval" } }));
          offerApproval(id, threadId, turn.id);
          return;
        }
        const stream = async () => {
          try {
            const origin = instance.options.env?.OPENCRAFT_CODEX_EGRESS_ORIGIN;
            const provider = instance.options.env?.OPENCRAFT_CODEX_EGRESS_PROVIDER;
            const intercept = this.#modelEgress;
            if (!origin || !provider || !intercept || new URL(origin).hostname !== intercept.host)
              throw new Error("No model intercept");
            const response = await intercept.entry.fetch(new Request(
              new URL("/__opencraft_egress/" + encodeURIComponent(provider) + "/responses", origin),
              { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer container-token" },
                signal: abort.signal, body: JSON.stringify({ model: "m", input, stream: true }) },
            ));
            if (!response.ok || !response.body) throw new Error("Invalid model response");
            const reader = response.body.getReader();
            if (abort.signal.aborted) return void await reader.cancel();
            abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
            const utf8 = new TextDecoder();
            let partial = "";
            const itemId = `command:${turn.id}`;
            const itemScope = { threadId, turnId: turn.id };
            const command = {
              type: "commandExecution", id: itemId, command: "printf fixture", cwd: "/workspace",
              source: "agent", status: "inProgress", processId: "native-pty",
              commandActions: [{ type: "unknown", command: "printf fixture" }],
            };
            if (clientUserMessageId === "once") {
              notify("item/started", { ...itemScope, threadId: "foreign-thread", startedAtMs: 1000, item: command });
              notify("item/started", { ...itemScope, startedAtMs: 1000, item: command });
              notify("item/commandExecution/outputDelta", { ...itemScope, turnId: "foreign-turn", itemId, delta: "foreign" });
              notify("item/commandExecution/outputDelta", { ...itemScope, itemId, delta: "fixture output\n" });
              const reasoning = { ...itemScope, itemId: "reasoning", delta: "Checking workspace" };
              notify("item/reasoning/summaryTextDelta", { ...reasoning, summaryIndex: 1_000_000 });
              notify("item/reasoning/summaryTextDelta", { ...reasoning, summaryIndex: 0 });
              const plan = { ...itemScope, explanation: null, plan: [{ step: "Check workspace", status: "completed" }] };
              notify("turn/plan/updated", { ...plan, turnId: "foreign-turn" });
              notify("turn/plan/updated", plan);
              const patch = { ...itemScope, itemId: "file-change", changes: [
                { path: "result.txt", kind: { type: "add" }, diff: "+updated\n" },
              ] };
              notify("item/fileChange/patchUpdated", { ...patch, threadId: "foreign-thread" });
              notify("item/fileChange/patchUpdated", patch);
              const usage = { inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
                outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 12 };
              notify("thread/tokenUsage/updated", { ...itemScope, tokenUsage: { last: usage, total: usage, modelContextWindow: 4096 } });
            }
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              partial += utf8.decode(chunk.value, { stream: true });
              let at: number;
              while ((at = partial.indexOf("\n\n")) >= 0) {
                const event = partial.slice(0, at);
                partial = partial.slice(at + 2);
                const data = event.split("\n").find((line) => line.startsWith("data: "));
                if (!data) continue;
                const value = JSON.parse(data.slice(6));
                if (value.type === "response.output_text.delta") {
                  notify("item/agentMessage/delta", { threadId: "foreign-thread", turnId: turn.id, itemId: "message", delta: "foreign" });
                  notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "message", delta: value.delta });
                }
              }
            }
            if (!abort.signal.aborted) {
              if (clientUserMessageId === "once") notify("item/completed", {
                ...itemScope, completedAtMs: 1100,
                item: { ...command, status: "completed", aggregatedOutput: "fixture output\n", exitCode: 0, durationMs: 100 },
              });
              turn.status = "completed";
            }
          } catch {
            if (!abort.signal.aborted) turn.status = "failed";
          } finally {
            nativeStreams.delete(turn.id);
            if (!abort.signal.aborted) notify("turn/completed", { threadId, turn });
          }
        };
        void stream().catch(() => {});
        return;
      }
      const turnsOf = (threadId: string) => agent.turns.get(threadId) ?? [];
      if (name === "codex-native" && ["thread/turns/list", "thread/items/list"].includes(message.method)) {
        const { threadId, turnId, limit, cursor, sortDirection, itemsView } = message.params;
        const turns = message.method === "thread/turns/list";
        if (agent.provisionalCodexThreads.has(threadId)) {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32600,
            message: `thread ${threadId} is not materialized yet; ${message.method} is unavailable before first user message` } }));
          return;
        }
        if (!turns && agent.codexHistoryModes.get(threadId) !== "paginated") {
          frameOut(JSON.stringify({ id: message.id, error: { code: -32601, message: "thread/items/list is not supported yet" } }));
          return;
        }
        const items = (turn: EngineTurn) => [...(turn.inputId ? [{ id: "user-" + turn.id, type: "userMessage",
          clientId: turn.inputId }] : []), ...(turn.steered ?? [])];
        const all = turns ? turnsOf(threadId).map(turn => ({ id: turn.id, status: turn.status, itemsView,
          items: itemsView === "notLoaded" ? [] : items(turn) }))
          : turnsOf(threadId).filter(turn => turnId === undefined || turn.id === turnId)
            .flatMap(turn => items(turn).map(item => ({ turnId: turn.id, item })));
        if (sortDirection === "desc") all.reverse();
        const offset = cursor === null ? 0 : Number(cursor);
        const data = all.slice(offset, offset + limit);
        if (this.oversizedNextCodexPage) {
          this.oversizedNextCodexPage = false;
          const header = new Uint8Array(10);
          header.set([0x81, 127]);
          new DataView(header.buffer).setBigUint64(2, BigInt(4 * 1024 * 1024 + 1));
          peer.send(header);
          return;
        }
        frameOut(JSON.stringify({ id: message.id, result: {
          data, nextCursor: offset + limit < all.length ? String(offset + limit) : null,
          backwardsCursor: data.length ? String(offset) : null,
        } }));
        return;
      }
      const result =
        message.method === "initialize"
          ? { userAgent: name === "codex-native" ? "codex-double" : "engine-host-double" }
          : message.method === "model/list"
            ? { data: ["m", "not-configured"].map(model => ({ id: model, model, displayName: model,
                inputModalities: ["text"], isDefault: model === "m", supportedReasoningEfforts: [], defaultReasoningEffort: null })),
                nextCursor: null }
          : message.method === "thread/turns/list"
            ? { data: turnsOf(message.params.threadId).slice(-1).reverse() }
            : (message.method === "thread/read" || message.method === "thread/resume")
              ? {
                  ...(message.method === "thread/resume" ? codexThreadSettings : {}),
                  thread: {
                    id: message.params.threadId,
                    cwd: "/workspace",
                    ...agent.threadProjects.get(message.params.threadId),
                    name: agent.codexThreadNames.get(message.params.threadId),
                    historyMode: agent.codexHistoryModes.get(message.params.threadId),
                    forkedFromId: agent.forkOrigins.get(message.params.threadId) ?? null,
                    ephemeral: false,
                    status: { type: "idle" },
                    turns: (message.params.excludeTurns ? [] : turnsOf(message.params.threadId)).map((turn) => ({
                      id: turn.id,
                      status: turn.status,
                      items: [...(turn.inputId ? [{ type: "userMessage", clientId: turn.inputId }] : []), ...(turn.steered ?? [])],
                    })),
                  },
                }
              : undefined;
      const reply = JSON.stringify(
        result === undefined
          ? { id: message.id, error: { code: -32601, message: "missing" } }
          : { id: message.id, result },
      );
      if (name === "codex-native" && message.method === "thread/read" && this.#codexReadGate) {
        void this.#codexReadGate.promise.then(() => frameOut(reply)).catch(() => {});
      } else frameOut(reply);
    };
    const frames = () => {
      for (;;) {
        if (buffer.byteLength < 2) return;
        const opcode = buffer[0]! & 0x0f;
        let size = buffer[1]! & 0x7f,
          at = 2;
        if (size === 126) {
          size = (buffer[2]! << 8) | buffer[3]!;
          at = 4;
        }
        if (buffer.byteLength < at + 4 + size) return;
        const mask = buffer.slice(at, at + 4);
        const payload = buffer.slice(at + 4, at + 4 + size).map((byte, i) => byte ^ mask[i & 3]!);
        buffer = buffer.slice(at + 4 + size);
        if (opcode === 8) return peer.end();
        if (opcode === 1) rpc(decoder.decode(payload));
      }
    };
    return {
      data: (bytes) => {
        buffer = concat(buffer, bytes);
        if (socket) return frames();
        const text = decoder.decode(buffer);
        const headEnd = text.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const [requestLine, ...lines] = text.slice(0, headEnd).split("\r\n");
        const [method, target] = requestLine!.split(" ");
        const headers = new Map(
          lines.map((item) => [
            item.slice(0, item.indexOf(":")).trim().toLowerCase(),
            item.slice(item.indexOf(":") + 1).trim(),
          ]),
        );
        if (headers.get("upgrade")?.toLowerCase() === "websocket") {
          const url = new URL(target!, "http://engine.invalid");
          if (name === "codex-native") {
            if (url.pathname !== "/") return respond(400, { error: "invalid_native_endpoint" });
            nativeLane = url.searchParams.get("opencraftLane") ?? "";
            this.served.push(nativeLane ? `codex lane ${nativeLane}` : "codex one-shot connection");
          } else if (url.searchParams.get("token") !== agent.token)
            return respond(401, { error: "unauthorized" });
          socket = true;
          buffer = buffer.slice(encoder.encode(text.slice(0, headEnd + 4)).byteLength);
          void crypto.subtle
            .digest("SHA-1", encoder.encode(headers.get("sec-websocket-key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
            .then((digest) => {
              peer.send(
                encoder.encode(
                  `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${b64(new Uint8Array(digest))}\r\n\r\n`,
                ),
              );
              frames();
            });
          return;
        }
        const length = Number(headers.get("content-length") ?? 0);
        const bodyStart = encoder.encode(text.slice(0, headEnd + 4)).byteLength;
        if (buffer.byteLength < bodyStart + length) return;
        route(method!, target!, headers, decoder.decode(buffer.slice(bodyStart, bodyStart + length)));
      },
      end: () => peer.end(),
    };
  }
}

/** One double per Durable Object id, kept in module memory across object resets. */
const doubles = new Map<string, ContainerDouble>();
export function containerDouble(objectId: string): ContainerDouble {
  let double = doubles.get(objectId);
  if (!double) doubles.set(objectId, (double = new ContainerDouble()));
  return double;
}

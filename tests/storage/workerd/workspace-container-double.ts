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
}
/** Every input an Engine Host accepted, across incarnations (what the test asserts never repeats). */
export interface EngineInput {
  readonly agent: string;
  readonly threadId: string;
  readonly inputId: string;
  readonly text: string;
  readonly turnId: string;
}

interface Instance {
  readonly boot: string;
  readonly placement: string;
  readonly options: ContainerStartOptions;
  stopped: boolean;
  settle(outcome: { code: number } | { reason: unknown }): void;
  readonly monitor: Promise<void>;
  readonly execs: Set<{ stop(code: number): void; eof(): void }>;
  agent: { id: string; startedAt: string; token: string; turns: Map<string, EngineTurn[]>; next: number };
}

const newAgent = () => ({
  id: hex(16),
  startedAt: new Date().toISOString(),
  token: hex(24),
  turns: new Map<string, EngineTurn[]>(),
  next: 0,
});

export class ContainerDouble implements DurableObjectContainer {
  readonly images = Object.freeze({ workspace: "registry.example.test/opencraft-workspace@sha256:" + "0".repeat(64) });
  readonly starts: ContainerStartOptions[] = [];
  readonly timeouts: number[] = [];
  readonly inputs: EngineInput[] = [];
  destroys = 0;
  /** Engine Host routes and JSON-RPC methods served, in order (`GET /health`, `rpc thread/turns/list`, …). */
  readonly served: string[] = [];
  #current: Instance | undefined;
  #last: Instance | undefined;

  get running() {
    return !!this.#current && !this.#current.stopped;
  }
  get agent() {
    return this.#current?.agent.id;
  }

  start(options: ContainerStartOptions): void {
    if (this.running) throw new Error("Container is already running");
    if (!options.image || typeof options.enableInternet !== "boolean") throw new RangeError("Invalid start options");
    let settle!: Instance["settle"];
    const monitor = new Promise<void>((resolve, reject) => {
      settle = (outcome) => {
        if ("code" in outcome)
          outcome.code === 0
            ? resolve()
            : reject(
                Object.assign(new Error(`Container exited with code ${outcome.code}`), { exitCode: outcome.code }),
              );
        else outcome.reason === undefined ? resolve() : reject(outcome.reason);
      };
    });
    void monitor.catch(() => {});
    this.starts.push(options);
    this.#current = this.#last = {
      boot: crypto.randomUUID(),
      placement: hex(16),
      options,
      stopped: false,
      settle,
      monitor,
      execs: new Set(),
      agent: newAgent(),
    };
  }
  async inspect(): Promise<ContainerInfo | null> {
    const current = this.#current;
    return current && !current.stopped ? { image: current.options.image, labels: { ...current.options.labels } } : null;
  }
  monitor(): Promise<void> {
    const instance = this.#current ?? this.#last;
    if (!instance) throw new Error("This Durable Object has no container");
    return instance.monitor;
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
  #stop(instance: Instance, outcome: { code: number } | { reason: unknown }) {
    instance.stopped = true;
    for (const exec of [...instance.execs]) exec.stop(137);
    instance.settle(outcome);
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
    if (name === "pi") return (peer) => this.#engineHost(instance, peer);
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
        const answer =
          request.type === "probe"
            ? {
                protocol: 1,
                type: "healthy",
                state: "ready",
                roles: ["workspace"],
                incarnation: { id: agent.id, evidence: `double:${instance.boot}`, startedAt: agent.startedAt },
                endpoints: ["control", "pi"],
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
              : { protocol: 1, type: "error" };
        peer.send(encoder.encode(JSON.stringify(answer) + "\n"));
        peer.end();
      },
      end: () => peer.end(),
    };
  }

  /** The Engine Host on its private socket: control routes over HTTP/1.1, App Server JSON-RPC over WebSocket. */
  #engineHost(instance: Instance, peer: Peer): Owner {
    const agent = instance.agent;
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
      this.served.push(`${method} ${url.pathname}`);
      if (headers.get("authorization") !== `Bearer ${agent.token}`) return respond(401, { error: "unauthorized" });
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
    const rpc = (text: string) => {
      const message = JSON.parse(text);
      if (message.id === undefined) return;
      this.served.push(`rpc ${message.method}`);
      const turnsOf = (threadId: string) => agent.turns.get(threadId) ?? [];
      const result =
        message.method === "initialize"
          ? { userAgent: "engine-host-double" }
          : message.method === "thread/turns/list"
            ? { data: turnsOf(message.params.threadId).slice(-1).reverse() }
            : message.method === "thread/read"
              ? {
                  thread: {
                    id: message.params.threadId,
                    turns: turnsOf(message.params.threadId).map((turn) => ({
                      id: turn.id,
                      status: turn.status,
                      items: turn.inputId ? [{ type: "userMessage", clientId: turn.inputId }] : [],
                    })),
                  },
                }
              : undefined;
      frameOut(
        JSON.stringify(
          result === undefined
            ? { id: message.id, error: { code: -32601, message: "missing" } }
            : { id: message.id, result },
        ),
      );
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
          if (url.searchParams.get("token") !== agent.token) return respond(401, { error: "unauthorized" });
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

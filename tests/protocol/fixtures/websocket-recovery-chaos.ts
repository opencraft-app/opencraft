import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { setTimeout as realDelay } from "node:timers/promises";
import WebSocket from "ws";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import type { AppServerClient, DuplexTransport } from "@opencraft/appserver-client";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createConversationKey } from "@opencraft/chat-core";
import { createConversationOutbox, type ConversationOutboxEntry } from "@opencraft/chat-runtime";
import {
  connectWebSocketAppHost,
  type AppHostRecoveryEvents,
} from "../../../apps/workbench-web/src/runtime/websocket-app-host";
import { createWorkbenchWebServer } from "../../../scripts/serve-workbench-web.mjs";
import { ChaosViolation, requireThat, recoveryChaosRandom } from "./recovery-chaos";

type Tab = "a" | "b";
type Boundary = "ready" | "resumed" | "initialize" | "answer";
export type WebSocketRecoveryEvent =
  | { type: "cut" | "forget" | "late" | "input" | "output"; tab: Tab }
  | { type: "offline" | "blackhole"; tab: Tab; enabled: boolean }
  | { type: "hold"; tab: Tab; boundary: Boundary; enabled: boolean }
  | { type: "visible"; tab: Tab; value: boolean }
  | { type: "tick"; ms: number }
  | { type: "heal" };
export type WebSocketRecoveryMutant = "replay-input" | "stuck-route";

export function parseWebSocketRecoveryTrace(value: unknown): WebSocketRecoveryEvent[] {
  requireThat(
    Array.isArray(value) && value.length <= 10_000,
    "TRACE_SCHEMA",
    "expected at most 10000 WebSocket recovery events",
  );
  for (const event of value) {
    requireThat(event && typeof event === "object", "TRACE_SCHEMA", "invalid event");
    const e = event as Record<string, unknown>;
    requireThat(
      ["cut", "forget", "late", "input", "output", "offline", "blackhole", "hold", "visible", "tick", "heal"].includes(
        String(e.type),
      ),
      "TRACE_SCHEMA",
      "unknown WebSocket recovery event",
    );
    if (e.type !== "tick" && e.type !== "heal")
      requireThat(e.tab === "a" || e.tab === "b", "TRACE_SCHEMA", "invalid tab");
    if (e.type === "tick")
      requireThat(
        Number.isSafeInteger(e.ms) && (e.ms as number) >= 0 && (e.ms as number) <= 120_000,
        "TRACE_SCHEMA",
        "invalid elapsed time",
      );
    if (["offline", "blackhole", "hold"].includes(String(e.type)))
      requireThat(typeof e.enabled === "boolean", "TRACE_SCHEMA", "invalid gate");
    if (e.type === "hold")
      requireThat(
        ["ready", "resumed", "initialize", "answer"].includes(String(e.boundary)),
        "TRACE_SCHEMA",
        "invalid boundary",
      );
    if (e.type === "visible") requireThat(typeof e.value === "boolean", "TRACE_SCHEMA", "invalid visibility");
  }
  return value as WebSocketRecoveryEvent[];
}

export function generateWebSocketRecoveryChaos(seed: number, steps = 120): WebSocketRecoveryEvent[] {
  const random = recoveryChaosRandom(seed),
    pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  const result: WebSocketRecoveryEvent[] = [];
  for (let i = 0; i < steps; i++) {
    const tab = pick(["a", "b"] as const),
      type = pick([
        "cut",
        "forget",
        "late",
        "input",
        "output",
        "offline",
        "blackhole",
        "hold",
        "visible",
        "tick",
      ] as const);
    if (type === "tick") result.push({ type, ms: pick([0, 500, 5_000, 10_001, 31_000]) });
    else if (type === "hold")
      result.push({
        type,
        tab,
        boundary: pick(["ready", "resumed", "initialize", "answer"] as const),
        enabled: random() < 0.6,
      });
    else if (type === "visible") result.push({ type, tab, value: random() < 0.6 });
    else if (type === "offline" || type === "blackhole") result.push({ type, tab, enabled: random() < 0.6 });
    else result.push({ type, tab });
    if (i % 16 === 15) result.push({ type: "heal" });
  }
  return result;
}

class PageEvents implements AppHostRecoveryEvents {
  visible = true;
  readonly listeners = new Set<(reason?: string) => void>();
  isVisible = () => this.visible;
  subscribe(fn: (reason?: string) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  fire() {
    for (const fn of [...this.listeners]) fn("pageshow");
  }
}
interface Gate {
  offline: boolean;
  blackhole: boolean;
  holds: Set<Boundary>;
}
type Frame = Record<string, any>;
interface Connection {
  tab: Tab;
  closed: boolean;
  port: { postMessage(frame: unknown): void; close(): void };
  claims: Map<string, number>;
}

/** Only the network/engine boundary is synthetic. TCP/WebSocket upgrade, server
 * ResumeRegistry, browser Port, logical leases, AppServerClient, Workbench retry
 * owner and Outbox are production implementations. Old callbacks can be delivered
 * AFTER close, as if already queued in a suspended browser's event loop. */
class FaultSocket {
  readonly raw: WebSocket;
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly held: Array<() => void> = [];
  readonly requests = new Map<string | number, string>();
  constructor(
    url: string,
    readonly tab: Tab,
    readonly gate: Gate,
    readonly rendererTabs: Map<string, Tab>,
    readonly cover: (name: string) => void,
  ) {
    this.raw = new WebSocket(url);
    this.raw.on("open", () => this.emit("open", {}));
    this.raw.on("close", (code) => this.emit("close", { code, wasClean: code === 1000 }));
    this.raw.on("error", () => this.emit("error", {}));
    this.raw.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      const boundary: Boundary | undefined =
        frame.type === "ready"
          ? "ready"
          : frame.type === "connection/resumed"
            ? "resumed"
            : frame.type === "host/frame" && JSON.parse(frame.frame).id !== undefined
              ? this.requests.get(JSON.parse(frame.frame).id) === "initialize"
                ? "initialize"
                : "answer"
              : undefined;
      if (gate.offline || gate.blackhole) {
        cover("dropped-incoming");
        return;
      }
      const callbacks = [...(this.listeners.get("message") ?? [])];
      const deliver = () => {
        for (const fn of callbacks) fn({ data: String(data) });
      };
      if (boundary && gate.holds.has(boundary)) {
        this.held.push(deliver);
        cover(`held:${boundary}`);
      } else deliver();
    });
  }
  get readyState() {
    return this.raw.readyState;
  }
  get bufferedAmount() {
    return this.raw.bufferedAmount;
  }
  addEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  send(data: string) {
    const frame = JSON.parse(data) as Frame;
    if (frame.type === "hello") this.rendererTabs.set(frame.rendererId, this.tab);
    if (frame.type === "host/send") {
      const request = JSON.parse(frame.frame);
      if (request.id !== undefined) this.requests.set(request.id, request.method);
    }
    if (this.gate.offline || this.gate.blackhole) {
      this.cover("dropped-outgoing");
      return;
    }
    this.raw.send(data);
  }
  close() {
    this.raw.close();
  }
  late() {
    for (const deliver of this.held.splice(0)) {
      this.cover("late-frame");
      deliver();
    }
    // Delayed terminal callbacks from a replaced physical route must be fenced.
    if (this.raw.readyState === WebSocket.CLOSED) {
      this.emit("error", {});
      this.emit("close", { code: 1006, wasClean: false });
    }
  }
}

/** Single-process runner: owns/restores global browser location and virtual
 * Date/timers. Do not run cases concurrently in the same JS isolate. Advancing
 * time drains real loopback I/O between ticks; no production endpoints are used. */
export async function simulateWebSocketRecovery(
  events: readonly WebSocketRecoveryEvent[],
  options: { mutant?: WebSocketRecoveryMutant } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "websocket-chaos-"));
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const coverage: Record<string, number> = {},
    cover = (name: string) => {
      coverage[name] = (coverage[name] ?? 0) + 1;
    };
  const connections: Connection[] = [],
    rendererTabs = new Map<string, Tab>();
  const diagnostics: Array<{ at: number; event: string; reason?: string; tab?: Tab }> = [];
  const intents = new Map<string, { tab: Tab; sends: number }>();
  const applied = new Map<string, number>();
  const tabs = {} as Record<
    Tab,
    {
      gate: Gate;
      page: PageEvents;
      sockets: FaultSocket[];
      factory: ReturnType<typeof connectWebSocketAppHost>;
      runtime: ReturnType<typeof createAppServerWorkbenchRuntime>;
      client: AppServerClient | null;
      rows: readonly ConversationOutboxEntry[];
      box: ReturnType<typeof createConversationOutbox>;
      outputs: number[];
    }
  >;
  let sequence = 0,
    outputSequence = 0,
    wireError: unknown;
  const check = (ok: unknown, rule: string, detail: string) => {
    try {
      requireThat(ok, rule, detail);
    } catch (error) {
      wireError ??= error;
    }
  };
  const serverOptions = {
    root,
    appServerTarget: null,
    loopbackOnly: false,
    webSocketHeartbeatIntervalMs: 0,
    onAppHostDiagnostic: (event: Frame) => {
      cover(`server:${event.event}`);
      diagnostics.push({ at: Date.now(), event: event.event, ...(event.reason ? { reason: event.reason } : {}) });
    },
    appHostServer: {
      accept(port: Connection["port"] & { subscribe(fn: (frame: Frame) => void): () => void }, rendererId: string) {
        const tab = rendererTabs.get(rendererId)!;
        check(tab === "a" || tab === "b", "TAB_IDENTITY", "server accepted an unknown renderer");
        const connection: Connection = { tab, closed: false, port, claims: new Map() };
        connections.push(connection);
        port.subscribe((frame) => {
          if (frame.type === "host/connect") {
            connection.claims.set(frame.hostId, connections.length);
            port.postMessage({
              type: "response",
              requestId: frame.requestId,
              ok: true,
              result: { hostId: frame.hostId, generation: connections.length },
            });
          } else if (frame.type === "host/send") {
            const request = JSON.parse(frame.frame);
            port.postMessage({ type: "response", requestId: frame.requestId, ok: true, result: null });
            if (request.id === undefined) return;
            let result: unknown = null;
            if (request.method === "initialize") {
              cover("native:initialize");
              result = {
                codexHome: "/synthetic",
                platformFamily: "unix",
                platformOs: "linux",
                userAgent: "websocket-chaos",
              };
            } else if (request.method === "turn/start") {
              const intent = intents.get(request.params.clientUserMessageId);
              check(intent && intent.tab === tab, "INPUT_IDENTITY", "unknown/cross-tab input");
              if (intent) {
                intent.sends++;
                applied.set(request.params.clientUserMessageId, intent.sends);
                check(intent.sends === 1, "INPUT_ONCE", "an ambiguous user write was replayed");
                cover("native:input");
              }
              result = { turn: { id: `turn-${request.params.clientUserMessageId}` } };
            } else if (request.method.endsWith("/list")) result = { data: [], nextCursor: null };
            else if (request.method === "chaos/probe") {
              if (options.mutant === "stuck-route") return;
              result = { tab };
            }
            port.postMessage({
              type: "host/frame",
              hostId: frame.hostId,
              generation: frame.generation,
              frame: JSON.stringify({ id: request.id, result }),
            });
          } else if (frame.requestId)
            port.postMessage({ type: "response", requestId: frame.requestId, ok: true, result: null });
        });
        port.postMessage({
          type: "ready",
          protocolVersion: APP_HOST_PROTOCOL_VERSION,
          services: ["appserver"],
          capabilities: { connectionProbe: true },
        });
        return {
          close() {
            connection.closed = true;
          },
        };
      },
    },
  };
  const server = await createWorkbenchWebServer(serverOptions);
  const address = (await server.listen({ host: "127.0.0.1", port: 0 })) as { port: number };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: `http://127.0.0.1:${address.port}/` } },
  });
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  // Event-loop quiescence is not simulated: let ws and loopback TCP finish.
  const flush = async () => {
    for (let i = 0; i < 3; i++) await realDelay(1);
    if (wireError) throw wireError;
  };
  const advance = async (ms: number) => {
    for (let left = ms; left > 0;) {
      const step = Math.min(left, 1_000);
      mock.timers.tick(step);
      await flush();
      left -= step;
    }
    await flush();
  };
  const until = async (predicate: () => boolean, rule: string, detail: string, budget = 75_000) => {
    for (let elapsed = 0; !predicate() && elapsed < budget; elapsed += 1_000) await advance(1_000);
    requireThat(
      predicate(),
      rule,
      `${detail}; phases=${JSON.stringify(Object.fromEntries(Object.entries(tabs).map(([id, t]) => [id, { phase: t.runtime.getSnapshot().phase, recovery: t.runtime.getSnapshot().recovery }])))}; recent=${JSON.stringify(diagnostics.slice(-8))}`,
    );
  };
  const latest = (tab: Tab) => connections.filter((c) => c.tab === tab && !c.closed).at(-1);
  const sendOutput = (tab: Tab) => {
    const connection = latest(tab);
    if (!connection) return;
    const i = ++outputSequence;
    for (const [hostId, generation] of connection.claims)
      connection.port.postMessage({
        type: "host/frame",
        hostId,
        generation,
        frame: JSON.stringify({ method: "chaos/output", params: { i, tab } }),
      });
  };
  const observe = () => {
    for (const tab of ["a", "b"] as const) {
      const t = tabs[tab];
      requireThat(
        new Set(t.outputs).size === t.outputs.length && t.outputs.every((n, i) => !i || n > t.outputs[i - 1]!),
        "OUTPUT_ONCE_ORDERED",
        "resumed output was duplicated/reordered",
      );
    }
    for (const [id, intent] of intents) {
      requireThat(intent.sends <= 1, "INPUT_ONCE", `${id} was applied more than once`);
      requireThat(
        intent.sends > 0 || tabs[intent.tab].rows.some((row) => row.intent.clientMessageId === id),
        "INPUT_CUSTODY",
        `${id} was lost before wire admission`,
      );
    }
  };
  const heal = async () => {
    cover("heal");
    for (const t of Object.values(tabs)) {
      t.gate.offline = false;
      t.gate.blackhole = false;
      t.gate.holds.clear();
      t.page.visible = true;
      t.page.fire();
    }
    // First let healthy newer frames proceed, THEN inject callbacks from old routes.
    await advance(1_000);
    for (const t of Object.values(tabs)) for (const socket of t.sockets) socket.late();
    await until(
      () => Object.values(tabs).every((t) => t.runtime.getSnapshot().phase === "ready"),
      "EVENTUAL_RECOVERY",
      "healthy route did not become ready",
    );
    for (const tab of ["a", "b"] as const) {
      const t = tabs[tab];
      let done = false,
        pending = false;
      const probe = () => {
        if (done || pending || t.runtime.getSnapshot().phase !== "ready") return;
        pending = true;
        void t
          .client!.requestRaw("chaos/probe", {})
          .then(
            (result) => {
              check((result as { tab: Tab }).tab === tab, "TAB_IDENTITY", "probe crossed tabs");
              done = true;
            },
            () => {},
          )
          .finally(() => {
            pending = false;
          });
      };
      probe();
      // A transparent resume can still report logical ready. A failed read is
      // retryable on a NEW generation; user writes below never use this loop.
      const stop = t.runtime.subscribe(probe);
      try {
        for (let elapsed = 0; !done && elapsed < 75_000; elapsed += 1_000) {
          await advance(1_000);
          probe();
        }
      } finally {
        stop();
      }
      await until(() => done, "ROUTE_USABLE", `tab ${tab} reported ready but cannot round-trip`, 0);
      const before = t.outputs.length;
      sendOutput(tab);
      await until(() => t.outputs.length > before, "OUTPUT_RECOVERY", "healed output never arrived");
    }
    observe();
  };
  try {
    for (const tab of ["a", "b"] as const) {
      const gate: Gate = { offline: false, blackhole: false, holds: new Set() },
        page = new PageEvents(),
        sockets: FaultSocket[] = [];
      const factory = connectWebSocketAppHost(
        (url) => {
          if (gate.offline) {
            cover("offline-dial");
            throw Error("synthetic offline");
          }
          const socket = new FaultSocket(url, tab, gate, rendererTabs, cover);
          sockets.push(socket);
          cover("socket-created");
          return socket as unknown as globalThis.WebSocket;
        },
        {
          recoveryEvents: page,
          retryDelaysMs: [500],
          handshakeTimeoutMs: 10_000,
          reportFailure: (d) => {
            cover(`client:${d.failure}`);
            diagnostics.push({ at: Date.now(), tab, event: d.failure });
          },
        },
      );
      const outputs: number[] = [];
      const runtime = createAppServerWorkbenchRuntime({
        hostId: "h",
        autoReconnect: true,
        reconnectDelaysMs: [500],
        requestTimeoutMs: 10_000,
        onRecoveryEvent: (event) => {
          cover(`runtime:${event.stage}`);
        },
        clock: {
          now: () => Date.now(),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
        },
        createTransport: () => {
          const transport: DuplexTransport = factory.createTransport("h");
          transport.subscribeMessage((data) => {
            const frame = JSON.parse(data);
            if (frame.method === "chaos/output") {
              check(frame.params.tab === tab, "TAB_IDENTITY", "output crossed tabs");
              outputs.push(frame.params.i);
            }
          });
          return transport;
        },
        installClientHandlers(client) {
          tabs[tab].client = client;
          return () => {};
        },
      });
      const key = createConversationKey("h", `thread-${tab}`);
      let storedRows: readonly ConversationOutboxEntry[] = [];
      const box = createConversationOutbox({
        key,
        ready: () => runtime.getSnapshot().phase === "ready",
        blocked: () => false,
        publish() {},
        retire() {},
        storage: {
          read: () => storedRows,
          write: (_key, rows) => {
            storedRows = structuredClone(rows);
          },
          subscribe: () => () => {},
        },
        async send(intent) {
          await tabs[tab].client!.requestRaw("turn/start", { clientUserMessageId: intent.clientMessageId });
          if (options.mutant === "replay-input")
            await tabs[tab].client!.requestRaw("turn/start", { clientUserMessageId: intent.clientMessageId });
          return {
            commandId: intent.commandId,
            clientMessageId: intent.clientMessageId,
            hostId: "h",
            threadId: key.threadId,
            turnId: null,
            acceptedAt: Date.now(),
            replayed: false,
          };
        },
      });
      tabs[tab] = {
        gate,
        page,
        sockets,
        factory,
        runtime,
        client: null,
        get rows() {
          return storedRows;
        },
        box,
        outputs,
      };
      runtime.subscribe(() => {
        box.wake();
      });
      void runtime.connect().catch(() => {});
    }
    await until(
      () => Object.values(tabs).every((t) => t.runtime.getSnapshot().phase === "ready"),
      "HARNESS_SETUP",
      "initial loopback connection failed",
    );
    for (const event of events) {
      cover(event.type);
      if (event.type === "tick") await advance(event.ms);
      else if (event.type === "heal") await heal();
      else {
        const t = tabs[event.tab];
        if (event.type === "cut") t.sockets.at(-1)?.raw.terminate();
        else if (event.type === "offline") {
          t.gate.offline = event.enabled;
          if (event.enabled) {
            for (const s of t.sockets) if (s.raw.readyState !== WebSocket.CLOSED) s.raw.terminate();
          } else t.page.fire();
        } else if (event.type === "blackhole") t.gate.blackhole = event.enabled;
        else if (event.type === "visible") {
          t.page.visible = event.value;
          t.page.fire();
        } else if (event.type === "hold") {
          if (event.enabled) t.gate.holds.add(event.boundary);
          else t.gate.holds.delete(event.boundary);
        } else if (event.type === "late") {
          for (const s of t.sockets) s.late();
        } else if (event.type === "forget") {
          for (const c of connections) if (c.tab === event.tab && !c.closed) c.port.close();
        } else if (event.type === "output") sendOutput(event.tab);
        else if (event.type === "input") {
          const id = `intent-${++sequence}`;
          intents.set(id, { tab: event.tab, sends: 0 });
          await t.box.admit({
            commandId: id,
            clientMessageId: id,
            target: { type: "existing-thread", key: createConversationKey("h", `thread-${event.tab}`) },
            document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: id }] }] },
            attachments: [],
            context: [],
            selections: {},
            options: { autoContext: false },
            createdAt: Date.now(),
          });
        }
        await flush();
      }
      observe();
    }
    await heal();
    return {
      events: events.length,
      wires: Object.values(tabs).reduce((n, t) => n + t.sockets.length, 0),
      ready: 2,
      coverage,
      inputs: {
        admitted: intents.size,
        applied: applied.size,
        retained: Object.values(tabs).reduce((n, t) => n + t.rows.length, 0),
      },
      outputs: { a: [...tabs.a.outputs], b: [...tabs.b.outputs] },
      diagnostics,
    };
  } catch (error) {
    if (error instanceof ChaosViolation)
      error.evidence = {
        at: Date.now(),
        coverage: { ...coverage },
        recent: diagnostics.slice(-50),
        tabs: Object.fromEntries(
          Object.entries(tabs).map(([tab, t]) => [
            tab,
            {
              phase: t.runtime.getSnapshot().phase,
              recovery: t.runtime.getSnapshot().recovery,
              transport: t.runtime.getSnapshot().transport.state,
              sockets: t.sockets.map((s) => ({ state: s.readyState, held: s.held.length })),
              inputs: t.rows.map((row) => ({ id: row.intent.clientMessageId, state: row.state })),
            },
          ]),
        ),
      };
    throw error;
  } finally {
    try {
      const cleanup = Object.values(tabs).map((t) => {
        t.box.dispose();
        const disposed = t.runtime.dispose();
        t.factory.close();
        for (const s of t.sockets) if (s.raw.readyState !== WebSocket.CLOSED) s.raw.terminate();
        return disposed;
      });
      await Promise.all(cleanup);
      await server.close();
    } finally {
      mock.timers.reset();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      await rm(root, { recursive: true, force: true });
    }
  }
}

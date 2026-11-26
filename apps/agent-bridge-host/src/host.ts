import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  createSandbox,
  createSandboxPool,
  type SandboxBackend,
  type SandboxPoolPolicy,
  type SandboxPool,
  SandboxCreationFault,
} from "@opencraft/sandbox";
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_GRAMMAR_RANGE,
  BRIDGE_MAX_COMMAND_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  isBridgeCommand,
  assertMethodAllowed,
  negotiateHandshake,
  type BridgeInitializeResult,
  type BridgeWireMessage,
} from "@opencraft/agent-bridge-protocol";
import { Storage, StorageRefusal } from "./storage.js";
import { Peer, successful } from "./peer.js";
import { object, identifier, isArchiveCommand, oversizedBridgeRequest, routeKey, type BridgeHistorySelection, type Command, type Generation, type Receipt } from "./types.js";
import { HostQueue } from "./queue.js";
const CODEX_RECONNECT_DELAY_MS = 1_000;
class CodexAttachmentUnavailable extends Error {
  constructor() {
    super("Codex provider attachment is unavailable");
  }
}
/** Error kinds that are definitive refusals before any native write. */
const REFUSED_BRIDGE_ERRORS = new Set([
  "auth",
  "explicit-reject",
  "frame-too-large",
  "invalid",
  "quota",
  "stale-target",
  "unsupported",
]);
/** Deterministic object encoding makes the digest independent of JSON key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function hostRefusal(command: Command, message: string): Error & { code: number; kind: string; commandId: string } {
  return Object.assign(Error(message), { code: -32602, kind: "invalid", commandId: command.commandId });
}

/**
 * A typed provider error that deterministically refuses the command means the
 * native mutation was not performed. Only an ambiguous transport/timeout or
 * an explicit `unknown-outcome` keeps custody unknown; treating stale/invalid
 * refusals as unknown would block Thread release forever.
 */
export function dispatchSettlement(response: BridgeWireMessage): Receipt["state"] {
  if (successful(response)) return "accepted";
  if ("error" in response) return REFUSED_BRIDGE_ERRORS.has(response.error.kind) ? "rejected" : "unknown";
  return "unknown";
}

export interface ExecutionCliLease {
  environment: Readonly<Record<string, string>>;
  revoke(): Promise<void>;
  rejectBeforeStart?(): Promise<ExecutionCliLease>;
}
/** Configured by trusted Server/Host composition, never by command arguments. */
export interface ExecutionCliPort {
  reserve?(scope: { serverId: string; threadId: string }): Promise<ExecutionCliLease>;
  forward?(token: string, body: unknown): Promise<{ status: number; body: unknown }>;
  issue(source: { serverId: string; threadId: string; credential: string }): Promise<ExecutionCliLease>;
}
export interface HostOptions {
  automation?: { hostId: string; environment: string };
  executionCli?: ExecutionCliPort;
  path: string;
  policy: SandboxPoolPolicy;
  backend: SandboxBackend;
  maxSpoolBytes?: number;
  requestTimeoutMs?: number;
  startup?: {
    generations?: readonly Generation[];
    activate?: string;
    cutoverCodex?: boolean;
  };
}
interface PendingCliIssue {
  readonly commandId: string;
  cancelled?: "stop" | "session-ended";
  failedCleanup?: ExecutionCliLease;
}
export class BridgeHost {
  private readonly cliGenerations = new Map<string, string>();
  private readonly cliPending = new Map<string, PendingCliIssue>();
  private readonly cliClosedTurns = new Map<string, string>();
  private readonly cliReservations = new Map<string, { generation: string; lease: ExecutionCliLease }>();
  private readonly cliStarts = new Map<string, { observed: boolean; commandId: string }>();
  private readonly cliLeases = new Map<string, ExecutionCliLease>();
  private readonly cliRevocations = new WeakMap<ExecutionCliLease, { pending?: Promise<void> }>();
  private storage: Storage;
  private pool!: SandboxPool;
  private diagnosticPeers = new Map<string, Peer>();
  private peers = new Map<string, Promise<Peer>>();
  private readonly reconnectAfter = new Map<string, number>();
  private capabilities = new Map<string, BridgeInitializeResult["effectiveCapabilities"]>();
  private admissions = new Set<Promise<Receipt>>();
  private tasks = new Set<Promise<void>>();
  private closing = false;
  private retainedAfterCrash = new Set<string>();
  /** Native sessions a new provider process has not bound yet. */
  private readonly rebinding = new Set<string>();
  private readonly rebinds = new Map<string, { peer: Peer; operation: Promise<void> }>();
  /**
   * A provider that adopts released native sessions can also take back its own
   * recorded sessions after a Host restart: the native session outlived the
   * provider process. Others still require explicit native recovery.
   */
  private recoverable(id: string): boolean {
    return this.generations.get(id)?.provider.capabilities.adoption === true;
  }
  private generations = new Map<string, Generation>();
  /**
   * Generations every route has moved away from whose outbox still held
   * unacknowledged events at that moment. They are retired once an
   * acknowledgement drains them. Not durable: after a Host restart their
   * provider is never started again, so only the storage row stays.
   */
  private readonly draining = new Set<string>();
  readonly incarnation = randomUUID();
  readonly queue: HostQueue;
  private constructor(private options: HostOptions) {
    this.storage = new Storage(options.path, "host", () => {
      this.closing = true;
      if (this.pool) void this.pool.close().catch(() => {}); // retained cleanup promise is rechecked by close()
    });
    this.queue = new HostQueue(this.storage, {
      command: async (serverId, threadId, commandId, method, params) => {
        try {
          await this.accept({ commandId, serverId, threadId, method, params });
        } catch (error) {
          // Only a refusal from admission proves this attempt never reached dispatch.
          if (error instanceof Error && REFUSED_BRIDGE_ERRORS.has((error as Error & { kind?: string }).kind ?? ""))
            throw Object.assign(error, { settlement: "rejected" });
          throw error;
        }
        for (
          const deadline = Date.now() + 35_000;
          Date.now() < deadline;
          await new Promise((resolve) => setTimeout(resolve, 25))
        ) {
          const receipt = await this.query(commandId);
          if (receipt && ["accepted", "rejected", "unknown"].includes(receipt.state)) return receipt;
        }
        throw Error("Queued delivery outcome unknown");
      },
      history: (serverId, threadId, params) => this.observe({ serverId, threadId, method: "history/read", params }, true),
      canReconcile: async (route) => (await this.queueRoute(route)).queueActive,
      recover: (route) => this.recoverRoute(route),
      isIdle: async (route) => await this.storage.call<boolean>("routeIdle", { route, forQueue: true }) && !this.cliPending.has(route),
      dispatchable: async (route) => {
        const { generation, queueActive } = await this.queueRoute(route);
        return (
          !this.closing &&
          queueActive &&
          !!generation &&
          this.generations.has(generation) &&
          (!this.retainedAfterCrash.has(generation) || this.recoverable(generation))
        );
      },
    });
  }
  static async open(options: HostOptions): Promise<BridgeHost> {
    const host = new BridgeHost(options);
    try {
      await host.storage.ready;
      host.pool = await createSandboxPool(options.policy, options.backend);
      const snapshot = await host.storage.call("snapshot");
      for (const row of snapshot.generations) if (!row.retired) host.generations.set(row.id, row.config);
      for (const generation of options.startup?.generations ?? []) await host.add(generation);
      const target = options.startup?.activate;
      let routes = snapshot.routes;
      let activeRecovery: { peer: Peer; routes: string[] } | undefined;
      if (options.startup?.cutoverCodex) {
        const provider = target && host.generations.get(target)?.provider;
        if (!target || !provider || provider.providerId !== "codex" || !provider.capabilities.adoption)
          throw Error("Codex startup cutover requires a Codex generation that supports adoption");
        // No queue or API can start the old adapter. Probe the replacement first,
        // then switch all bindings before any command or history read is admitted.
        const peer = await host.peer(target);
        if (!host.capabilities.get(target)?.adoption)
          throw Error("Codex startup cutover requires negotiated adoption");
        const replacement = await host.storage.call("activate", { id: target, expected: snapshot.current, cutoverCodex: true });
        routes = replacement.routes;
        activeRecovery = { peer, routes: replacement.activeRoutes };
      } else if (target) {
        // Preserve the restart fence for other providers during their probe.
        for (const row of routes) host.retainedAfterCrash.add(row.generation);
        await host.activate(target, snapshot.current);
      }
      for (const row of routes) {
        host.retainedAfterCrash.add(row.generation);
        host.rebinding.add(row.route);
      }
      if (activeRecovery?.routes.length)
        host.restoreActiveCodex(activeRecovery.peer, activeRecovery.routes, snapshot.epoch);
      await host.queue.resume();
      return host;
    } catch (error) {
      if (host.pool) await host.close().catch(() => {});
      else await host.storage.close().catch(() => {});
      throw error;
    }
  }
  private restoreActiveCodex(peer: Peer, routes: readonly string[], epoch: number): void {
    const task = (async () => {
      for (const route of routes) {
        if (this.closing) return;
        // Try one at a time. A failed attachment stays in rebinding for the
        // next access (or queue reconciliation) to retry.
        await this.bound(peer, route, epoch).catch(() => undefined);
      }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }
  async add(config: Generation): Promise<void> {
    if (this.closing) throw Error("Host closing");
    config = structuredClone(config);
    identifier(config.id);
    identifier(config.digest);
    if (!/^[a-f0-9]{64}$/.test(config.digest) || !isAbsolute(config.artifact))
      throw Error("Absolute pinned bundle and SHA-256 required");
    const negotiation = negotiateHandshake(
      { protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE },
      config.provider,
    );
    if (!negotiation.ok) throw Error(negotiation.error.message);
    await this.storage.call("add", config);
    this.generations.set(config.id, config);
  }
  async activate(id: string, expected: string): Promise<void> {
    if (this.closing) throw Error("Host closing");
    await this.peer(id); // no new default until sandbox and negotiation succeeded
    await this.storage.call("activate", { id, expected });
  }
  private lostCodexAttachment(id: string, peer = this.diagnosticPeers.get(id)): boolean {
    const diagnostic = peer?.diagnostic();
    return (
      this.generations.get(id)?.provider.providerId === "codex" &&
      this.recoverable(id) &&
      diagnostic?.failed === true &&
      diagnostic.nativeFault === "codex-native-fault:unknown:connection"
    );
  }
  private peer(id: string): Promise<Peer> {
    const pending = this.peers.get(id);
    if (pending) {
      return pending.then((peer) => {
        if (!this.lostCodexAttachment(id, peer)) return peer;
        const current = this.peers.get(id);
        if (current && current !== pending) return current;
        if (this.closing || current !== pending || Date.now() < (this.reconnectAfter.get(id) ?? 0))
          throw new CodexAttachmentUnavailable();
        return this.openPeer(id, { peer, pending });
      });
    }
    return this.openPeer(id);
  }
  private openPeer(id: string, previous?: { peer: Peer; pending: Promise<Peer> }): Promise<Peer> {
    const config = this.generations.get(id);
    if (this.retainedAfterCrash.has(id) && !this.recoverable(id))
      return Promise.reject(
        Error("Retained generation requires explicit native recovery; automatic replacement refused"),
      );
    if (!config) return Promise.reject(Error("Pinned generation unavailable"));
    const launch = (async () => {
      if (previous) {
        // Drain the previous attachment before binding a new sandbox to the
        // independently owned native writer.
        await previous.peer.close();
        if (this.closing || this.generations.get(id) !== config) throw new CodexAttachmentUnavailable();
        const routes = await this.storage.call<string[]>("restorableRoutes", { generation: id });
        for (const route of routes) this.rebinding.add(route);
      }
      if (
        createHash("sha256")
          .update(await readFile(config.artifact))
          .digest("hex") !== config.digest ||
        !config.launch.command.includes(config.artifact)
      )
        throw Error("Pinned bridge artifact digest mismatch");
      const peer: Peer = new Peer(
        config,
        async (callbackId, method, params) => {
          await this.storage.call("callback", { generation: id, id: callbackId, method, params: object(params) });
          const p = object(params);
          const route = String(p.threadId);
          if (method === "thread/notification" && p.method === "thread/unarchived") this.queue.schedule(route);
          const deltas = method === "thread/delta" && Array.isArray(p.deltas) ? p.deltas : [];
          const sessionEnded = deltas.some(delta => delta.op === "session.ended");
          if (sessionEnded) await this.cancelPendingCliIssue(route, "session-ended");
          if (deltas.some(delta => delta.op === "turn.open")) {
            const start = this.cliStarts.get(route);
            if (start) start.observed = true;
          }
          const closed = deltas.find(delta => delta.op === "turn.close") as
            { nativeTurnId?: string; status?: string } | undefined;
          if (closed?.nativeTurnId) {
            void this.queue.turnClosed(route, closed.nativeTurnId, String(closed.status ?? "completed")).catch(() => {});
          }
          const terminal = sessionEnded ? "session.ended"
            : closed?.nativeTurnId && "turn.close:" + closed.nativeTurnId;
          if (terminal && this.cliClosedTurns.get(route) !== terminal) {
            this.cliClosedTurns.set(route, terminal);
            const active = this.cliLeases.get(route);
            const reserved = sessionEnded ? this.cliReservations.get(route)?.lease : undefined;
            // A durable callback does not wait for lease filesystem cleanup.
            // Keep each lease registered until its own revocation confirms.
            for (const lease of [active, reserved]) {
              if (lease) this.trackCliCleanup(this.revokeRouteLease(route, lease).catch(error => peer.abort(error)));
            }
          }
        },
        this.options.requestTimeoutMs,
        () => {
          for (const [route, reserved] of this.cliReservations)
            if (reserved.generation === id) this.trackCliCleanup(this.revokeRouteLease(route, reserved.lease));
          for (const [route, lease] of this.cliLeases)
            if (this.cliGenerations.get(route) === id) this.trackCliCleanup(this.revokeRouteLease(route, lease));
        },
      );
      this.diagnosticPeers.set(id, peer);
      try {
        await peer.start(this.pool);
        const reply = await peer.request(`host-init:${randomUUID()}`, "initialize", {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          grammarRange: BRIDGE_GRAMMAR_RANGE,
        });
        if (!successful(reply)) throw Error("Bridge initialize rejected");
        const result = object(reply.result);
        const expected = negotiateHandshake(
          { protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE },
          config.provider,
        );
        if (
          !expected.ok ||
          result.protocolVersion !== expected.result.protocolVersion ||
          result.grammarVersion !== expected.result.grammarVersion ||
          result.approvalExecutor !== expected.result.approvalExecutor
        )
          throw Error("Invalid bridge negotiation");
        // Probe is narrowing-only; validate it against the registered upper bound.
        const caps = object(result.effectiveCapabilities);
        const upper = expected.result.effectiveCapabilities;
        for (const key of [
          "model",
          "reasoning",
          "history",
          "usage",
          "approval",
          "cliExecutable",
          "forkCheckpoint",
          "skills",
          "installation",
        ] as const)
          if (typeof caps[key] !== "boolean" || (caps[key] && !upper[key])) throw Error("Bridge widened capabilities");
        // Added later: an older bridge artifact omits them, which means unsupported.
        for (const key of ["lifecycle", "goals", "settings", "adoption"] as const) {
          caps[key] ??= false;
          if (typeof caps[key] !== "boolean" || (caps[key] && !upper[key])) throw Error("Bridge widened capabilities");
        }
        const steer = object(caps.steer);
        for (const key of ["deliveryMethods", "evidenceKinds"] as const)
          if (
            !Array.isArray(steer[key]) ||
            !(steer[key] as unknown[]).every((v) => (upper.steer[key] as readonly unknown[]).includes(v))
          )
            throw Error("Bridge widened steer capability");
        if (
          !Array.isArray(caps.inputContentTypes) ||
          !caps.inputContentTypes.every((v) => upper.inputContentTypes.includes(v))
        )
          throw Error("Invalid input types");
        const limits = object(steer.contentLimits);
        if (
          !Number.isSafeInteger(limits.maxBytes) ||
          Number(limits.maxBytes) < 1 ||
          Number(limits.maxBytes) > upper.steer.contentLimits.maxBytes ||
          !Array.isArray(limits.allowedContentTypes) ||
          !limits.allowedContentTypes.every((v) => upper.steer.contentLimits.allowedContentTypes.includes(v)) ||
          !Number.isSafeInteger(steer.maxPendingWithoutNativeId) ||
          Number(steer.maxPendingWithoutNativeId) < 1 ||
          Number(steer.maxPendingWithoutNativeId) > upper.steer.maxPendingWithoutNativeId ||
          ![upper.steer.withdrawal, "none"].includes(steer.withdrawal as any) ||
          ![upper.steer.fallbackPolicy, "reject-unknown"].includes(steer.fallbackPolicy as any)
        )
          throw Error("Invalid steer limits or policy");
        this.capabilities.set(id, {
          ...(result.effectiveCapabilities as BridgeInitializeResult["effectiveCapabilities"]),
          cliExecutable: !!this.options.executionCli && caps.cliExecutable === true,
        });
        return peer;
      } catch (error) {
        await peer.close();
        throw error;
      }
    })();
    const pending = previous
      ? launch.then(
          (peer) => {
            this.reconnectAfter.delete(id);
            return peer;
          },
          () => {
            if (this.peers.get(id) === pending) {
              this.diagnosticPeers.set(id, previous.peer);
              this.peers.set(id, previous.pending);
              this.reconnectAfter.set(id, Date.now() + CODEX_RECONNECT_DELAY_MS);
            }
            throw new CodexAttachmentUnavailable();
          },
        )
      : launch;
    this.peers.set(id, pending);
    return pending;
  }
  accept(raw: unknown): Promise<Receipt> {
    const admission = this.admit(raw);
    this.admissions.add(admission);
    void admission.finally(() => this.admissions.delete(admission)).catch(() => {});
    return admission;
  }
  private async admit(raw: unknown): Promise<Receipt> {
    if (this.closing) throw Error("Host closing");
    const command = structuredClone(object(raw)) as unknown as Command;
    identifier(command.commandId);
    identifier(command.serverId);
    identifier(command.threadId);
    object(command.params);
    if (
      !isBridgeCommand(command.method) ||
      (command.method as string) === "initialize" ||
      command.method === "session/release"
    )
      throw Error("Unsupported command");
    // An adopted session keeps its identity: the public Thread is the native session it names.
    if (command.method === "session/adopt") {
      if (command.params.providerThreadId !== command.threadId)
        throw hostRefusal(command, "An adopted session keeps its own Thread ID");
      if (command.params.recoverActive !== undefined)
        throw hostRefusal(command, "Only the Host can recover a retained execution");
    }
    const { gitEnvironment, ...durableParams } = command.params;
    if (gitEnvironment !== undefined && (
      command.method !== "turn/start" || typeof gitEnvironment !== "object" || gitEnvironment === null ||
      Array.isArray(gitEnvironment) || Object.entries(gitEnvironment).some(([name, value]) =>
        !/^(PATH|BASH_ENV|OPENCRAFT_GIT_[A-Z0-9_]+)$/u.test(name) || typeof value !== "string" || value.includes("\0"))
    )) throw hostRefusal(command, "Invalid Git execution environment");
    // The short-lived seal may change when an identical request is retried.
    // The admitted command's input stays immutable, and only the first
    // admission can dispatch with the launch material it received.
    const durableCommand = { ...command, params: durableParams };
    const serialized = stable(durableCommand);
    if (Buffer.byteLength(gitEnvironment === undefined ? serialized : stable(command)) > BRIDGE_MAX_COMMAND_BYTES) throw oversizedBridgeRequest(BRIDGE_MAX_COMMAND_BYTES);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const route = routeKey(command.serverId, command.threadId);
    if (command.method === "session/resume") {
      const state = await this.storage.call<{ nativeSession: { native_id: string; restorable: number } | null }>(
        "threadState",
        { route },
      );
      const native = state.nativeSession;
      const requested = command.params?.providerThreadId ?? command.params?.nativeSessionId;
      if (!native) throw hostRefusal(command, "Thread has no recorded native session");
      if (native.restorable !== 1) throw hostRefusal(command, "Recorded native session is not restorable");
      if (requested !== undefined && native.native_id !== requested)
        throw hostRefusal(command, "Resume id does not match the recorded restorable native session");
    }
    // A new turn is where an idle Thread moves to the current provider generation.
    // A new turn, or a restarted route's first use (no provider holds it yet), moves an idle Thread
    // to the current provider generation.
    if (command.method === "turn/start" || this.rebinding.has(route)) await this.migrate(route);
    const result = await this.storage.call<{ receipt: Receipt; fresh: boolean }>("admit", {
      command: durableCommand,
      digest,
      route,
      maxSpoolBytes: this.options.maxSpoolBytes ?? 64 * 1024 ** 2,
    }).catch((error: unknown) => {
      if (error instanceof StorageRefusal) throw hostRefusal(command, error.message);
      throw error;
    });
    if (result.fresh) {
      const task = this.dispatch(command, result.receipt).finally(() => {
        if (!this.closing && isArchiveCommand(command.method)) this.queue.schedule(route);
      });
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
    return result.receipt; // admission is durable, never waits for native response
  }
  /**
   * After replacing a provider, bind a route's recorded native session in the new
   * process before any command or read touches it. The native ID comes from this
   * Host's own record, never from a client. A refusal (for example a turn still
   * running natively) leaves the route to retry on its next use.
   */
  private bound(peer: Peer, route: string, epoch: number): Promise<void> {
    if (!this.rebinding.has(route)) return Promise.resolve();
    const pending = this.rebinds.get(route);
    if (pending?.peer === peer) return pending.operation;
    const operation = (async () => {
      const state = await this.storage.call<{
        state: { openTurns?: Record<string, unknown> };
        nativeSession: { native_id: string; restorable: number } | null;
      }>("threadState", { route });
      const native = state.nativeSession;
      if (native && native.restorable === 1) {
        // Turns this Host still holds open ended natively while no provider process watched them.
        const openTurns = Object.keys(state.state.openTurns ?? {});
        const reply = await peer.request(`host-recover:${randomUUID()}`, "session/adopt", {
          threadId: route,
          providerThreadId: native.native_id,
          openTurns,
          ...(peer.config.provider.providerId === "codex" ? { recoverActive: true } : {}),
          executionEpoch: epoch,
        });
        if (!successful(reply))
          throw Object.assign(
            Error(`Native session recovery was refused: ${"error" in reply ? reply.error.message : "no result"}`),
            { code: -32006, kind: "explicit-reject" },
          );
      }
      if (!peer.diagnostic().failed) this.rebinding.delete(route);
    })().finally(() => {
      if (this.rebinds.get(route)?.operation === operation) this.rebinds.delete(route);
    });
    this.rebinds.set(route, { peer, operation });
    return operation;
  }
  private readonly migrations = new Map<string, Promise<void>>();
  /**
   * Move an idle route from an older generation to the current one, so provider
   * updates reach existing Threads: the old provider releases the native
   * session (nothing ends), the current one adopts it, then the binding moves.
   * Both generations must declare adoption. Any refusal leaves the route where
   * it is; it simply runs on its generation and is tried again at its next turn.
   */
  private migrate(route: string): Promise<void> {
    const pending = this.migrations.get(route);
    if (pending) return pending;
    const operation = (async () => {
      type Candidate = { generation: string | null; current: string; nativeId: string | null; busy: boolean };
      let state = await this.storage.call<Candidate>("migration", { route });
      // Reads and resumes the window sends just before a turn settle quickly; wait for them, not for work.
      for (let attempt = 0; state.busy && state.generation !== state.current && attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await this.storage.call<Candidate>("migration", { route });
      }
      if (state.busy && state.generation !== state.current) process.stderr.write("host-migration-skipped:busy\n");
      const from = state.generation,
        to = state.current;
      if (
        !from ||
        !to ||
        from === to ||
        state.busy ||
        this.cliPending.has(route) ||
        !state.nativeId ||
        !this.recoverable(from) ||
        !this.recoverable(to)
      )
        return;
      const previous = this.peers.get(from);
      const old = previous ? await previous.catch(() => undefined) : undefined;
      const restarted = this.rebinding.has(route);
      // A provider that never bound it in this process (Host restart) has nothing to release.
      if (old && !restarted) {
        const released = await old.request(`host-migrate:${randomUUID()}`, "session/release", { threadId: route });
        if (!successful(released)) {
          process.stderr.write(`host-migration-skipped:release:${"error" in released ? released.error.message : ""}\n`);
          return;
        }
      }
      const readopt = async () => {
        if (old && !restarted)
          await old
            .request(`host-migrate:${randomUUID()}`, "session/adopt", {
              threadId: route,
              providerThreadId: state.nativeId,
              openTurns: [],
            })
            .catch(() => undefined);
      };
      // The binding moves first: the adopting provider's identity callback must come from the owner.
      try {
        await this.storage.call("rebindRoute", { route, from, to });
      } catch {
        await readopt();
        return;
      }
      const current = await this.peer(to);
      const adopted = await current
        .request(`host-migrate:${randomUUID()}`, "session/adopt", {
          threadId: route,
          providerThreadId: state.nativeId,
          openTurns: [],
          executionEpoch: (await this.storage.call<{ epoch: number }>("observationRoute", { route })).epoch,
        })
        .catch(() => undefined);
      if (!adopted || !successful(adopted)) {
        process.stderr.write(
          `host-migration-skipped:adopt:${adopted && "error" in adopted ? adopted.error.message : "no answer"}\n`,
        );
        // Back to where it was; a failed hand-back is recovered on the route's next use.
        await this.storage.call("rebindRoute", { route, from: to, to: from }).catch(() => undefined);
        await readopt();
        return;
      }
      this.rebinding.delete(route);
      if (!(await this.retireUnused(from))) this.draining.add(from);
    })()
      .catch((error) => {
        process.stderr.write(
          `host-migration-skipped:${error instanceof Error ? error.message.slice(0, 200) : "unknown"}\n`,
        );
      })
      .finally(() => {
        this.migrations.delete(route);
        return this.drain();
      });
    this.migrations.set(route, operation);
    return operation;
  }
  private queueRoute(route: string): Promise<{ generation: string | null; epoch: number; queueActive: boolean }> {
    return this.storage.call("observationRoute", { route, forQueue: true });
  }
  /** Restore a native attachment before the queue judges whether the route is idle. */
  private async recoverRoute(route: string): Promise<void> {
    if (this.rebinding.has(route)) await this.migrate(route);
    const binding = await this.storage.call<{ generation: string | null; epoch: number }>("observationRoute", {
      route,
    });
    if (!binding.generation || (!this.rebinding.has(route) && !this.lostCodexAttachment(binding.generation))) return;
    await this.bound(await this.peer(binding.generation), route, binding.epoch);
  }
  private async cancelPendingCliIssue(route: string, reason: NonNullable<PendingCliIssue["cancelled"]>): Promise<void> {
    const pending = this.cliPending.get(route);
    if (!pending) return;
    if (!pending.cancelled || reason === "session-ended") pending.cancelled = reason;
    // The command has not been dispatched. Its receipt can settle before
    // the separate responsibility to reclaim the in-flight lease.
    await this.rejectCliCommand(pending.commandId);
  }
  private rejectCliCommand(commandId: string): Promise<void> {
    return this.storage.call("settle", {
      id: commandId,
      state: "rejected",
      response: {
        jsonrpc: "2.0",
        id: "host-command:" + commandId,
        error: { code: -32001, kind: "unsupported", message: "cliUnavailable" },
      },
    });
  }
  private trackCliCleanup(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  private revokeCliLease(lease: ExecutionCliLease): Promise<void> {
    const revocation = this.cliRevocations.get(lease) ?? {};
    this.cliRevocations.set(lease, revocation);
    return revocation.pending ??= Promise.resolve().then(() => lease.revoke()).catch(error => {
      revocation.pending = undefined;
      throw error;
    });
  }
  private async revokeRouteLease(route: string, lease: ExecutionCliLease): Promise<void> {
    await this.revokeCliLease(lease);
    if (this.cliLeases.get(route) === lease) {
      this.cliLeases.delete(route);
      this.cliGenerations.delete(route);
    }
    if (this.cliReservations.get(route)?.lease === lease) this.cliReservations.delete(route);
  }
  private finishPendingCliIssue(route: string, pending: PendingCliIssue, peer?: Peer): void {
    if (pending.failedCleanup || this.cliPending.get(route) !== pending) return;
    this.cliPending.delete(route);
    // A stopped pre-dispatch start has no native terminal event to wake the queue.
    if (pending.cancelled === "stop" && !this.closing && !peer?.diagnostic().failed)
      this.queue.schedule(route);
  }
  private async revokeUnsentCliLease(pending: PendingCliIssue, lease: ExecutionCliLease): Promise<void> {
    try { await this.revokeCliLease(lease); }
    catch (error) { pending.failedCleanup = lease; throw error; }
  }
  private async retryUnsentCliCleanup(route: string, pending: PendingCliIssue, peer?: Peer): Promise<void> {
    const lease = pending.failedCleanup;
    if (!lease) return;
    await this.revokeCliLease(lease);
    pending.failedCleanup = undefined;
    this.finishPendingCliIssue(route, pending, peer);
  }
  private async discardUnsentCliLease(receipt: Receipt, pending: PendingCliIssue, peer: Peer, lease: ExecutionCliLease): Promise<void> {
    const canRestore = () => pending.cancelled === "stop" && !this.closing && !peer.diagnostic().failed;
    if (!lease.rejectBeforeStart || !canRestore()) return this.revokeUnsentCliLease(pending, lease);
    let reserved: ExecutionCliLease;
    try { reserved = await lease.rejectBeforeStart(); }
    catch { return this.revokeUnsentCliLease(pending, lease); }
    if (canRestore()) this.cliReservations.set(receipt.route, { generation: receipt.generation, lease: reserved });
    else await this.revokeUnsentCliLease(pending, reserved);
  }
  private async dispatch(command: Command, receipt: Receipt): Promise<void> {
    let dispatched = false;
    const recordDispatch = async () => {
      await this.storage.call("dispatch", { id: command.commandId });
      dispatched = true;
    };
    try {
      let peer: Peer;
      try {
        peer = await this.peer(receipt.generation);
      } catch (error) {
        if (!(error instanceof CodexAttachmentUnavailable)) throw error;
        // Attachment negotiation failed before this command was sent.
        await this.storage.call("settle", {
          id: command.commandId,
          state: "rejected",
          response: {
            jsonrpc: "2.0",
            id: `host-command:${command.commandId}`,
            error: { code: -32006, kind: "explicit-reject", message: error.message },
          },
        });
        return;
      }
      const admission = assertMethodAllowed(this.capabilities.get(receipt.generation)!, command.method);
      if (!admission.ok) {
        await this.storage.call("settle", { id: command.commandId, state: "rejected" });
        return;
      }
      if (!["session/create", "session/fork", "session/adopt"].includes(command.method)) {
        try {
          await this.bound(peer, receipt.route, receipt.epoch);
        } catch (error) {
          // Nothing was sent for this command: the session was not bound.
          await this.storage.call("settle", {
            id: command.commandId,
            state: "rejected",
            response: {
              jsonrpc: "2.0",
              id: `host-command:${command.commandId}`,
              error: {
                code: -32006,
                kind: "explicit-reject",
                message: error instanceof Error ? error.message : "Session recovery refused",
              },
            },
          });
          return;
        }
      }
      if (command.method === "turn/stop" && command.params.expectedTurnId === undefined && command.params.turnId === undefined) {
        const pending = this.cliPending.get(receipt.route);
        if (pending &&
            await this.storage.call<boolean>("routeIdle", { route: receipt.route, excludingCommandId: pending.commandId }) &&
            this.cliPending.get(receipt.route) === pending) {
          await this.cancelPendingCliIssue(receipt.route, "stop");
          try { await this.retryUnsentCliCleanup(receipt.route, pending, peer); }
          catch { await this.rejectCliCommand(command.commandId); return; }
          await this.storage.call("settle", {
            id: command.commandId,
            state: "accepted",
            localStop: true,
            response: { jsonrpc: "2.0", id: "host-command:" + command.commandId, result: { stopped: true } },
          });
          return;
        }
      }
      let cliEnvironment: Readonly<Record<string, string>> | undefined;
      if (
        ["session/create", "session/fork", "session/adopt"].includes(command.method) &&
        this.options.executionCli?.reserve &&
        this.capabilities.get(receipt.generation)?.cliExecutable
      ) {
        try {
          const lease = await this.options.executionCli.reserve({
            serverId: command.serverId,
            threadId: command.threadId,
          });
          if (this.closing || peer.diagnostic().failed) {
            await this.revokeCliLease(lease);
            throw Error("CLI owner unavailable");
          }
          this.cliReservations.set(receipt.route, { generation: receipt.generation, lease });
          cliEnvironment = lease.environment;
        } catch {
          await this.rejectCliCommand(command.commandId);
          return;
        }
      }
      // The Host's own queue delivery carries no execution-CLI credential (signed credentials are
      // never persisted): it runs as an ordinary turn without the CLI rather than being refused.
      // Every other turn/start still requires its credential and fails closed without it.
      const queuedWithoutSource =
        command.commandId.startsWith("queue-start:") && command.params.executionSource === undefined;
      if (
        command.method === "turn/start" &&
        this.options.executionCli &&
        this.capabilities.get(receipt.generation)?.cliExecutable &&
        !queuedWithoutSource
      ) {
        const pending: PendingCliIssue = { commandId: command.commandId };
        try {
          const credential = command.params.executionSource;
          if (typeof credential !== "string" || credential.length > 4096) throw Error("cliUnavailable");
          const reserved = this.cliReservations.get(receipt.route)?.lease;
          if (this.cliLeases.has(receipt.route) || this.cliPending.has(receipt.route) ||
              (reserved && this.cliRevocations.has(reserved))) throw Error("cliUnavailable");
          this.cliPending.set(receipt.route, pending);
          const lease = await this.options.executionCli.issue({
            serverId: command.serverId,
            threadId: command.threadId,
            credential,
          });
          if (this.cliReservations.get(receipt.route)?.lease === reserved) this.cliReservations.delete(receipt.route);
          const mayDispatch = () => !pending.cancelled && !this.closing && !peer.diagnostic().failed;
          let ready = false;
          try {
            if (mayDispatch()) {
              await recordDispatch();
              ready = mayDispatch();
            }
          } finally {
            if (!ready) await this.discardUnsentCliLease(receipt, pending, peer, lease);
          }
          if (!ready) throw Error("cliUnavailable");
          this.cliLeases.set(receipt.route, lease);
          this.cliGenerations.set(receipt.route, receipt.generation);
          cliEnvironment = lease.environment;
        } catch {
          await this.rejectCliCommand(command.commandId);
          return;
        } finally {
          this.finishPendingCliIssue(receipt.route, pending, peer);
        }
      }
      const { executionSource: _executionSource, gitEnvironment, ...providerParams } = command.params;
      if (gitEnvironment !== undefined) {
        if (this.generations.get(receipt.generation)?.provider.providerId !== "codex") {
          await this.rejectCliCommand(command.commandId);
          return;
        }
        const git = gitEnvironment as Record<string, string>;
        // Preserve the Thread CLI shim and the Git interceptor in the same
        // shell PATH. Both authorities supply absolute paths.
        const paths = [git.OPENCRAFT_GIT_BIN, cliEnvironment?.PATH, git.PATH];
        const path = [...new Set(paths.flatMap(value => value?.split(":") ?? []))].join(":");
        cliEnvironment = { ...cliEnvironment, ...git, ...(path ? { PATH: path } : {}) };
      }
      // A fork names its source by public Thread; the provider knows sessions by route.
      if (command.method === "session/fork")
        providerParams.sourceThreadId = routeKey(command.serverId, identifier(command.params.sourceThreadId));
      // Recovery treats only committed dispatches as potentially sent.
      if (!dispatched) await recordDispatch();
      const start = command.method === "turn/start" ? { observed: false, commandId: command.commandId } : undefined;
      if (start) this.cliStarts.set(receipt.route, start);
      const response = await peer.request(`host-command:${command.commandId}`, command.method, {
        ...providerParams,
        ...(cliEnvironment ? { cliEnvironment } : {}),
        ...(cliEnvironment || command.params.sessionMcp !== undefined
          ? {
              cliPreparationDeadlineMs:
                Date.now() + Math.min(10000, Math.max(1, Math.floor((this.options.requestTimeoutMs ?? 30000) / 2))),
            }
          : {}),
        threadId: receipt.route,
        executionEpoch: receipt.epoch,
      });
      let state = dispatchSettlement(response);
      if (start && this.cliStarts.get(receipt.route) === start) this.cliStarts.delete(receipt.route);
      if (state === "rejected" && start?.observed) state = "unknown";
      const sessionClosed = state === "accepted" && (command.method === "session/close" || command.method === "session/delete");
      if (sessionClosed) await this.cancelPendingCliIssue(receipt.route, "session-ended");
      await this.storage.call("settle", {
        id: command.commandId,
        response,
        state,
        interactionId: command.params.interactionId,
      });
      if (
        (["session/create", "session/fork", "session/adopt"].includes(command.method) && state === "rejected") ||
        sessionClosed
      ) {
        const reserved = this.cliReservations.get(receipt.route);
        if (reserved) await this.revokeRouteLease(receipt.route, reserved.lease);
      }
      if (state === "rejected" && ["session/create", "session/fork", "session/adopt"].includes(command.method)) {
        const failure =
          "error" in response ? (response.error.data as { failure?: unknown } | undefined)?.failure : undefined;
        // Only failures that leave no resumable native session release the
        // fresh route binding. pending/exists/locked/orphaned keep it so the
        // client can resume or explicitly recover the same native session.
        if (failure === "invalid" || failure === "unavailable" || failure === "orphaned") {
          await this.storage.call("abandon", { route: receipt.route, id: command.commandId }).catch(() => {});
        }
      }
      if (
        (state === "rejected" && command.method === "turn/start" && cliEnvironment !== undefined) ||
        (command.method === "turn/stop" && state === "accepted") ||
        sessionClosed
      ) {
        const lease = this.cliLeases.get(receipt.route);
        if (lease) {
          if (state === "rejected" && command.method === "turn/start" && lease.rejectBeforeStart && !this.cliRevocations.has(lease)) {
            const reserved = await lease.rejectBeforeStart();
            if (this.closing || peer.diagnostic().failed) {
              await this.revokeCliLease(reserved);
              throw Error("CLI owner unavailable");
            }
            this.cliReservations.set(receipt.route, { generation: receipt.generation, lease: reserved });
            if (this.cliLeases.get(receipt.route) === lease) {
              this.cliLeases.delete(receipt.route);
              this.cliGenerations.delete(receipt.route);
            }
          } else await this.revokeRouteLease(receipt.route, lease);
        }
      }
    } catch {
      if (this.cliStarts.get(receipt.route)?.commandId === command.commandId) this.cliStarts.delete(receipt.route);
      await this.storage.call("settle", dispatched ? { id: command.commandId, state: "unknown" } : {
        id: command.commandId,
        state: "rejected",
        response: {
          jsonrpc: "2.0",
          id: "host-command:" + command.commandId,
          error: { kind: "explicit-reject", code: BRIDGE_ERROR_CODES.explicitReject, message: "Bridge Host could not dispatch the command" },
        },
      });
    }
  }
  scriptCapabilities() {
    return this.options.automation
      ? { ...this.options.automation, permissionProfile: "sandbox-policy:" + this.options.policy.id }
      : null;
  }
  async script(raw: unknown): Promise<unknown> {
    const body = object(raw),
      capabilities = this.scriptCapabilities();
    if (
      this.closing ||
      !capabilities ||
      body.hostId !== capabilities.hostId ||
      body.environment !== capabilities.environment ||
      body.permissionProfile !== capabilities.permissionProfile
    )
      throw Error("Automation sandbox authority unavailable");
    if (
      Object.keys(body).some(
        (key) => !["key", "hostId", "environment", "permissionProfile", "cwd", "argv"].includes(key),
      )
    )
      throw Error("Invalid script fields");
    const key = identifier(body.key);
    const bounded = (value: unknown) => {
      if (typeof value !== "string" || value.length > 4096 || value.includes("\0"))
        throw Error("Invalid script argument");
      return value;
    };
    const cwd = bounded(body.cwd);
    if (!isAbsolute(cwd)) throw Error("Absolute script cwd required");
    if (!Array.isArray(body.argv) || body.argv.length < 1 || body.argv.length > 64) throw Error("Invalid script argv");
    const argv = body.argv.map(bounded);
    if (!argv[0]) throw Error("Script executable required");
    const digest = createHash("sha256")
      .update(JSON.stringify([capabilities, cwd, argv]))
      .digest("hex");
    const receipt = await this.storage.call("scriptAdmit", { key, digest });
    if (receipt.fresh) {
      const task = this.runScript(key, cwd, argv);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
    return receipt;
  }
  private async runScript(key: string, cwd: string, argv: string[]): Promise<void> {
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    let state = "unknown",
      result: unknown,
      started = false;
    try {
      await this.storage.call("scriptSettle", { key, state: "running" });
      sandbox = await createSandbox(this.pool, { owner: "automation:" + key });
      let stdout = "",
        stderr = "",
        bytes = 0,
        truncated = false;
      const process = await sandbox.spawn({ command: argv, cwd, env: {} }, (output) => {
        const remaining = Math.max(0, 64 * 1024 - bytes),
          data = Buffer.from(output.data);
        const text = data.subarray(0, remaining).toString("utf8");
        bytes += Math.min(remaining, data.length);
        if (data.length > remaining) truncated = true;
        if (output.stream === "stdout") stdout += text;
        else stderr += text;
      });
      started = true;
      if (process.kind === "process") await process.closeStdin();
      const exit = await process.exited;
      state = exit.code === 0 ? "completed" : "failed";
      result = { stdout, stderr, exit, truncated };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const refused =
        !started &&
        (["ENOENT", "EACCES", "SANDBOX_POLICY", "SANDBOX_UNAVAILABLE"].includes(code ?? "") ||
          (error instanceof SandboxCreationFault && error.outcome === "not-created"));
      state = refused ? "failed" : "unknown";
      result = { reason: state === "failed" ? "sandbox_preparation_refused" : "script_outcome_unknown" };
    }
    try {
      await sandbox?.close();
    } catch {
      state = "unknown";
      result = { reason: "script_cleanup_unconfirmed" };
    }
    await this.storage.call("scriptSettle", { key, state, result });
  }
  scriptResult(key: string): Promise<unknown> {
    return this.storage.call("scriptShow", { key: identifier(key) });
  }
  async cli(token: string, body: unknown) {
    if (this.closing || !this.options.executionCli?.forward) throw Error("cliUnavailable");
    return this.options.executionCli.forward(token, body);
  }
  /** Read-only observations have no mutation receipt or replay custody. */
  async observe(raw: unknown, forQueue = false): Promise<unknown> {
    if (this.closing) throw Error("Host closing");
    const body = object(raw);
    if (body.method !== "history/read") throw Error("Unsupported observation");
    const { openArchivedHistory, ...params } = structuredClone(object(body.params));
    if (openArchivedHistory !== undefined && openArchivedHistory !== true)
      throw Object.assign(Error("Invalid archive history intent"), { code: -32602, kind: "invalid" });
    if (Buffer.byteLength(stable(params)) > 512 * 1024) throw Error("Observation too large");
    const route = routeKey(identifier(body.serverId), identifier(body.threadId));
    const forHistory = openArchivedHistory !== true && !(params.view === "thread" && params.includeTurns !== true);
    const readBinding = () => this.storage.call<{
      generation: string | null;
      epoch: number;
      archiveState: "active" | "archived" | "unconfirmed" | null;
      queueActive?: boolean;
    }>("observationRoute", { route, forQueue, forHistory });
    const assertReadable = ({ archiveState, queueActive }: Awaited<ReturnType<typeof readBinding>>) => {
      if (forQueue && !queueActive) throw Error("Thread archive state prevents queue observation");
      if (!forHistory) return;
      if (archiveState === "archived")
        throw Object.assign(Error("Thread is archived"), {
          code: -32071, kind: "explicit-reject", data: { code: "THREAD_ARCHIVED" },
        });
      if (archiveState === "unconfirmed")
        throw Object.assign(Error("Thread archive state is unconfirmed"), { code: -32000, kind: "explicit-reject" });
    };
    if (this.rebinding.has(route)) {
      if (forQueue || forHistory) assertReadable(await readBinding());
      await this.migrate(route);
    }
    const binding = await readBinding();
    assertReadable(binding);
    if (!binding.generation) throw Error("Thread has no retained owner");
    const peer = await this.peer(binding.generation);
    const admission = assertMethodAllowed(this.capabilities.get(binding.generation)!, "history/read");
    if (!admission.ok || this.closing) throw Error("History unavailable");
    const current = await readBinding();
    assertReadable(current);
    if (this.closing || current.generation !== binding.generation || current.epoch !== binding.epoch)
      throw Error("Observation owner changed");
    if (this.rebinding.has(route)) {
      await this.bound(peer, route, binding.epoch);
      if (forQueue || forHistory) assertReadable(await readBinding());
    }
    const response = await peer.request(`host-observation:${randomUUID()}`, "history/read", {
      ...params,
      threadId: route,
      executionEpoch: binding.epoch,
    });
    const after = await readBinding();
    assertReadable(after);
    if (this.closing || after.generation !== binding.generation || after.epoch !== binding.epoch)
      throw Error("Observation owner changed");
    if ("error" in response) throw Object.assign(Error(response.error.message), response.error);
    if (!("result" in response)) throw Error("Invalid observation response");
    const result = response.result;
    if (params.view === "thread" && after.archiveState === "archived") {
      const thread = (result as { thread?: unknown } | null)?.thread;
      if (thread && typeof thread === "object" && !Array.isArray(thread))
        return { ...result as object, thread: { ...thread, archived: true } };
    }
    return result;
  }
  /** thread/queue/* for a bridge Thread; the queue is Host state, never a provider command. */
  queueRequest(raw: unknown): Promise<unknown> {
    if (this.closing) throw Error("Host closing");
    const body = object(raw);
    return this.queue.request(
      routeKey(identifier(body.serverId), identifier(body.threadId)),
      String(body.method),
      object(body.params),
    );
  }
  /** Inputs the Host still holds, for maintenance draining (all servers). */
  async maintenance(): Promise<{ queued: number; unknown: number; inFlight: number }> {
    const counts = await this.storage.call<{ queued: number; unknown: number; inFlightKeys: string[] }>("queue", {
      method: "maintenanceCounts",
      args: [],
    });
    return { queued: counts.queued, unknown: counts.unknown, inFlight: counts.inFlightKeys.length };
  }
  threadState(serverId: string, threadId: string): Promise<any> {
    return this.storage.call("threadState", { route: routeKey(serverId, threadId) });
  }
  diagnostics(): unknown {
    return [...this.diagnosticPeers].map(([generation, peer]) => ({ generation, ...peer.diagnostic() }));
  }
  query(id: string): Promise<Receipt | null> {
    return this.storage.call("query", { id });
  }
  async snapshot(adoptionOwnership = false): Promise<any> {
    return { ...(await this.storage.call("snapshot", { adoptionOwnership })), databaseOutcome: await this.storage.ready };
  }
  events(cursor: number, limit = 256, fenced = false, fragmentOffset?: number): Promise<any> {
    return this.storage.call("events", { cursor, limit, fenced, fragmentOffset });
  }
  historyIdentities(serverId: string, threadId: string, after: number, through?: number, selection?: BridgeHistorySelection): Promise<unknown> {
    return this.storage.call("historyIdentities", { route: routeKey(serverId, threadId), after, through, selection });
  }
  async ack(cursor: number, outboxId?: string): Promise<void> {
    await this.storage.call("ack", { cursor, outboxId });
    await this.drain();
  }
  /** Retries draining generations; a migration in flight may still hand its route back to one. */
  private async drain(): Promise<void> {
    if (this.migrations.size || this.closing) return;
    for (const id of [...this.draining]) await this.retireUnused(id);
  }
  /** Retires a non-current generation nothing is bound to and whose events are acknowledged. */
  private async retireUnused(id: string): Promise<boolean> {
    if (!(await this.storage.call<boolean>("retireUnused", { id }).catch(() => false))) return false;
    const retired = this.peers.get(id);
    this.peers.delete(id);
    this.generations.delete(id);
    this.reconnectAfter.delete(id);
    this.draining.delete(id);
    if (retired) await (await retired.catch(() => undefined))?.close().catch(() => undefined);
    return true;
  }
  releaseThread(serverId: string, threadId: string): Promise<void> {
    const route = routeKey(serverId, threadId);
    if (this.cliPending.has(route)) return Promise.reject(Error("Thread still has work or unknown custody"));
    return this.storage.call("releaseRoute", { route });
  }
  async retire(id: string): Promise<void> {
    await this.storage.call("retire", { id }); // refuse before touching a busy peer
    const peer = this.peers.get(id);
    this.peers.delete(id);
    this.generations.delete(id);
    this.reconnectAfter.delete(id);
    this.draining.delete(id);
    if (peer) await (await peer).close();
  }
  async close(): Promise<void> {
    this.closing = true;
    this.queue.close();
    await Promise.allSettled([...this.admissions]);
    const cleanup = await Promise.allSettled([
      this.pool.close(),
      ...[...this.cliLeases.values()].map((lease) => this.revokeCliLease(lease)),
      ...[...this.cliReservations.values()].map((value) => this.revokeCliLease(value.lease)),
      ...[...this.peers.values()].map(async (pending) => {
        const peer = await pending.catch(() => undefined);
        if (peer) await peer.close();
      }),
    ]);
    await Promise.allSettled([...this.tasks]);
    const lateCliCleanup = await Promise.allSettled(
      [...this.cliPending].map(([route, pending]) => this.retryUnsentCliCleanup(route, pending)),
    );
    const storage = await Promise.allSettled([this.storage.close()]);
    const failures = [...cleanup, ...lateCliCleanup, ...storage].filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => (result as PromiseRejectedResult).reason),
        "Bridge owner cleanup unconfirmed",
      );
  }
}

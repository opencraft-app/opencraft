// The WorkspaceHost Durable Object (docs/architecture/platform/cloudflare-deployment.md §5.7):
// one SQLite-backed object per workspace owns that workspace's Host state and
// its container (Brain and Hands in one Cloudflare Container), and serves the
// workspace's execution through the same workspace-host module the Node root
// calls (`assembly/workspace-host.mjs`).
//
// This is a composition root, not a second implementation. Runtime-neutral
// inputs replace the Node ones:
//   Host SQL          every WorkspaceHost store's published chain as one family of a
//                     shared ledger in the object's SQL (Node: one file per store)
//   environment       the `cloudflare` sandbox provider over `ctx.container`, through the
//                     provider registry, a sandbox pool and WorkspaceRuntime (Node Docker:
//                     `static-docker`/`docker-provisioner` through the same runtime)
//   engine            the container's Engine Host over its workspace endpoint, HTTP and
//                     WebSocket on the endpoint byte stream (Node: a local endpoint
//                     listener and `attachEngineHost`/`ws`)
//   execution reads   the same history reader over an endpoint WebSocket
//   owner wake-ups    the object's single alarm, merged (Node: runtime timeouts)
// The object adds what only a per-workspace owner on a sleeping runtime needs:
// the idle policy (§3.7.2), recovery of interrupted Turns when the container's
// incarnation changes, and credential lease custody per container incarnation.
// Not assembled here: the module's delivery, browser, capability MCP, terminal,
// file, resource and transport steps (they need the installation's services,
// the client session and Hands endpoints; see §5.7 "仍缺").
import {
  createSandboxPool,
  formatSandboxEnvironmentUri,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxEnvironmentAddress,
  type SandboxEndpointConnection,
  type WorkspaceEndpointAddress,
  type WorkspacePlacementEvent,
  type WorkspacePlacementRecord,
  type WorkspaceRuntime,
} from "@opencraft/sandbox";
import { createWorkspaceRuntime } from "@opencraft/sandbox/workspace";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import {
  armCloudflareContainerTimeout,
  cloudflareSandboxProvider,
  type CloudflareInstallation,
  type DurableObjectContainer,
} from "@opencraft/sandbox-cloudflare";
import type { SqlDatabase } from "@opencraft/sql";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { mergedOwnerWake, type OwnerWake, type OwnerWakeTimer } from "@opencraft/owner-wake";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import { ExecutionLeaseStore } from "@opencraft/opencraft-daemon/execution-lease-store";
import {
  RECOVERY_PROMPT,
  RecoveryNotSubmitted,
  SqlInterruptedTurnRecovery,
  type TurnRecoveryPort,
} from "@opencraft/host-recovery";
import { assembleWorkspaceHost, type WorkspaceHostAssembly } from "../assembly/workspace-host.mjs";
import { createHeadlessLifecycle, createLateBinding } from "../assembly/lifecycle.mjs";
import { migrateWorkspaceHostSql } from "../assembly/workspace-host-sql.js";
import {
  WORKSPACE_HOST_HEADER,
  workspaceHostMethod,
  workspaceHostObjectOperation,
  type WorkspaceHostInternalOperation,
  type WorkspaceHostOperation,
} from "../workspace-host-routes.js";
import { attachWorkspaceEngine, workspaceExecutionRecovery, type WorkspaceEngine } from "./workspace-engine.js";
import type { WorkspaceHostEnv, WorkspaceHostState } from "./bindings.js";

/** The class name the deployment binds the workspace container to (`cloudflare://WorkspaceHost`). */
export const WORKSPACE_HOST_CONTAINER_CLASS = "WorkspaceHost";
/** Default idle policy: stop the container after 15 minutes without work (§3.7.2). */
export const WORKSPACE_IDLE_DEFAULT_MS = 15 * 60_000;
/** Default budget of a workspace container (the sandbox contract's 4 vCPU / 8 GiB). */
const BUDGET = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
/** A credential lease lives this long; the object renews it at half its life. */
export const CREDENTIAL_LEASE_TTL_MS = 10 * 60_000;
const RUNTIME_OBJECT = (name: string) => name.startsWith("_cf_");

/** The workspace an object serves, bound once by the owner that places it. */
export interface WorkspaceIdentity {
  readonly workspace: string;
  /** The installation's machine id: the execution servers are `server:<machine>:<engine>`. */
  readonly machine: string;
}

/**
 * The account owner's credential leases as the WorkspaceHost uses them: the
 * structural subset of `CredentialLeases` (`@opencraft/account-pool-host/credential-leases`,
 * the AccountCore contract). The holder is one engine in one container
 * incarnation; a token never enters the container or durable storage.
 */
export interface WorkspaceCredentialLeases {
  grant(
    holder: { readonly workspace: string; readonly engine: string; readonly incarnation: string },
    ttlMs: number,
  ): Promise<{ readonly id: string; readonly token: string; readonly expiresAt: number }>;
  renew(id: string, ttlMs: number): Promise<{ readonly id: string; readonly expiresAt: number }>;
  revokeHolder(match: {
    readonly workspace: string;
    readonly engine?: string;
    readonly keepIncarnation?: string;
  }): Promise<number>;
}

interface Settings {
  readonly image: string;
  readonly python: string;
  /** Null: resident. */
  readonly idleMs: number | null;
  readonly engines: readonly string[];
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const IMAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const MACHINE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const ENGINE = /^(?:pi|dsh)$/u;

/** Parses the object's configuration; a malformed binding keeps the object closed. */
export function workspaceHostSettings(env: WorkspaceHostEnv): Settings {
  const image = env.OPENCRAFT_WORKSPACE_IMAGE ?? "workspace";
  const python = env.OPENCRAFT_WORKSPACE_PYTHON ?? "/usr/bin/python3";
  const idle = env.OPENCRAFT_WORKSPACE_IDLE ?? String(WORKSPACE_IDLE_DEFAULT_MS);
  const engines = (env.OPENCRAFT_WORKSPACE_ENGINES ?? "pi").split(",").map((engine) => engine.trim());
  const idleMs = idle === "resident" ? null : /^\d{1,9}$/u.test(idle) ? Number(idle) : NaN;
  if (
    !IMAGE_NAME.test(image) ||
    !python.startsWith("/") ||
    python.includes("\0") ||
    (idleMs !== null && !(idleMs >= 100 && idleMs <= 6 * 3600_000)) ||
    !engines.length ||
    !engines.every((engine) => ENGINE.test(engine)) ||
    new Set(engines).size !== engines.length
  )
    throw new Error("Invalid WorkspaceHost configuration");
  return { image, python, idleMs, engines };
}

/** Workspace placement records in the object's state documents (Node: `placement.json`). */
function placementStore(documents: StateDocumentStore) {
  const key = (address: SandboxEnvironmentAddress) =>
    `placement-${formatSandboxEnvironmentUri(address).replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  return {
    read: async (address: SandboxEnvironmentAddress) =>
      ((await documents.read(key(address))) as WorkspacePlacementRecord | null) ?? undefined,
    write: (address: SandboxEnvironmentAddress, record: WorkspacePlacementRecord) =>
      documents.update(key(address), () => ({ result: undefined, next: record })),
  };
}

/** What the object serves once a workspace is bound and opened. */
interface Services {
  readonly identity: WorkspaceIdentity;
  readonly runtime: WorkspaceRuntime;
  readonly module: WorkspaceHostAssembly;
  readonly engine: WorkspaceEngine;
  readonly leases: ExecutionLeaseStore;
  readonly recovery: SqlInterruptedTurnRecovery;
  readonly conversationExecution: { add(...args: unknown[]): Promise<unknown> };
  resolveExecutionNative(threadId: string): Promise<{ pid: number; incarnation: string } | null>;
}

export class WorkspaceHost {
  protected readonly ctx: WorkspaceHostState;
  #settings: Settings | undefined;
  #documents: StateDocumentStore;
  #services: Services | undefined;
  #failure: unknown;
  #wake: (() => void) | null = null;
  #closing: Promise<void> | undefined;
  #disposers: (() => unknown)[] = [];
  /** False until the workspace opened: no use may start the container from inside the open. */
  #available = false;
  /** The agent incarnation bound now; undefined while no environment is bound. */
  #bound: string | undefined;
  #connections = 0;
  /** True while the idle judgement reads the engine. */
  #judging = false;
  #lastUse = Date.now();
  #idleTimer: OwnerWakeTimer | undefined;
  #renewTimer: OwnerWakeTimer | undefined;
  #held = new Map<string, { id: string; token: string; expiresAt: number; incarnation: string }>();
  #events: Promise<void> = Promise.resolve();
  readonly #serial = new Map<string, Promise<unknown>>();

  constructor(ctx: WorkspaceHostState, env: WorkspaceHostEnv) {
    this.ctx = ctx;
    this.#documents = durableObjectStateDocumentStore(ctx.storage, { prefix: "workspace-host/" });
    // Before any request: the container backstop is re-armed on every construction
    // (the platform does not keep it), then a bound workspace reopens. A refused or
    // failed open keeps the object closed: every operation answers 503.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.#settings = workspaceHostSettings(env);
        const container = this.container();
        if (container && this.#settings.idleMs !== null)
          await armCloudflareContainerTimeout(container, this.#settings.idleMs).catch(() => undefined);
        const identity = (await this.#documents.read("identity")) as WorkspaceIdentity | null;
        if (identity) this.#services = await this.#open(identity);
      } catch (error) {
        this.#failure = error;
        await this.close().catch(() => undefined);
      }
    });
  }

  /** `ctx.container`; absent when the class is not bound to a container application. */
  protected container(): DurableObjectContainer | undefined {
    return this.ctx.container;
  }

  /**
   * The account owner's lease port. Absent until the AccountCore lease exchange is
   * assembled (cloudflare-deployment §5.6); the object then requests no lease and the
   * container reaches no model.
   */
  protected credentialLeases(): WorkspaceCredentialLeases | undefined {
    return undefined;
  }

  /** The object's single alarm as the owner wake-up port; `at` is wall-clock time, as an alarm's is. */
  #alarmWake(): OwnerWake {
    const storage = this.ctx.storage;
    return {
      now: () => Date.now(),
      timer: (wake) => {
        this.#wake = wake;
        return {
          arm: (at) => void storage.setAlarm(at).catch(() => undefined),
          cancel: () => void storage.deleteAlarm().catch(() => undefined),
        };
      },
    };
  }

  /** Runs `work` after earlier placement work; the object stays resident until it settles. */
  #enqueue(work: () => Promise<void>) {
    const next = this.#events
      .then(work)
      .catch((error) =>
        console.warn("[workspace-host]", JSON.stringify({ event: "placement-work-failed", error: describe(error) })),
      );
    this.#events = next;
    this.ctx.waitUntil(next);
  }

  async #open(identity: WorkspaceIdentity): Promise<Services> {
    const settings = this.#settings!;
    const container = this.container();
    if (!container) throw new Error("WorkspaceHost has no container binding");
    const storage = this.ctx.storage;
    // The named disposers in shutdown order; each tolerates what was never opened.
    const opened: {
      pool?: Awaited<ReturnType<typeof createSandboxPool>>;
      runtime?: WorkspaceRuntime;
      recovery?: SqlInterruptedTurnRecovery;
      module?: WorkspaceHostAssembly;
    } = {};
    const lifecycle = createHeadlessLifecycle();
    this.#disposers = [
      () => lifecycle.shutdown(async () => {}),
      () => opened.module?.closeEngine(),
      () => opened.module?.closeExecutionRecovery(),
      () => opened.module?.closeIdentityOverlay(),
      () => opened.module?.closeExecutionDatabase(),
      () => opened.recovery?.close(),
      // Releasing the binding stops the container: a retired workspace keeps nothing running.
      () => opened.runtime?.close(),
      () => opened.pool?.close(),
    ];
    const database: SqlDatabase = durableObjectSqlDatabase(storage);
    migrateWorkspaceHostSql(database, { ownedByRuntime: RUNTIME_OBJECT });
    const ownerWake = mergedOwnerWake(this.#alarmWake());
    this.#idleTimer = ownerWake.timer(() => void this.#idleCheck());
    this.#renewTimer = ownerWake.timer(() => this.#enqueue(() => this.#renewLeases()));

    // The environment: provider registry → backend → pool → WorkspaceRuntime, as on Docker.
    const address = parseSandboxEnvironmentUri(`cloudflare://${WORKSPACE_HOST_CONTAINER_CLASS}`);
    const installation: CloudflareInstallation = {
      backend: "cloudflare",
      image: settings.image,
      ...(settings.idleMs === null ? {} : { inactivityTimeoutMs: settings.idleMs }),
    };
    const registry = createSandboxProviderRegistry<CloudflareInstallation>({
      cloudflare: cloudflareSandboxProvider({
        containerClass: WORKSPACE_HOST_CONTAINER_CLASS,
        container,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        env: { OPENCRAFT_WORKSPACE_ID: identity.workspace, OPENCRAFT_MACHINE_ID: identity.machine },
      }),
    });
    const { definition, templateId } = registry.environment(installation, address);
    const backend = definition.createBackend({
      installation,
      readSecret: async () => {
        throw new Error("The workspace container receives no secret");
      },
      templateId,
      python: settings.python,
      timeoutMs: 600_000,
      requestTimeoutMs: 30_000,
    });
    const pool = (opened.pool = await createSandboxPool(
      { id: `workspace-${identity.workspace}`, capacity: BUDGET, defaults: BUDGET },
      backend,
    ));
    const bound = (opened.runtime = createWorkspaceRuntime({
      workspaceId: identity.workspace,
      owner: `workspace-host:${identity.workspace}`,
      environments: [{ address, pool, python: settings.python }],
      store: placementStore(this.#documents),
      onEvent: (event) => this.#placement(identity, event),
    }));
    // Every endpoint connection held open keeps the workspace from going idle.
    const counted: WorkspaceRuntime = {
      ...bound,
      workspaceId: bound.workspaceId,
      connect: async (endpoint, onData) => {
        const connection: SandboxEndpointConnection = await bound.connect(endpoint, onData);
        // The reads the idle judgement itself makes are not use.
        if (this.#judging) return connection;
        this.#connections++;
        void connection.closed.then(() => {
          this.#connections--;
          this.#touch();
        });
        return connection;
      },
    };

    const engineEndpoint: WorkspaceEndpointAddress = parseWorkspaceEndpointUri(
      `workspace://${identity.workspace}/endpoints/${settings.engines[0]}`,
    );
    const available = () => this.#available;
    const engine = attachWorkspaceEngine({
      runtime: counted,
      endpoint: engineEndpoint,
      machineId: identity.machine,
      engines: settings.engines,
      defaultEngine: settings.engines[0]!,
      available,
    });
    const leases = new ExecutionLeaseStore(database, () => null);
    const interrupted = (opened.recovery = new SqlInterruptedTurnRecovery(
      { database, close() {} },
      this.#recoveryPort(engine),
      500,
      () => !this.#closing,
      () => Date.now(),
      ownerWake.timer,
    ));

    // The same module as the Node root, step by step, with Durable Object factories.
    const assembly = (opened.module = assembleWorkspaceHost({
      lifecycle,
      capabilities: new SessionCapabilities(),
      // No client session or App Host here yet (gateway-split §4.1.1 "G1 剩余").
      appHost: createLateBinding("App Host"),
      codexBridge: createLateBinding("Codex bridge"),
      fileSystem: null,
    }));
    const absent = (name: string) => () => {
      throw new Error(`${name} is not assembled in the WorkspaceHost object`);
    };
    const conversationExecution = assembly.openConversationExecution({
      engines: settings.engines,
      engineHostDescriptor: `workspace://${identity.workspace}/endpoints/${settings.engines[0]}`,
      machineIdentity: { machineId: identity.machine },
    }) as unknown as Services["conversationExecution"];
    // Accepted Host inputs are tracked for recovery once the engine names their Turn.
    const tracked: WorkspaceEngine = {
      ...engine,
      inputs: {
        receipt: engine.inputs.receipt,
        submit: async (threadId, inputId, text, canAdmit) => {
          this.#touch();
          const receipt = await engine.inputs.submit(threadId, inputId, text, canAdmit);
          if (receipt?.state === "delivered" && receipt.turnId) interrupted.started(threadId, receipt.turnId, inputId);
          return receipt;
        },
      },
    };
    await assembly.openEngines({
      engines: settings.engines,
      machineIdentity: { machineId: identity.machine },
      actorCollaboration: { executionStarted: absent("Collaboration") },
      threadOrchestration: { invoke: absent("Thread orchestration") as never },
      readTaskConversations: absent("Task conversations"),
      startDsh: absent("An in-object DSH") as never,
      attachIndependentEngine: async () => tracked as never,
      acquirePiOwner: absent("An in-object Pi") as never,
      createPiEngine: absent("An in-object Pi") as never,
      startPiEngineHost: absent("An in-object Pi") as never,
    });
    const observation = await assembly.openExecutionObservation({
      createThreadMetadata: undefined,
      createIdentityOverlay: absent("A Thread metadata overlay") as never,
      openExecutionLeases: () => ({ database: { close() {} }, store: leases as never }),
      reportedExecutionProcess: ({ pid, incarnation }) => {
        if (!Number.isSafeInteger(pid) || pid < 1 || typeof incarnation !== "string" || !incarnation)
          throw new Error("Execution process unavailable");
        return { pid, incarnation };
      },
      observeOwnProcess: absent("An in-object execution process") as never,
      createExecutionRecovery: workspaceExecutionRecovery({ runtime: counted, available }) as never,
    });
    this.#available = true;
    // Recovery that was pending when the object was dropped continues now.
    if (interrupted.pendingThreadIds().length) interrupted.wake();
    // A container that kept running is judged idle from now on.
    if (container.running) this.#armIdle();
    return {
      identity,
      runtime: counted,
      module: assembly,
      engine,
      leases,
      recovery: interrupted,
      conversationExecution,
      resolveExecutionNative: observation.resolveExecutionNative,
    };
  }

  /** Interrupted Turns of this workspace, continued from Host state when the container's incarnation changed. */
  #recoveryPort(engine: WorkspaceEngine): TurnRecoveryPort {
    return {
      serialize: <T>(threadId: string, operation: () => Promise<T>) => {
        const previous = this.#serial.get(threadId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.#serial.set(threadId, next);
        void next
          .finally(() => {
            if (this.#serial.get(threadId) === next) this.#serial.delete(threadId);
          })
          .catch(() => undefined);
        return next;
      },
      inspect: async (row) => {
        // Only what the owner reports, attributed to the bound agent incarnation.
        let observed;
        try {
          observed = await engine.getExecutionIdentity(row.threadId);
        } catch {
          return "unknown";
        }
        const turn = observed.turn;
        if (turn && turn.id === row.turnId) return turn.status === "inProgress" ? "live" : "finished";
        // A newer native Turn found during recovery takes precedence.
        if (turn) return "finished";
        // The incarnation that ran it is gone (positive evidence recorded on loss) and this one has none.
        return row.state === "interrupted" ? "lost" : "unknown";
      },
      continue: async (row, current, admit) => {
        if (!current()) throw new RecoveryNotSubmitted();
        // A system continuation with the Host-owned recovery input id; the original input is never replayed.
        const receipt = await engine.inputs.submit(row.threadId, row.inputId!, RECOVERY_PROMPT, async () => admit());
        if (!receipt) throw new RecoveryNotSubmitted();
        if (receipt.state === "discarded") throw new RecoveryNotSubmitted();
        return receipt.state === "delivered" ? receipt.turnId : null;
      },
      changed: () => {
        // No client session is attached to this object yet; the notice is read from Host state.
      },
    };
  }

  /** Placement events of the workspace runtime: new incarnations, losses and sleeps. */
  #placement(identity: WorkspaceIdentity, event: WorkspacePlacementEvent) {
    if (event.type === "attached" || event.type === "created" || event.type === "incarnation-changed") {
      const incarnation = event.incarnation;
      this.#bound = incarnation;
      this.#touch();
      // A new agent incarnation is the evidence that the previous execution process ended.
      // Applied before the binding is used, so no Turn of the new incarnation is taken for lost.
      if (event.type === "incarnation-changed" || (event.type === "created" && event.previous)) this.#executionLost();
      this.#enqueue(async () => {
        await this.#documents.update("epoch", (current) => {
          const value = (current as { epoch: number; incarnation: string } | null) ?? { epoch: 0, incarnation: "" };
          return {
            result: undefined,
            next: value.incarnation === incarnation ? value : { epoch: value.epoch + 1, incarnation },
          };
        });
        await this.#grantLeases(identity, incarnation);
      });
    } else if (event.type === "released") {
      this.#bound = undefined;
      // The provider confirmed the container stopped without the owner (`monitor()`): execution ended.
      if (event.reason.startsWith("lost:")) this.#executionLost();
      this.#enqueue(() => this.#revokeLeases(identity));
    }
  }

  /** Every Turn the lost incarnation was running is interrupted; recovery continues them. */
  #executionLost() {
    const services = this.#services;
    if (!services) return;
    services.leases.suspend();
    services.recovery.lost();
    services.recovery.wake();
  }

  async #grantLeases(identity: WorkspaceIdentity, incarnation: string) {
    const port = this.credentialLeases();
    if (!port) return;
    for (const engine of this.#settings!.engines) {
      if (this.#held.get(engine)?.incarnation === incarnation) continue;
      await port.revokeHolder({ workspace: identity.workspace, engine });
      const lease = await port.grant({ workspace: identity.workspace, engine, incarnation }, CREDENTIAL_LEASE_TTL_MS);
      this.#held.set(engine, { id: lease.id, token: lease.token, expiresAt: lease.expiresAt, incarnation });
    }
    this.#armRenewal();
  }

  async #revokeLeases(identity: WorkspaceIdentity) {
    this.#held.clear();
    this.#renewTimer?.cancel();
    await this.credentialLeases()?.revokeHolder({ workspace: identity.workspace });
  }

  #armRenewal() {
    const next = Math.min(...[...this.#held.values()].map((lease) => lease.expiresAt - CREDENTIAL_LEASE_TTL_MS / 2));
    if (Number.isFinite(next)) this.#renewTimer?.arm(next);
    else this.#renewTimer?.cancel();
  }

  async #renewLeases() {
    const port = this.credentialLeases(),
      identity = this.#services?.identity;
    if (!port || !identity) return;
    for (const [engine, lease] of this.#held) {
      if (lease.incarnation !== this.#bound) continue;
      try {
        const renewed = await port.renew(lease.id, CREDENTIAL_LEASE_TTL_MS);
        this.#held.set(engine, { ...lease, expiresAt: renewed.expiresAt });
      } catch {
        // An expired or revoked lease is replaced for the same incarnation.
        const granted = await port.grant(
          { workspace: identity.workspace, engine, incarnation: lease.incarnation },
          CREDENTIAL_LEASE_TTL_MS,
        );
        this.#held.set(engine, { ...granted, incarnation: lease.incarnation });
      }
    }
    this.#armRenewal();
  }

  /** The lease token an engine's model requests are forwarded with (the edge's outbound handler). */
  protected modelLease(engine: string): { readonly token: string; readonly expiresAt: number } | undefined {
    const lease = this.#held.get(engine);
    return lease && lease.incarnation === this.#bound && lease.expiresAt > Date.now()
      ? { token: lease.token, expiresAt: lease.expiresAt }
      : undefined;
  }

  #touch() {
    this.#lastUse = Date.now();
    this.#armIdle();
  }

  #armIdle() {
    const idleMs = this.#settings?.idleMs;
    if (idleMs === null || idleMs === undefined || this.#closing) return;
    this.#idleTimer?.arm(this.#lastUse + idleMs);
  }

  /**
   * The idle policy (§3.7.2), judged by this object, never by the provider's
   * activity meter: no endpoint connection, no Turn the engine reports in
   * progress, no pending recovery. Then the container stops; the alarm keeps
   * every owner wake-up, so schedules and recovery still fire while it sleeps.
   */
  async #idleCheck() {
    const services = this.#services,
      idleMs = this.#settings?.idleMs;
    if (!services || idleMs === null || idleMs === undefined || this.#closing) return;
    if (Date.now() < this.#lastUse + idleMs) return this.#armIdle();
    const container = this.container();
    if (this.#bound === undefined && !container?.running) return;
    const busy = async () => {
      if (this.#connections > 0) return true;
      await services.recovery.recover().catch(() => undefined);
      if (services.recovery.pendingThreadIds().length) return true;
      // Leases the engine still runs keep the workspace awake; finished ones are settled.
      for (const threadId of services.leases.unsettledThreads().slice(0, 256)) {
        let observation;
        try {
          observation = await services.engine.getExecutionIdentity(threadId);
        } catch {
          continue;
        }
        const turn = observation.turn;
        if (!turn) continue;
        if (turn.status === "inProgress") return true;
        services.leases.reconcile(
          threadId,
          [
            {
              id: turn.id,
              status: turn.status,
              items: turn.inputId ? [{ type: "userMessage", clientId: turn.inputId }] : [],
            },
          ],
          observation.incarnation ?? undefined,
        );
      }
      return this.#connections > 0;
    };
    this.#judging = true;
    let working: boolean;
    try {
      working = await busy();
    } finally {
      this.#judging = false;
    }
    if (working) {
      this.#lastUse = Date.now();
      return this.#armIdle();
    }
    if (Date.now() < this.#lastUse + idleMs) return this.#armIdle();
    // A container that kept running across an object reset is bound before it is stopped.
    if (this.#bound === undefined) await services.runtime.observe().catch(() => undefined);
    await services.runtime.sleep();
    this.#idleTimer?.cancel();
  }

  /** The opened services; throws when the workspace is unbound or its open failed. */
  protected services(): Services {
    if (!this.#services) throw new Error(`WorkspaceHost is unavailable: ${describe(this.#failure)}`);
    return this.#services;
  }

  /**
   * Runs the named disposers once, in order, settling every one. The platform
   * drops an evicted object's memory without an event; durable state is already
   * committed, and the container keeps running for the next construction to attach.
   */
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#available = false;
      this.#idleTimer?.cancel();
      this.#renewTimer?.cancel();
      const failures: unknown[] = [];
      for (const dispose of this.#disposers.splice(0)) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      this.#services = undefined;
      if (failures.length) throw new AggregateError(failures, "WorkspaceHost close failed");
    })());
  }

  /** The object's alarm: wakes whichever owner work is due; each re-derives from state. */
  async alarm(): Promise<void> {
    this.#wake?.();
  }

  /** Binds the object to its workspace once and opens it; the same identity again is a no-op. */
  async #bind(identity: unknown): Promise<Response> {
    const value = identity as Partial<WorkspaceIdentity> | null;
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some((key) => key !== "workspace" && key !== "machine") ||
      typeof value.workspace !== "string" ||
      typeof value.machine !== "string" ||
      !MACHINE_ID.test(value.machine)
    )
      return json({ error: "invalid_workspace" }, 400);
    try {
      parseWorkspaceEndpointUri(`workspace://${value.workspace}/endpoints/control`);
    } catch {
      return json({ error: "invalid_workspace" }, 400);
    }
    const stored = (await this.#documents.read("identity")) as WorkspaceIdentity | null;
    if (stored) {
      if (stored.workspace !== value.workspace || stored.machine !== value.machine)
        return json({ error: "workspace_conflict" }, 409);
      return this.#status();
    }
    if (this.#closing || !this.#settings) return json({ error: "workspace_unavailable" }, 503);
    await this.ctx.blockConcurrencyWhile(async () => {
      const next: WorkspaceIdentity = { workspace: value.workspace!, machine: value.machine! };
      await this.#documents.update("identity", () => ({ result: undefined, next }));
      try {
        this.#services = await this.#open(next);
      } catch (error) {
        this.#failure = error;
        await this.close().catch(() => undefined);
      }
    });
    return this.#status();
  }

  async #status(): Promise<Response> {
    const services = this.#services;
    const identity = (await this.#documents.read("identity")) as WorkspaceIdentity | null;
    if (!identity) return json({ state: "unbound" });
    if (!services) return json({ workspace: identity.workspace, state: "unavailable" }, 503);
    const epoch = ((await this.#documents.read("epoch")) as { epoch: number } | null)?.epoch ?? 0;
    const idleMs = this.#settings!.idleMs;
    return json({
      workspace: identity.workspace,
      state: "open",
      environment: {
        bound: this.#bound !== undefined,
        running: this.container()?.running === true,
        ...(this.#bound ? { incarnation: this.#bound } : {}),
        epoch,
      },
      idle: idleMs === null ? { mode: "resident" } : { mode: "sleep", afterMs: idleMs },
      recovery: { pending: services.recovery.pendingThreadIds() },
      leases: [...this.#held.keys()].sort(),
    });
  }

  /** The object's front door: operator operations and owner-to-owner operations on its workspace. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const operation = workspaceHostObjectOperation(url.pathname);
    if (!operation) return json({ error: "missing" }, 404);
    if (request.method !== workspaceHostMethod(operation)) return json({ error: "method_not_allowed" }, 405);
    const named = request.headers.get(WORKSPACE_HOST_HEADER);
    if (operation === "open") return this.#bind(await request.json().catch(() => null));
    const identity = (await this.#documents.read("identity")) as WorkspaceIdentity | null;
    if (identity && named !== identity.workspace) return json({ error: "workspace_conflict" }, 409);
    if (operation === "status") return this.#status();
    if (!identity) return json({ error: "workspace_unbound" }, 409);
    if (!this.#services) return json({ error: "workspace_unavailable" }, 503);
    try {
      return await this.#operate(operation, request, url);
    } catch (error) {
      const code = error instanceof SandboxFault ? error.code : undefined;
      return json({ error: "workspace_operation_failed", ...(code ? { code } : {}) }, 503);
    }
  }

  async #operate(
    operation: Exclude<WorkspaceHostOperation | WorkspaceHostInternalOperation, "open" | "status">,
    request: Request,
    url: URL,
  ): Promise<Response> {
    const services = this.services();
    switch (operation) {
      case "wake": {
        this.#touch();
        await services.runtime.observe();
        return this.#status();
      }
      case "sleep": {
        await services.runtime.sleep();
        this.#idleTimer?.cancel();
        return this.#status();
      }
      case "inputs": {
        // An explicit Host input (an agent, schedule or goal): the module records its lease.
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const engine = this.#settings!.engines[0]!;
        if (
          !body ||
          typeof body.threadId !== "string" ||
          typeof body.id !== "string" ||
          typeof body.text !== "string" ||
          body.text.length > 64 * 1024
        )
          return json({ error: "invalid_input" }, 400);
        this.#touch();
        const receipt = await services.conversationExecution.add(
          {
            serverId: `server:${services.identity.machine}:${engine}`,
            hostId: "opencraft-server",
            threadId: body.threadId,
          },
          body.id,
          body.text,
          async () => true,
        );
        return json({ receipt });
      }
      case "execution": {
        const threadId = url.searchParams.get("threadId");
        if (!threadId) return json({ error: "invalid_thread" }, 400);
        this.#touch();
        return json({ native: await services.resolveExecutionNative(threadId) });
      }
    }
  }
}

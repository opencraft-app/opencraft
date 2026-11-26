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
// Not assembled here: the module's delivery, browser, capability MCP,
// and general resource and transport steps (they need the installation's services,
// the client session and Hands endpoints; see §5.7 "仍缺").
import {
  createSandboxPool,
  formatSandboxEnvironmentUri,
  isWorkspaceId,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxEnvironmentAddress,
  type SandboxEndpointConnection,
  type SandboxReceipt,
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
import { credentialLeaseExchangeClient } from "@opencraft/account-pool-host/credential-lease-exchange";
import { fetchHttpExchange } from "@opencraft/http-exchange/fetch";
import type { SqlDatabase } from "@opencraft/sql";
import { isRecordedThreadCursor, SqlThreadDirectory } from "@opencraft/app-host-server/thread-directory/domain";
import { durableObjectSqlDatabase } from "@opencraft/storage-cloudflare/sql";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { mergedOwnerWake, type OwnerWake, type OwnerWakeTimer } from "@opencraft/owner-wake";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import type { ExecutionLease } from "@opencraft/opencraft-daemon/execution-lease-store";
import { WorkspaceExecutionLeaseStore } from "@opencraft/opencraft-daemon/workspace-execution-lease-store";
import {
  RECOVERY_PROMPT,
  RecoveryNotSubmitted,
  SqlInterruptedTurnRecovery,
  type TurnRecoveryPort,
} from "@opencraft/host-recovery";
import { assembleWorkspaceHost, type WorkspaceHostAssembly } from "../assembly/workspace-host.mjs";
import { createHeadlessLifecycle, createLateBinding } from "../assembly/lifecycle.mjs";
import { migrateWorkspaceHostSql } from "../assembly/workspace-host-sql.js";
import { releaseTerminalThread } from "@opencraft/local-agent-host/terminal-owner-link";
import {
  WORKSPACE_CODEX_READ_OPERATION,
  WORKSPACE_CODEX_THREAD_LIST_OPERATION,
  WORKSPACE_CODEX_MODEL_LIST_OPERATION,
  WORKSPACE_CODEX_CONTROL_OPERATION,
  WORKSPACE_CODEX_START_OPERATION,
  WORKSPACE_CODEX_TURN_OPERATION,
  WORKSPACE_FILES_OPERATION,
  WORKSPACE_PROJECTS_OPERATION,
  WORKSPACE_HOST_HEADER,
  WORKSPACE_TERMINAL_COMMAND_BYTES,
  WORKSPACE_TERMINAL_COMMAND_OPERATION,
  WORKSPACE_TERMINAL_OPERATION,
  WORKSPACE_TERMINAL_RELEASE_OPERATION,
  WORKSPACE_TERMINAL_SESSION_HEADER,
  workspaceCodexEgressTarget,
  workspaceHostMethod,
  workspaceHostObjectOperation,
  type WorkspaceHostInternalOperation,
  type WorkspaceHostOperation,
} from "../workspace-host-routes.js";
import { attachWorkspaceEngine, workspaceExecutionRecovery, type WorkspaceEngine } from "./workspace-engine.js";
import type { WorkspaceHostEnv, WorkspaceHostState } from "./bindings.js";
import {
  CODEX_THREAD_ARCHIVED,
  initialCodexTurnsRead,
  isCodexThreadResult,
  isCodexHistoryResult,
  isCodexHistorySizeError,
  lookupCodexThread,
  parseWorkspaceCodexRead,
  readsOrdinaryCodexHistoryBody,
} from "./codex-thread-read.js";
import { CODEX_THREAD_START_BODY_BYTES, createdCodexThreadId, currentCodexStart, parseCodexStartAuthority } from "./codex-thread-start.js";
import { parseCodexModelList } from "./codex-model-list.js";
import { parseCodexThreadList, parseCodexThreadPage } from "./codex-thread-list.js";
import { ACCOUNT_CORE_OBJECT } from "./account-core.js";
import {
  WORKSPACE_ASSETS_ENVIRONMENT_PATH,
  WORKSPACE_CODEX_CATALOG_PATH,
  WORKSPACE_CODEX_MODEL_DIRECTORY_PATH,
} from "../account-routes.js";
import { CODEX_TURN_STREAM_TYPE, CODEX_WORKBENCH_THREAD_CONFIG, codexTurnAuthority, isDefinitiveCodexSteerRefusal, matchesCodexResume, parseCodexThreadMutationReceipt, parseCodexTurnCall, parseCodexTurnOperationCall, runCodexTurn, type CodexResume, type CodexThreadMutation, type CodexTurnControls, type TurnAuthority, type TurnStreamFrame } from "./codex-turn.js";
import { HostInteractions, InteractionFault, InteractionResponseNotDispatched } from "@opencraft/app-host-server/interactions";
import {
  isRuntimeMachineId, isTerminalResourceScopeId, threadCatalogEntry, SHARED_INTERACTIONS_CHANGED,
  parseThreadCatalogTurnCompletion, WORKSPACE_FILE_SCOPE_METHOD, type JsonRpcNotification,
} from "@opencraft/appserver-protocol";
import { parseClientAttachment, readClientAttachment, type ClientAttachment } from "./client-attachment.js";
import { egressHandler } from "./egress.js";
import { INSTALLATION_CORE_OBJECT } from "./installation-core.js";
import {
  THREAD_PLACEMENT_PUBLISH_PATH,
  WorkspaceThreadPlacements,
  parseThreadPlacementKey,
  parseThreadPlacementReceipt,
  sameThreadPlacement,
  type ThreadPlacementReceipt,
} from "./thread-placement.js";
import { attachWorkspaceCodex, bridgeWorkspaceCodex, isWorkspaceCodexLane, type WorkspaceCodex } from "./workspace-codex.js";
import { checkWorkspaceBridge, createWorkspaceBridge } from "./workspace-bridge.js";
import { EndpointRpcError } from "./workspace-link.js";
import { openWorkspaceTerminal } from "./workspace-terminal.js";
import { acceptWorkspaceTerminal, readWorkspaceTerminalInventory, type WorkspaceTerminalOptions } from "./workspace-terminal-session.js";
import {
  captureWorkspaceHistory, isWorkspaceHistoryPreviewCursor, readWorkspaceHistory,
  recordWorkspaceHistory, WORKSPACE_HISTORY_PREVIEW_THREADS,
} from "./workspace-history-preview.js";
import { captureWorkspaceProjects, PROJECT_DIRECTORY_CURSOR_PREFIX, readWorkspaceProjects, recordWorkspaceProjects } from "./workspace-project-directory.js";
import { directoryCheckpoint, matchesDirectoryCheckpoint } from "./workspace-directory-checkpoint.js";
import {
  parseThreadResourceObservation, terminalAdmission, WORKSPACE_THREAD_RESOURCES_PATH, type TerminalScope, type ThreadResourceObservation,
} from "./terminal-authority.js";
import { CODEX_WORKBENCH_HOST_ID, codexActorWorkspace, isCodexActorWorkspace, isCodexWorkspaceOwner } from "./codex-workspace.js";
import { isWorkspaceFilePath, parseWorkspaceFileCall, requestWorkspaceFile } from "./workspace-files.js";
import { PROJECTLESS_WORKSPACE } from "./workspace-paths.js";
import { isWorkspaceProjectResult, parseWorkspaceProjectAssignment, parseWorkspaceProjectCall, projectMatchesAssignment,
  workspaceProjectPage, type WorkspaceProjectAssignment } from "./workspace-projects.js";

/** The class name the deployment binds the workspace container to (`cloudflare://WorkspaceHost`). */
export const WORKSPACE_HOST_CONTAINER_CLASS = "WorkspaceHost";
/** Default idle policy: stop the container after 15 minutes without work (§3.7.2). */
export const WORKSPACE_IDLE_DEFAULT_MS = 15 * 60_000;
/** Default budget of a workspace container (the sandbox contract's 4 vCPU / 8 GiB). */
const BUDGET = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const RESOURCE_OBSERVATION = "thread-resource-observation";
const RESOURCE_OBSERVATION_RETRY_MS = 5_000;

function pendingThreadResources(document: unknown): ThreadResourceObservation | undefined {
  if (document === null) return undefined;
  const pending = (document as { pending?: unknown } | null)?.pending;
  if (pending === null) return undefined;
  const observation = parseThreadResourceObservation(pending);
  if (!observation) throw Error("Invalid committed conversation resource observation");
  return observation;
}
/** A credential lease lives this long; the object renews it at half its life. */
export const CREDENTIAL_LEASE_TTL_MS = 10 * 60_000;
export const WORKSPACE_MODEL_INTERCEPT_HEADER = "x-opencraft-workspace-model-intercept";
const RUNTIME_OBJECT = (name: string) => name.startsWith("_cf_");

/** The workspace an object serves, bound once by the owner that places it. */
export interface WorkspaceIdentity {
  readonly workspace: string;
  /** The installation's machine id: the execution servers are `server:<machine>:<engine>`. */
  readonly machine: string;
  readonly ownerActorId?: string;
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
  readonly user?: string;
  /** Null: resident. */
  readonly idleMs: number | null;
  readonly engines: readonly string[];
  readonly engineHostEngines: readonly string[];
  readonly codex: boolean;
  readonly codexSnapshots: boolean;
  readonly codexBridgeEndpoint: boolean;
  readonly codexEgress?: { readonly origin: string; readonly provider: string };
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const IMAGE_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const ENGINE = /^(?:pi|dsh)$/u;

async function parseWorkspaceIdentity(value: unknown): Promise<WorkspaceIdentity | null> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => key !== "workspace" && key !== "machine" && key !== "ownerActorId")) return null;
  const { workspace, machine, ownerActorId } = value as Partial<WorkspaceIdentity>;
  if (!isWorkspaceId(workspace) || !isRuntimeMachineId(machine)) return null;
  if (ownerActorId === undefined) return isCodexActorWorkspace(workspace) ? null : { workspace, machine };
  return isCodexWorkspaceOwner(ownerActorId) && await codexActorWorkspace(machine, ownerActorId) === workspace
    ? { workspace, machine, ownerActorId } : null;
}

/** Parses the object's configuration; a malformed binding keeps the object closed. */
export function workspaceHostSettings(env: WorkspaceHostEnv): Settings {
  const image = env.OPENCRAFT_WORKSPACE_IMAGE ?? "workspace";
  const python = env.OPENCRAFT_WORKSPACE_PYTHON ?? "/usr/bin/python3";
  const user = env.OPENCRAFT_WORKSPACE_USER;
  const idle = env.OPENCRAFT_WORKSPACE_IDLE ?? String(WORKSPACE_IDLE_DEFAULT_MS);
  const engines = (env.OPENCRAFT_WORKSPACE_ENGINES ?? "pi").split(",").map((engine) => engine.trim());
  const engineHostEngines = engines.filter((engine) => engine !== "codex");
  const codex = engines.includes("codex");
  const codexSnapshots = codex && env.OPENCRAFT_WORKSPACE_CODEX_SNAPSHOTS === "true";
  const bridge = env.OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT;
  const codexBridgeEndpoint = bridge === "true";
  const origin = env.OPENCRAFT_WORKSPACE_CODEX_EGRESS_ORIGIN;
  const provider = env.OPENCRAFT_WORKSPACE_CODEX_EGRESS_PROVIDER;
  const idleMs = idle === "resident" ? null : /^\d{1,9}$/u.test(idle) ? Number(idle) : NaN;
  if (
    !IMAGE_NAME.test(image) ||
    (user !== undefined && !/^[1-9]\d{0,8}:[1-9]\d{0,8}$/u.test(user)) ||
    !python.startsWith("/") ||
    python.includes("\0") ||
    (idleMs !== null && !(idleMs >= 100 && idleMs <= 6 * 3600_000)) ||
    !engineHostEngines.length ||
    !engineHostEngines.every((engine) => ENGINE.test(engine)) ||
    (codex && !codexSnapshots && idleMs !== null) ||
    (bridge !== undefined && bridge !== "false" && (!codexBridgeEndpoint || !codex || !origin || !provider)) ||
    ((origin !== undefined || provider !== undefined) && (!codex || !origin || !provider)) ||
    new Set(engines).size !== engines.length
  )
    throw new Error("Invalid WorkspaceHost configuration");
  if (origin && provider) workspaceCodexEgressTarget(origin, provider);
  return {
    image, python, idleMs, engines, engineHostEngines, codex, codexSnapshots, codexBridgeEndpoint,
    ...(user ? { user } : {}),
    ...(origin && provider ? { codexEgress: { origin, provider } } : {}),
  };
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
  readonly codex?: WorkspaceCodex;
  readonly bridge?: ReturnType<typeof createWorkspaceBridge>;
  readonly codexTurns: boolean;
  neverStarted(): Promise<boolean>;
  recordedPlacement(): Promise<WorkspacePlacementRecord | undefined>;
  passiveReceipt(): Promise<SandboxReceipt | undefined>;
  restoreHistoryReceipt(snapshot: string): Promise<SandboxReceipt | undefined>;
  readonly threadDirectory?: {
    readonly catalog: SqlThreadDirectory;
    refresh(receipt: SandboxReceipt): Promise<void>;
  };
  readonly threadPlacements: WorkspaceThreadPlacements;
  readonly leases: WorkspaceExecutionLeaseStore;
  readonly recovery: SqlInterruptedTurnRecovery;
  readonly conversationExecution: { add(...args: unknown[]): Promise<unknown> };
  resolveExecutionNative(threadId: string): Promise<{ pid: number; incarnation: string } | null>;
}

interface ActiveCodexTurn extends Partial<CodexTurnControls> {
  readonly threadId: string;
  readonly abort: AbortController;
  readonly observers: Set<(event?: JsonRpcNotification) => void>;
  current(): Promise<boolean>;
  incarnation?: string;
  turnId?: string;
}

function ownsCodexExecution(lease: ExecutionLease | null, principal: TurnAuthority["principal"]): lease is ExecutionLease {
  return lease?.ownership === "human" && lease.principal?.actorId === principal.actorId &&
    lease.principal.actorGeneration === principal.actorGeneration &&
    lease.principal.provider === principal.provider && lease.principal.subject === principal.subject;
}

function finishCodexObservers(turn: ActiveCodexTurn) {
  turn.resume = undefined;
  for (const observer of turn.observers) observer();
  turn.observers.clear();
}

async function turnCompletionDocument(threadId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadId));
  return `turn-completion-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class WorkspaceHost {
  protected readonly ctx: WorkspaceHostState;
  #settings: Settings | undefined;
  #documents: StateDocumentStore;
  readonly #codexCreations: StateDocumentStore;
  readonly #account: WorkspaceHostEnv["ACCOUNT_CORE"];
  readonly #turnsEnabled: boolean;
  readonly #filesEnabled: boolean;
  readonly #projectsEnabled: boolean;
  readonly #terminalSessions = new Map<string, {
    attachmentKey: string;
    session: ReturnType<typeof acceptWorkspaceTerminal>;
  }>();
  #codexEgressEnabled = false;
  #codexEgressNonce: string | undefined;
  #activeCodexTurn: ActiveCodexTurn | undefined;
  #reattachingCodexTurn: Promise<void> | undefined;
  readonly #codexInteractions = new HostInteractions();
  readonly #installation: WorkspaceHostEnv["INSTALLATION_CORE"];
  #services: Services | undefined;
  #failure: unknown;
  #wake: (() => void) | null = null;
  #closing: Promise<void> | undefined;
  #disposers: (() => unknown)[] = [];
  /** False until the workspace opened: no use may start the container from inside the open. */
  #available = false;
  #sleepingCodex: Promise<boolean> | undefined;
  #operations = 0;
  /** The agent incarnation bound now; undefined while no environment is bound. */
  #bound: string | undefined;
  #connections = 0;
  #codexReads = 0;
  #codexStarting = false;
  /** True while the idle judgement reads the engine. */
  #judging = false;
  #lastUse = Date.now();
  #durableLastUse = 0;
  #idleTimer: OwnerWakeTimer | undefined;
  #renewTimer: OwnerWakeTimer | undefined;
  #resourceRetry: OwnerWakeTimer | undefined;
  #pendingResourceObservation: ThreadResourceObservation | undefined;
  #publishingResources: Promise<void> | undefined;
  #held = new Map<string, { id: string; token: string; expiresAt: number; incarnation: string }>();
  #events: Promise<void> = Promise.resolve();
  readonly #serial = new Map<string, Promise<unknown>>();

  constructor(ctx: WorkspaceHostState, env: WorkspaceHostEnv) {
    this.ctx = ctx;
    this.#installation = env.INSTALLATION_CORE;
    this.#account = env.ACCOUNT_CORE;
    this.#turnsEnabled = env.OPENCRAFT_WORKSPACE_CODEX_TURNS === "true";
    this.#filesEnabled = this.#turnsEnabled && env.OPENCRAFT_WORKSPACE_CODEX_FILES === "true";
    this.#projectsEnabled = this.#filesEnabled && env.OPENCRAFT_WORKSPACE_CODEX_PROJECTS === "true";
    this.#documents = durableObjectStateDocumentStore(ctx.storage, { prefix: "workspace-host/" });
    this.#codexCreations = durableObjectStateDocumentStore(ctx.storage, { prefix: "workspace-codex-start/" });
    // Before any request: the container backstop is re-armed on every construction
    // (the platform does not keep it), then a bound workspace reopens. A refused or
    // failed open keeps the object closed: every operation answers 503.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.#settings = workspaceHostSettings(env);
        const stored = await this.#documents.read("identity");
        const identity = await parseWorkspaceIdentity(stored);
        if (stored !== null && !identity) throw new Error("Invalid stored workspace identity");
        const container = this.container();
        if (container && this.#settings.idleMs !== null && !this.#settings.codexSnapshots)
          await armCloudflareContainerTimeout(container, this.#settings.idleMs).catch(() => undefined);
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

  /** The workspace holds a lease; the container receives no provider credential. */
  protected credentialLeases(): WorkspaceCredentialLeases | undefined {
    const accounts = this.#account;
    return this.#codexEgressEnabled && accounts
      ? credentialLeaseExchangeClient(() => accounts.get(accounts.idFromName(ACCOUNT_CORE_OBJECT)))
      : undefined;
  }

  #codexModelIntercept(container: DurableObjectContainer, workspace: string, settings: Settings) {
    const origin = settings.codexEgress?.origin;
    if (!this.#turnsEnabled || !settings.codex || !origin || !this.#account ||
      !this.ctx.exports?.WorkspaceCodexModelEgress || !container.interceptOutboundHttp) return undefined;
    const host = new URL(origin).hostname;
    return async () => {
      const nonce = crypto.randomUUID();
      const entry = this.ctx.exports!.WorkspaceCodexModelEgress!({ props: { workspace, nonce } });
      await container.interceptOutboundHttp!(host, entry);
      this.#codexEgressNonce = nonce;
    };
  }

  async #configuredCodexCatalog(incarnation: string) {
    const provider = this.#settings?.codexEgress?.provider;
    const account = this.#account;
    const lease = this.modelLease("codex");
    if (!provider || !account || !lease || this.#bound !== incarnation)
      return json({ error: "model_lease_unavailable" }, 503);
    const target = new URL(WORKSPACE_CODEX_CATALOG_PATH, "https://account.internal");
    target.searchParams.set("provider", provider);
    const result = await account.get(account.idFromName(ACCOUNT_CORE_OBJECT)).fetch(new Request(target, {
      headers: { authorization: `Bearer ${lease.token}` },
    }));
    if (this.#bound === incarnation) return result;
    await result.body?.cancel();
    return json({ error: "model_lease_unavailable" }, 503);
  }

  #modelDirectory() {
    const provider = this.#settings?.codexEgress?.provider;
    const account = this.#account;
    if (!provider || !account) throw new Error("Workspace model catalog unavailable");
    const target = new URL(WORKSPACE_CODEX_MODEL_DIRECTORY_PATH, "https://account.internal");
    target.searchParams.set("provider", provider);
    return { target, owner: account.get(account.idFromName(ACCOUNT_CORE_OBJECT)) };
  }

  async #hasConfiguredCodexModel(model: string) {
    const { target, owner } = this.#modelDirectory();
    target.searchParams.set("model", model);
    const response = await owner.fetch(new Request(target, { method: "HEAD" }));
    await response.body?.cancel();
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw new Error("Workspace model catalog unavailable");
  }

  async #codexModelEgress(request: Request): Promise<Response> {
    const settings = this.#settings?.codexEgress;
    const account = this.#account;
    const nonce = this.#codexEgressNonce;
    if (!nonce || !settings || !account || request.headers.get(WORKSPACE_MODEL_INTERCEPT_HEADER) !== nonce ||
      request.headers.get(WORKSPACE_HOST_HEADER) !== this.#services?.identity.workspace)
      return json({ error: "missing" }, 404);
    const url = new URL(request.url);
    const base = new URL(workspaceCodexEgressTarget(settings.origin, settings.provider));
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      return json({ error: "missing" }, 404);
    const route = url.pathname.slice(base.pathname.length);
    if (route === "models" && request.method === "GET") {
      // Codex's model selection reads the catalog before it creates a Thread.
      const incarnation = this.#bound;
      await this.#events;
      if (!incarnation || incarnation !== this.#bound || nonce !== this.#codexEgressNonce)
        return json({ error: "model_lease_unavailable" }, 503);
      const result = await this.#configuredCodexCatalog(incarnation);
      if (incarnation === this.#bound && nonce === this.#codexEgressNonce) return result;
      await result.body?.cancel();
      return json({ error: "model_lease_unavailable" }, 503);
    }
    if (route !== "responses" || request.method !== "POST") return json({ error: "missing" }, 404);
    const active = this.#activeCodexTurn;
    if (!active?.incarnation || active.incarnation !== this.#bound)
      return json({ error: "model_egress_unavailable" }, 503);
    if (!(await active.current()) || active !== this.#activeCodexTurn || active.incarnation !== this.#bound ||
      nonce !== this.#codexEgressNonce)
      return json({ error: "model_egress_denied" }, 403);
    const lease = this.modelLease("codex");
    if (!lease) return json({ error: "model_lease_unavailable" }, 503);
    const headers = new Headers();
    for (const name of ["accept", "content-type", "content-encoding"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${lease.token}`);
    return egressHandler({ ACCOUNT_CORE: account })(new Request(url, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      signal: request.signal,
    } as RequestInit));
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
      codex?: WorkspaceCodex;
      directory?: SqlThreadDirectory;
    } = {};
    const lifecycle = createHeadlessLifecycle();
    this.#disposers = [
      () => lifecycle.shutdown(async () => {}),
      () => opened.module?.closeEngine(),
      () => opened.module?.closeExecutionRecovery(),
      () => opened.module?.closeIdentityOverlay(),
      () => opened.module?.closeExecutionDatabase(),
      () => opened.recovery?.close(),
      () => opened.directory?.close(),
      () => opened.codex?.close(),
      // Releasing the binding stops the container: a retired workspace keeps nothing running.
      () => opened.runtime?.close(),
      () => opened.pool?.close(),
    ];
    const database: SqlDatabase = durableObjectSqlDatabase(storage);
    migrateWorkspaceHostSql(database, { ownedByRuntime: RUNTIME_OBJECT });
    const ownerWake = mergedOwnerWake(this.#alarmWake());
    this.#idleTimer = ownerWake.timer(() => this.ctx.waitUntil(this.#idleCheck().catch((error) => {
      this.#startup("idle-sleep-failed", { code: error instanceof SandboxFault ? error.code : "unavailable" });
      if (container.running && !this.#closing)
        this.#idleTimer?.arm(Date.now() + Math.max(settings.idleMs ?? 0, 15_000));
    })));
    this.#renewTimer = ownerWake.timer(() => this.#enqueue(() => this.#renewLeases()));
    if (identity.ownerActorId) {
      const observation = pendingThreadResources(await this.#documents.read(RESOURCE_OBSERVATION));
      if (observation) {
        if (observation.placement.workspaceId !== identity.workspace ||
          observation.placement.serverId !== `server:${identity.machine}:codex`)
          throw Error("Invalid committed conversation resource observation");
        this.#pendingResourceObservation = observation;
      }
      this.#resourceRetry = ownerWake.timer(() => this.ctx.waitUntil(this.#flushThreadResources().catch(() => undefined)));
      if (this.#pendingResourceObservation) this.#resourceRetry.arm(Date.now() + RESOURCE_OBSERVATION_RETRY_MS);
    }

    // The environment: provider registry → backend → pool → WorkspaceRuntime, as on Docker.
    const address = parseSandboxEnvironmentUri(`cloudflare://${WORKSPACE_HOST_CONTAINER_CLASS}`);
    const placements = placementStore(this.#documents);
    const prepareContainer = this.#codexModelIntercept(container, identity.workspace, settings);
    this.#codexEgressEnabled = !!prepareContainer;
    const personalEnv = await this.#personalAssetsEnvironment(identity.ownerActorId);
    const installation: CloudflareInstallation = {
      backend: "cloudflare",
      image: settings.image,
      ...(settings.user ? { user: settings.user } : {}),
      // A provider timeout cannot commit the Codex snapshot before stopping.
      ...(settings.idleMs === null || settings.codexSnapshots ? {} : { inactivityTimeoutMs: settings.idleMs }),
    };
    const registry = createSandboxProviderRegistry<CloudflareInstallation>({
      cloudflare: cloudflareSandboxProvider({
        containerClass: WORKSPACE_HOST_CONTAINER_CLASS,
        container,
        ...(prepareContainer ? { prepareContainer } : {}),
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        onLifecycle: (stage, exitCode) => this.#startup(stage, exitCode === undefined ? undefined : { exitCode }),
        env: {
          ...personalEnv,
          OPENCRAFT_WORKSPACE_ID: identity.workspace,
          OPENCRAFT_MACHINE_ID: identity.machine,
          ...(settings.codexBridgeEndpoint ? { OPENCRAFT_WORKSPACE_CODEX_BRIDGE_ENDPOINT: "true" } : {}),
          ...(settings.codexEgress ? {
            OPENCRAFT_CODEX_EGRESS_ORIGIN: settings.codexEgress.origin,
            OPENCRAFT_CODEX_EGRESS_PROVIDER: settings.codexEgress.provider,
          } : {}),
        },
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
      { id: "workspace", capacity: BUDGET, defaults: BUDGET },
      backend,
    ));
    const bound = (opened.runtime = createWorkspaceRuntime({
      workspaceId: identity.workspace,
      owner: `workspace-host:${identity.workspace}`,
      environments: [{ address, pool, python: settings.python, agentStartupTimeoutMs: 30_000,
        ...(settings.codexSnapshots ? { preserveOnSleep: true } : {}) }],
      store: placements,
      onEvent: (event) => this.#placement(identity, event),
    }));
    // Every endpoint connection held open keeps the workspace from going idle.
    const countConnection = async (open: () => Promise<SandboxEndpointConnection>) => {
      // The reads the idle judgement itself makes are not use.
      const judging = this.#judging;
      this.#connections++;
      let connection: SandboxEndpointConnection;
      try {
        connection = await open();
      } catch (error) {
        this.#connections--;
        throw error;
      }
      void connection.closed.then(() => {
        this.#connections--;
        if (!judging && !this.#sleepingCodex) this.#touch();
      });
      return connection;
    };
    const counted: WorkspaceRuntime = {
      ...bound,
      connect: (endpoint, onData) => countConnection(() => bound.connect(endpoint, onData)),
      fenced: (endpoint, operation, receipt) => bound.fenced(endpoint, binding => operation({
        ...binding, connect: onData => countConnection(() => binding.connect(onData)),
      }), receipt),
    };

    const engineEndpoint: WorkspaceEndpointAddress = parseWorkspaceEndpointUri(
      `workspace://${identity.workspace}/endpoints/${settings.engineHostEngines[0]}`,
    );
    const available = () => this.#available && !this.#sleepingCodex;
    const engine = attachWorkspaceEngine({
      runtime: counted,
      endpoint: engineEndpoint,
      machineId: identity.machine,
      engines: settings.engineHostEngines,
      defaultEngine: settings.engineHostEngines[0]!,
      available,
    });
    const leases = new WorkspaceExecutionLeaseStore(database, () => null);
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
      engines: settings.engineHostEngines,
      engineHostDescriptor: `workspace://${identity.workspace}/endpoints/${settings.engineHostEngines[0]}`,
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
      engines: settings.engineHostEngines,
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
    // The monitor belonged to the previous object instance. On reopen, the
    // platform's stopped state is enough to retire that container's execution.
    if (!container.running) {
      leases.retireLostExecutions();
      interrupted.lost();
    }
    // Recovery that was pending when the object was dropped continues now.
    if (interrupted.pendingThreadIds().length) interrupted.wake();
    if (settings.codexSnapshots && settings.idleMs !== null) {
      const persisted = await this.#documents.read("last-use");
      if (typeof persisted === "number" && Number.isSafeInteger(persisted) && persisted > 0)
        this.#lastUse = this.#durableLastUse = persisted;
    }
    if (container.running) this.#armIdle();
    const bridge = settings.codexBridgeEndpoint ? createWorkspaceBridge(counted, database, () => storage.sync(),
      (await placements.read(address))?.receipt) : undefined;
    if (settings.codex) opened.codex = attachWorkspaceCodex(counted, available,
      bridge ? { transport: bridge, serverId: `server:${identity.machine}:codex` } : undefined);
    const codex = opened.codex;
    let captureReceipt: SandboxReceipt | undefined;
    const directory = codex && settings.codexSnapshots ? new SqlThreadDirectory({ database, cursorScope: identity.workspace }, {
      refreshOnDemandOnly: true,
      streamingSync: true,
      sourceOwnsExistence: true,
      async list(params) {
        if (!captureReceipt) throw new Error("Thread directory capture requires an attached placement");
        return codex.readDirectoryAtPlacement("thread/list", params, captureReceipt);
      },
      changed() {},
    }) : undefined;
    opened.directory = directory;
    return {
      identity,
      codexTurns: this.#codexEgressEnabled,
      // The runtime commits placement before any native operation can use the
      // environment. A stopped container with a placement can still have data.
      neverStarted: async () => !container.running && !(await placements.read(address)) && !container.running,
      recordedPlacement: () => placements.read(address),
      restoreHistoryReceipt: async snapshot => (await counted.restoreExisting(address, snapshot)).receipt,
      passiveReceipt: async () => {
        if (!container.running) return undefined;
        if (!this.#bound) await counted.attachExisting().catch(() => undefined);
        const incarnation = this.#bound;
        if (!incarnation || !container.running) return undefined;
        const placement = await placements.read(address);
        return this.#bound === incarnation && container.running && placement?.agentIncarnation === incarnation
          ? placement.receipt : undefined;
      },
      ...(directory ? { threadDirectory: { catalog: directory, async refresh(receipt: SandboxReceipt) {
        captureReceipt = receipt;
        try { await directory.refresh(); } finally { captureReceipt = undefined; }
      } } } : {}),
      threadPlacements: new WorkspaceThreadPlacements(
        durableObjectStateDocumentStore(this.ctx.storage, { prefix: "workspace-thread-placement/" }),
        identity.workspace,
        `server:${identity.machine}:codex`,
      ),
      runtime: counted,
      module: assembly,
      engine,
      ...(opened.codex ? { codex: opened.codex } : {}),
      ...(bridge ? { bridge } : {}),
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

  #startup(stage: string, details?: { exitCode?: number; elapsedMs?: number; code?: string; rpcCode?: number }) {
    console.info(`OpenCraft workspace lifecycle ${JSON.stringify({ stage, ...details })}`);
  }

  /** Placement events of the workspace runtime: new incarnations, losses and sleeps. */
  #placement(identity: WorkspaceIdentity, event: WorkspacePlacementEvent) {
    if (event.type === "attached" || event.type === "created" || event.type === "incarnation-changed") {
      this.#startup(`agent-${event.type}`);
      const incarnation = event.incarnation;
      this.#bound = incarnation;
      if (!this.#sleepingCodex) this.#touch();
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
    } else if (event.type === "agent-startup-failed") {
      this.#startup(event.type, { code: event.code, elapsedMs: event.elapsedMs });
    } else if (event.type === "released") {
      this.#bound = undefined;
      // The provider confirmed the container stopped without the owner (`monitor()`): execution ended.
      if (event.reason.startsWith("lost:")) this.#executionLost();
      this.#enqueue(() => this.#revokeLeases(identity));
    }
  }

  /** Retire authority from the lost environment and wake persisted recovery. */
  #executionLost() {
    const services = this.#services;
    if (!services) return;
    services.leases.retireLostExecutions();
    services.codex?.discardUnmaterializedThreads();
    const active = this.#activeCodexTurn;
    if (active?.incarnation && active.incarnation !== this.#bound) {
      active.abort.abort(new Error("Original Codex container unavailable"));
      if (active.turnId) this.#codexInteractions.resolveTurn(active.threadId, active.turnId);
    }
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
    if (this.#settings?.codexSnapshots && this.#lastUse > this.#durableLastUse) {
      // Group closely spaced activity without allowing an evicted object to sleep early.
      const windowMs = Math.min(5_000, Math.max(1, Math.floor(idleMs / 10)));
      const at = Math.ceil(this.#lastUse / windowMs) * windowMs;
      this.#durableLastUse = at;
      this.ctx.waitUntil(this.#documents.update("last-use", () => ({ result: undefined, next: at })));
    }
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
    if (this.#judging || this.#sleepingCodex) return;
    if (Date.now() < this.#lastUse + idleMs) return this.#armIdle();
    const container = this.container();
    if (this.#bound === undefined && !container?.running) return;
    const busy = async () => {
      if (services.codex ? this.#operations > 0 || !!this.#activeCodexTurn : this.#connections > 0) return true;
      await services.recovery.recover().catch(() => undefined);
      if (services.recovery.pendingThreadIds().length) return true;
      // Leases the engine still runs keep the workspace awake; finished ones are settled.
      for (const threadId of services.leases.unsettledThreads().slice(0, 256)) {
        if (services.codex && await services.threadPlacements.readCommitted({
          serverId: `server:${services.identity.machine}:codex`, threadId,
        })) continue;
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
      return !services.codex && this.#connections > 0;
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
    if (services.codex) {
      if (!(await this.#sleepCodex(services, services.codex, idleMs))) this.#idleTimer?.arm(Date.now() + idleMs);
      return;
    }
    // A container that kept running across an object reset is bound before it is stopped.
    if (this.#bound === undefined) await services.runtime.observe().catch(() => undefined);
    await services.runtime.sleep();
    this.#idleTimer?.cancel();
  }

  async #captureHistory(services: Services, codex: WorkspaceCodex, receipt: SandboxReceipt) {
    if (!services.codexTurns || !services.threadDirectory) return [];
    const { data: recent } = await services.threadDirectory.catalog.list({
      archived: false, sortKey: "updated_at", sortDirection: "desc", limit: WORKSPACE_HISTORY_PREVIEW_THREADS, useStateDbOnly: true,
    });
    const serverId = `server:${services.identity.machine}:codex`;
    const previews = [];
    // At most two Threads in flight. Each reads metadata before probing its history window.
    for (let offset = 0; offset < recent.length; offset += 2) {
      const entries = await Promise.all(recent.slice(offset, offset + 2).map(async thread => {
        const placement = await services.threadPlacements.readCommitted({ serverId, threadId: thread.id });
        return placement?.state === "placed"
          ? captureWorkspaceHistory(placement, read => codex.readHistory(read, true, receipt)).catch(() => null)
          : null;
      }));
      previews.push(...entries.filter(entry => entry !== null));
    }
    return previews;
  }

  async #sleepCodex(services: Services, codex: WorkspaceCodex, idleMs?: number): Promise<boolean> {
    const busy = () => this.#closing || this.#operations > 0 || this.#activeCodexTurn || this.#codexStarting ||
      this.#codexReads > 0 || services.leases.unsettledThreads().length > 0 ||
      services.recovery.pendingThreadIds().length > 0 ||
      (idleMs !== undefined && Date.now() < this.#lastUse + idleMs);
    if (this.#sleepingCodex || this.#judging || busy()) return false;
    const flight = (async () => {
      if (!(await codex.releaseIdleLane()) || this.#connections > 0 || busy()) return false;
      if (!this.#bound && this.container()?.running) await services.runtime.attachExisting();
      if (this.#connections > 0 || busy()) return false;
      const before = this.container()?.running ? await services.recordedPlacement() : undefined;
      const receipt = before?.receipt;
      const threads = receipt && services.threadDirectory && await services.threadDirectory.refresh(receipt).then(() => true,
        () => { this.#startup("thread-directory-capture-failed"); return false; });
      const history = threads && receipt && await this.#captureHistory(services, codex, receipt)
        .catch(() => { this.#startup("history-preview-capture-failed"); return []; });
      const projects = this.#projectsEnabled && receipt && await captureWorkspaceProjects(params => codex.readDirectoryAtPlacement("project/list", params, receipt))
        .catch(() => { this.#startup("project-directory-capture-failed"); return undefined; });
      // A Bridge-owned delivery can still be in flight without a Workspace execution lease.
      if (services.bridge && this.container()?.running && (!receipt || !(await services.bridge.canSleep(receipt))))
        return false;
      if (busy()) return false;
      const result = await services.runtime.sleep();
      if (!result.some(({ slept }) => slept) && this.container()?.running)
        throw new Error("Workspace container did not stop");
      if (projects || threads || history) {
        const after = await services.recordedPlacement();
        if (after?.snapshot?.id && after.snapshot.id !== before?.snapshot?.id &&
          after.receipt?.instanceId === receipt?.instanceId && after.receipt?.backend === receipt?.backend) {
          const checkpoint = directoryCheckpoint(after);
          if (threads && checkpoint) await this.#documents.update("thread-directory", () => ({ result: undefined, next: checkpoint }))
            .catch(() => this.#startup("thread-directory-commit-failed"));
          if (history) await recordWorkspaceHistory(this.#documents, after, history)
            .catch(() => this.#startup("history-preview-commit-failed"));
          if (projects) await recordWorkspaceProjects(this.#documents, after, projects)
            .catch(() => this.#startup("project-directory-commit-failed"));
        }
      }
      await this.#events;
      this.#idleTimer?.cancel();
      return true;
    })();
    this.#sleepingCodex = flight;
    try {
      return await flight;
    } finally {
      this.#sleepingCodex = undefined;
    }
  }

  /** The opened services; throws when the workspace is unbound or its open failed. */
  protected services(): Services {
    if (!this.#services) throw new Error(`WorkspaceHost is unavailable: ${describe(this.#failure)}`);
    return this.#services;
  }

  async #rememberTurnCompletion(threadId: string, value: unknown, onlyIfMissing = false) {
    const completion = parseThreadCatalogTurnCompletion(value);
    if (!completion) return;
    await this.#documents.update(await turnCompletionDocument(threadId), previous => {
      const known = parseThreadCatalogTurnCompletion(previous);
      if (known && (onlyIfMissing || JSON.stringify(known) === JSON.stringify(completion) ||
        (known.completedAt != null && completion.completedAt != null && known.completedAt > completion.completedAt))) {
        return { result: undefined };
      }
      return { result: undefined, next: completion };
    }).catch(() => this.#startup("turn-completion-commit-failed"));
  }

  /** A trusted workspace consumer may attach. The public Host surface owns launch admission separately. */
  protected openTerminalOwner(onNotification: (method: string, params: unknown) => void) {
    if (!this.#available || this.#sleepingCodex || this.#closing) throw new Error("Workspace terminal unavailable");
    return openWorkspaceTerminal(this.services().runtime, onNotification);
  }

  async #projects(services: Services, request: Request): Promise<Response> {
    const installations = this.#installation;
    const { codex, runtime, identity: { workspace, ownerActorId } } = services;
    const missing = () => json({ error: "missing" }, 404);
    if (!this.#projectsEnabled || !codex || !ownerActorId || !installations) return missing();
    const input = await fetchHttpExchange(request).readBody(32 * 1024).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as { method?: unknown; params?: unknown; attachment?: unknown } | null,
    ).catch(() => null);
    const call = parseWorkspaceProjectCall(input?.method, input?.params);
    const attachment = parseClientAttachment(input?.attachment);
    if (!call || !attachment) return json({ error: "invalid_workspace_project_request" }, 400);
    if (ownerActorId !== attachment.actorId) return missing();
    const installationId = installations.idFromName(INSTALLATION_CORE_OBJECT);
    const current = async () => (await terminalAdmission(installations.get(installationId), attachment,
      { workspace, threadId: null, draftScopeId: null })).admission === "active";
    const authorize = async () => {
      if (!(await current())) throw Error("Workspace project authority unavailable");
    };
    if (!(await current())) return missing();
    if (call.method === "project/list") {
      if (!this.container()?.running) {
        const page = await readWorkspaceProjects(this.#documents, await services.recordedPlacement(), call.params);
        if (page && !this.container()?.running) return await current() ? json({ result: page }) : missing();
      }
      if (call.params.cursor?.startsWith(PROJECT_DIRECTORY_CURSOR_PREFIX)) return json({ error: "project_directory_cursor_expired" }, 400);
      if (call.params.cursor === null && await services.neverStarted())
        return await current() ? json({ result: { data: [], nextCursor: null } }) : missing();
    }
    const receipt = this.#settings?.codexSnapshots && call.method === "project/list" ? await services.passiveReceipt() : undefined;
    if (this.#settings?.codexSnapshots && call.method === "project/list" && !receipt)
      return json({ error: "project_directory_unavailable" }, 503);
    if (call.method !== "project/list" || !this.#settings?.codexSnapshots) this.#touch();
    if (call.method === "fs/getMetadata" || call.method === "fs/readDirectory") {
      const result = await requestWorkspaceFile(runtime, call, authorize);
      return await current() ? json({ result }) : missing();
    }
    if (call.method === "project/create" && !(await this.#projectDirectories(runtime, call.params.roots.map(root => root.path), authorize)))
      return json({ error: "project_directory_unavailable" }, 422);
    const result = await codex.projects(call.method, call.params, authorize, receipt);
    if (!isWorkspaceProjectResult(call.method, result)) throw Error("Invalid native project result");
    return await current() ? json({ result }) : missing();
  }

  async #projectDirectories(runtime: WorkspaceRuntime, roots: readonly string[], authorize: () => Promise<void>) {
    for (const path of roots) {
      const result = await requestWorkspaceFile(runtime, { method: "fs/getMetadata", params: { path } }, authorize)
        .catch(() => null) as { isDirectory?: boolean; isSymlink?: boolean } | null;
      if (result?.isDirectory !== true || result.isSymlink) return false;
    }
    return true;
  }

  async #nativeProject(codex: WorkspaceCodex, projectId: string, authorize: () => Promise<void>) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = workspaceProjectPage(await codex.projects("project/list", { cursor, limit: 100 }, authorize));
      if (!page) throw Error("Invalid native project list");
      const project = page.data.find(project => project.id === projectId);
      if (project) return project;
      cursor = page.nextCursor;
      if (cursor === null) return null;
      if (seen.has(cursor)) throw Error("Native project cursor did not advance");
      seen.add(cursor);
    }
    throw Error("Native project catalog exceeds lookup budget");
  }

  async #projectMatches(services: Services, codex: WorkspaceCodex, assignment: WorkspaceProjectAssignment, authorize: () => Promise<void>) {
    const project = await this.#nativeProject(codex, assignment.projectId, authorize);
    return !!project && projectMatchesAssignment(project, assignment) &&
      this.#projectDirectories(services.runtime, assignment.runtimeWorkspaceRoots, authorize);
  }

  async #files(services: Services, request: Request): Promise<Response> {
    const installations = this.#installation;
    const { workspace, ownerActorId } = services.identity;
    const missing = () => json({ error: "missing" }, 404);
    if (!this.#filesEnabled || !services.codex || !ownerActorId || !installations) return missing();
    const input = await fetchHttpExchange(request).readBody(1024 * 1024).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as {
        method?: unknown; params?: unknown; attachment?: unknown; placement?: unknown;
      } | null,
    ).catch(() => null);
    const call = parseWorkspaceFileCall(input?.method, input?.params);
    const attachment = parseClientAttachment(input?.attachment);
    const placement = parseThreadPlacementReceipt(input?.placement);
    if (!call || !attachment || placement?.state !== "placed") return json({ error: "invalid_workspace_file_request" }, 400);
    const { threadId } = call;
    if (ownerActorId !== attachment.actorId || placement.threadId !== threadId || placement.workspaceId !== workspace)
      return missing();
    const installationId = installations.idFromName(INSTALLATION_CORE_OBJECT);
    const current = async () => {
      const committed = await services.threadPlacements.readCommitted(placement);
      if (!committed || !sameThreadPlacement(committed, placement)) return false;
      const { admission } = await terminalAdmission(installations.get(installationId), attachment, {
        workspace, threadId, draftScopeId: null,
      });
      return admission === "active" && this.#pendingResourceObservation?.placement.threadId !== threadId;
    };
    if (!(await current())) return missing();
    if (call.method === WORKSPACE_FILE_SCOPE_METHOD)
      return json({ result: { kind: "workspace", threadId, root: PROJECTLESS_WORKSPACE } });
    this.#touch();
    const result = await requestWorkspaceFile(services.runtime, call, async () => {
      if (!(await current())) throw Error("Workspace file authority unavailable");
    });
    return (await current()) ? json({ result }) : missing();
  }

  async #terminal(services: Services, request: Request): Promise<Response> {
    const attachment = readClientAttachment(request);
    const sessionId = request.headers.get(WORKSPACE_TERMINAL_SESSION_HEADER);
    const missing = () => json({ error: "missing" }, 404);
    if (!attachment || !sessionId || !/^[0-9a-f-]{36}$/u.test(sessionId) ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket") return missing();
    const options = await this.#terminalOptions(services, attachment);
    if (!options) return missing();
    if (this.#terminalSessions.has(sessionId)) return json({ error: "terminal_session_conflict" }, 409);
    const session = acceptWorkspaceTerminal({ ...options,
      onClose: () => { this.#terminalSessions.delete(sessionId); },
    });
    this.#terminalSessions.set(sessionId, { attachmentKey: JSON.stringify(attachment), session });
    return session.response;
  }

  async #terminalOptions(services: Services, attachment: ClientAttachment): Promise<WorkspaceTerminalOptions | null> {
    const installations = this.#installation;
    const { workspace, ownerActorId } = services.identity;
    const { codex } = services;
    if (!codex || !ownerActorId || ownerActorId !== attachment.actorId || !installations) return null;
    const installationId = installations.idFromName(INSTALLATION_CORE_OBJECT);
    const authorize = async (scope: TerminalScope) => {
      const { admission, threadId } = await terminalAdmission(installations.get(installationId), attachment, { workspace, ...scope });
      return admission === "active" && this.#pendingResourceObservation?.placement.threadId === threadId
        ? "retired" : admission;
    };
    if (await authorize({ threadId: null, draftScopeId: null }) !== "active" || !this.#available) return null;
    return {
      owner: workspace,
      hostId: CODEX_WORKBENCH_HOST_ID,
      running: () => this.container()?.running === true,
      openOwner: onNotification => {
        this.#touch();
        return this.openTerminalOwner(onNotification);
      },
      authorize,
      ...(this.#projectsEnabled ? { authorizeProject: async (projectId, cwd, threadId) => {
        if (!isWorkspaceFilePath(cwd)) return false;
        const check = async () => {
          if (await authorize({ threadId, draftScopeId: null }) !== "active") throw Error("Workspace project authority unavailable");
        };
        this.#touch();
        const project = await this.#nativeProject(codex, projectId, check);
        if (!project?.roots.some(root => cwd === root.path || cwd.startsWith(root.path + "/"))) return false;
        if (threadId !== null) {
          const read = await codex.readThread({ threadId, includeTurns: false }) as { thread?: { id?: unknown; projectId?: unknown } };
          if (read?.thread?.id !== threadId || read.thread.projectId !== projectId) return false;
        }
        return this.#projectDirectories(services.runtime, [cwd], check);
      } } : {}),
      waitUntil: work => this.ctx.waitUntil(work),
    };
  }

  async #terminalCommand(services: Services, request: Request): Promise<Response> {
    const attachment = readClientAttachment(request);
    const id = request.headers.get(WORKSPACE_TERMINAL_SESSION_HEADER);
    const binding = id ? this.#terminalSessions.get(id) : undefined;
    const missing = () => json({ error: "missing" }, 404);
    if (!attachment || this.#closing || (id !== null && (!binding || JSON.stringify(attachment) !== binding.attachmentKey))) return missing();
    const bytes = await fetchHttpExchange(request).readBody(WORKSPACE_TERMINAL_COMMAND_BYTES).catch(() => null);
    if (!bytes) return json({ error: "terminal_input_budget" }, 400);
    const frame = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const inventory = !binding && await this.#terminalOptions(services, attachment);
    const result = binding ? await binding.session.request(frame, bytes.byteLength)
      : inventory && await readWorkspaceTerminalInventory(inventory, frame, bytes.byteLength);
    if (!result) return missing();
    return new Response(result, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  async #releaseTerminal(services: Services, request: Request): Promise<Response> {
    const missing = () => json({ error: "missing" }, 404);
    if (!services.identity.ownerActorId) return missing();
    const input = await fetchHttpExchange(request).readBody(8192).then(
      bytes => JSON.parse(new TextDecoder().decode(bytes)) as { placement?: unknown; activate?: unknown; draftScopeId?: unknown } | null,
    ).catch(() => null);
    const placement = parseThreadPlacementReceipt(input?.placement);
    if (placement?.state !== "placed" || placement.workspaceId !== services.identity.workspace || typeof input?.activate !== "boolean" ||
      (input.draftScopeId != null && !isTerminalResourceScopeId(input.draftScopeId)))
      return missing();
    const committed = await services.threadPlacements.readCommitted(placement);
    if (!committed || !sameThreadPlacement(committed, placement)) return missing();
    // A stopped incarnation has no live process group. Cleanup never starts it.
    if (this.container()?.running) {
      const owner = await this.openTerminalOwner(() => {});
      const aliases = input.draftScopeId == null ? [] : [{ owner: placement.workspaceId, resourceOwnerId: input.draftScopeId }];
      try { await releaseTerminalThread(owner.dispatch, CODEX_WORKBENCH_HOST_ID, placement.threadId, input.activate, aliases); }
      finally { await owner.close(); }
    }
    return new Response(null, { status: 204 });
  }

  async #flushThreadResources(): Promise<void> {
    if (this.#publishingResources) return this.#publishingResources;
    const observation = this.#pendingResourceObservation;
    const installations = this.#installation;
    if (!observation || this.#closing) return;
    this.#publishingResources = (async () => {
      // Retain the validated native acknowledgement until InstallationCore
      // commits it. A lost binding response only retries publication.
      await this.#documents.update(RESOURCE_OBSERVATION, previous => {
        const stored = pendingThreadResources(previous);
        if (!stored) return { result: undefined, next: { pending: observation } };
        if (stored.state !== observation.state || !sameThreadPlacement(stored.placement, observation.placement))
          throw Error("Conflicting conversation resource observation");
        return { result: undefined };
      });
      if (!installations) throw Error("Conversation resource authority unavailable");
      const installation = installations.get(installations.idFromName(INSTALLATION_CORE_OBJECT));
      const response = await installation.fetch(new Request(`https://installation.invalid${WORKSPACE_THREAD_RESOURCES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(observation),
      }));
      await response.body?.cancel();
      if (response.status !== 204) throw Error("Conversation resource observation not committed");
      await this.#documents.update(RESOURCE_OBSERVATION, () => ({ result: undefined, next: { pending: null } }));
      this.#pendingResourceObservation = undefined;
      this.#resourceRetry?.cancel();
    })().catch(error => {
      if (!this.#closing) this.#resourceRetry?.arm(Date.now() + RESOURCE_OBSERVATION_RETRY_MS);
      throw error;
    }).finally(() => { this.#publishingResources = undefined; });
    await this.#publishingResources;
  }

  /**
   * Runs the named disposers once, in order, settling every one. The platform
   * drops an evicted object's memory without an event; durable state is already
   * committed, and the container keeps running for the next construction to attach.
   */
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#available = false;
      for (const { session } of this.#terminalSessions.values()) session.close();
      this.#idleTimer?.cancel();
      this.#renewTimer?.cancel();
      this.#resourceRetry?.cancel();
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
    const value = await parseWorkspaceIdentity(identity);
    if (!value) return json({ error: "invalid_workspace" }, 400);
    const stored = (await this.#documents.read("identity")) as WorkspaceIdentity | null;
    if (stored) {
      if (stored.workspace !== value.workspace || stored.machine !== value.machine || stored.ownerActorId !== value.ownerActorId)
        return json({ error: "workspace_conflict" }, 409);
      return this.#status();
    }
    if (this.#closing || !this.#settings) return json({ error: "workspace_unavailable" }, 503);
    const bound = await this.ctx.blockConcurrencyWhile(async () => {
      const won = await this.#documents.update("identity", previous => previous === null
        ? { result: true, next: value } : { result: false });
      if (!won) return false;
      try {
        this.#services = await this.#open(value);
      } catch (error) {
        this.#failure = error;
        await this.close().catch(() => undefined);
      }
      return true;
    });
    return bound ? this.#status() : this.#bind(value);
  }

  async #personalAssetsEnvironment(ownerActorId: string | undefined): Promise<Record<string, string>> {
    if (!ownerActorId || !this.#account) return {};
    try {
      const stub = this.#account.get(this.#account.idFromName(ACCOUNT_CORE_OBJECT));
      const response = await stub.fetch(
        new Request(`https://account.internal${WORKSPACE_ASSETS_ENVIRONMENT_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actorId: ownerActorId }),
        }),
      );
      if (!response.ok) return {};
      const body = (await response.json().catch(() => null)) as { env?: unknown } | null;
      if (!body || !body.env || typeof body.env !== "object" || Array.isArray(body.env)) return {};
      const entries: [string, string][] = [];
      for (const [key, value] of Object.entries(body.env)) {
        if (typeof value === "string") entries.push([key, value]);
      }
      return Object.fromEntries(entries);
    } catch {
      return {};
    }
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
    if (request.headers.has(WORKSPACE_MODEL_INTERCEPT_HEADER)) return this.#codexModelEgress(request);
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
    if (operation !== "sleep" && this.#sleepingCodex) await this.#sleepingCodex.catch(() => undefined);
    const track = !!this.#services.codex && operation !== "sleep";
    if (track) this.#operations++;
    try {
      return await this.#operate(operation, request, url);
    } catch (error) {
      const code = error instanceof SandboxFault ? error.code : undefined;
      return json({ error: "workspace_operation_failed", ...(code ? { code } : {}) }, 503);
    } finally {
      if (track) this.#operations--;
    }
  }

  async #publishThreadPlacement(receipt: ThreadPlacementReceipt): Promise<Response> {
    const installations = this.#installation;
    if (!installations) return json({ error: "placement_unavailable" }, 503);
    const installation = installations.get(installations.idFromName(INSTALLATION_CORE_OBJECT));
    return installation.fetch(
      new Request(`https://installation.invalid${THREAD_PLACEMENT_PUBLISH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      }),
    );
  }

  #codexInteractionSnapshot(threadId: string) {
    const active = this.#activeCodexTurn;
    const canRespond = !!active?.incarnation && active.incarnation === this.#bound &&
      active.threadId === threadId && !!active.respond;
    return this.#codexInteractions.snapshot(threadId, canRespond);
  }

  async #currentCodexTurn(services: Services, attachment: ClientAttachment, placement: ThreadPlacementReceipt) {
    const installations = this.#installation;
    if (!services.codexTurns || !installations || placement.workspaceId !== services.identity.workspace ||
      (services.identity.ownerActorId !== undefined && services.identity.ownerActorId !== attachment.actorId)) return null;
    const committed = await services.threadPlacements.readCommitted(placement);
    if (!committed || !sameThreadPlacement(committed, placement)) return null;
    const answer = await codexTurnAuthority(
      installations.get(installations.idFromName(INSTALLATION_CORE_OBJECT)), attachment, placement.threadId,
    );
    return answer && sameThreadPlacement(answer.placement, placement) ? answer : null;
  }

  #reattachCodexTurn(services: Services, attachment: ClientAttachment, authority: TurnAuthority) {
    if (this.#reattachingCodexTurn) return this.#reattachingCodexTurn;
    const { leases, codex } = services;
    if (!codex || this.#activeCodexTurn) return;
    const { placement, principal } = authority;
    const { threadId } = placement;
    const lease = leases.unsettledLease(threadId);
    // Only the original admitted human may reattach, using the current login.
    // An unconfirmed submission has no native Turn to which we can attach.
    if (!ownsCodexExecution(lease, principal) || !lease.turnId || !lease.engineIncarnation) return;
    if (!this.container()?.running) throw new Error("Original Codex container unavailable");
    const { turnId, engineIncarnation, inputId } = lease;

    const active: ActiveCodexTurn = {
      threadId,
      turnId,
      abort: new AbortController(),
      observers: new Set(),
      current: async () => !!(await this.#currentCodexTurn(services, attachment, placement)),
    };
    this.#activeCodexTurn = active;
    let attached!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      attached = resolve;
      failed = reject;
    });
    this.#reattachingCodexTurn = ready;
    const { abort } = active;
    const timeout = setTimeout(() => abort.abort(), 90_000);
    this.#touch();
    let completion: Promise<void> | undefined;
    const task = runCodexTurn(codex, { threadId, existing: { turnId, engineIncarnation } },
      abort.signal, async () => {
        await this.#events;
        const incarnation = this.#bound;
        if (!incarnation || !this.modelLease("codex") || !(await active.current()) || incarnation !== this.#bound)
          throw new Error("Original Turn authority unavailable");
        active.incarnation = incarnation;
      }, (frame) => {
        if (active.incarnation !== this.#bound || abort.signal.aborted) return;
        if (frame.kind === "accepted" && frame.result.turn.status === "inProgress")
          leases.started(threadId, frame.result.turn.id, inputId, engineIncarnation);
        if (frame.kind === "event") for (const observer of active.observers) observer(frame.frame);
        if (frame.kind === "event" && frame.frame.method === "turn/completed") {
          leases.finished(threadId, turnId);
          completion = this.#rememberTurnCompletion(threadId, (frame.frame.params as { turn: unknown }).turn);
          active.interrupt = undefined;
          active.steer = undefined;
          active.respond = undefined;
        }
      }, {
        interactions: this.#codexInteractions,
        interactionSnapshot: () => this.#codexInteractionSnapshot(threadId),
        expose(controls) { Object.assign(active, controls); },
        attached: () => {
          clearTimeout(timeout);
          this.#reattachingCodexTurn = undefined;
          attached();
        },
      }).catch((error: unknown) => {
        this.#codexInteractions.markSourceUnavailable(threadId);
        failed(error);
      }).finally(async () => {
        await completion;
        clearTimeout(timeout);
        finishCodexObservers(active);
        if (this.#reattachingCodexTurn === ready) this.#reattachingCodexTurn = undefined;
        if (this.#activeCodexTurn === active) this.#activeCodexTurn = undefined;
      });
    this.ctx.waitUntil(task);
    return ready;
  }

  async #controlCodexTurn(services: Services, request: Request): Promise<Response> {
    const input = await fetchHttpExchange(request).readBody(64 * 1024).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    ).catch(() => null);
    const call = parseCodexTurnOperationCall(input);
    if (!call) return json({ error: "invalid_turn_operation" }, 400);
    const { operation, attachment, placement } = call;
    const { threadId } = operation;
    const current = () => this.#currentCodexTurn(services, attachment, placement);
    const missing = () => json({ error: "missing" }, 404);
    const authority = await current();
    if (!authority) return missing();
    if (operation.kind === "thread-mutation") {
      const mutation = this.#mutateCodexThread(services, operation, current);
      this.ctx.waitUntil(mutation);
      return mutation;
    }
    try {
      await this.#reattachCodexTurn(services, attachment, authority);
      const active = this.#activeCodexTurn;
      const live = () => !!active?.incarnation && active === this.#activeCodexTurn &&
        active.threadId === threadId && active.incarnation === this.#bound;
      switch (operation.kind) {
        case "resume":
          if (!services.codex) return missing();
          if (live() && active?.turnId && active.resume)
            return await this.#observeCodexTurn(operation, active, active.turnId, active.resume, async () => !!(await current()));
          if (active?.threadId === threadId || services.leases.unsettledLease(threadId))
            return json({ error: "thread_resume_busy" }, 409);
          const receipt = this.#settings?.codexSnapshots ? await services.passiveReceipt() : undefined;
          if (this.#settings?.codexSnapshots && !receipt) return json({ error: "thread_resume_unavailable" }, 425);
          if (!receipt) this.#touch();
          const result = await services.codex.resumeThread(threadId, operation.excludeTurns, receipt);
          return matchesCodexResume(result, operation) && (await current()) ? json(result) : missing();
        case "interrupt":
          if (!live() || active?.turnId !== operation.turnId || !active.interrupt) return missing();
          await active.interrupt();
          return json({});
        case "steer": {
          const { expectedTurnId, clientUserMessageId } = operation;
          const { leases } = services;
          const lease = leases.unsettledLease(threadId);
          if (!live() || active?.turnId !== expectedTurnId || !active.steer || lease?.turnId !== expectedTurnId ||
            !ownsCodexExecution(lease, authority.principal) || !this.modelLease("codex")) return missing();
          if (leases.getSubmission(threadId, clientUserMessageId)) return json({ error: "turn_operation_outcome_unknown" }, 409);

          let admitted = false;
          try {
            const result = await active.steer({ threadId, expectedTurnId, clientUserMessageId, input: operation.input }, async () => {
              leases.capture(threadId, clientUserMessageId, { ownership: "human", principal: authority.principal }, "accepted", "steer");
              await this.ctx.storage.sync();
              const latest = await current();
              const exact = leases.unsettledLease(threadId);
              if (!latest || !live() || !active.steer || !this.modelLease("codex") ||
                exact?.executionId !== lease.executionId || !ownsCodexExecution(exact, latest.principal))
                throw new Error("Original Turn authority unavailable");
              admitted = true;
            });
            return json(result);
          } catch (error) {
            if (!admitted || isDefinitiveCodexSteerRefusal(error)) return missing();
            throw error;
          }
        }
        case "read-interactions":
          return json(this.#codexInteractionSnapshot(threadId));
        case "respond-interaction": {
          const disposition = await this.#codexInteractions.respond(threadId, operation.interactionId,
            operation.submissionId, operation.result, async (source, result, assertCurrent) => {
              let respond: CodexTurnControls["respond"];
              try {
                if (!(await current()) || !live() || !active?.respond || source.params.turnId !== active.turnId)
                  throw new Error("Native interaction route unavailable");
                respond = active.respond;
                assertCurrent();
              } catch (cause) {
                throw new InteractionResponseNotDispatched(cause);
              }
              await respond(source, result);
            });
          return json({ disposition, snapshot: this.#codexInteractionSnapshot(threadId) });
        }
      }
    } catch (error) {
      if (error instanceof InteractionFault) return json({ interactionError: error.domainData }, 422);
      return json({ error: "turn_operation_outcome_unknown" }, 409);
    }
  }

  async #mutateCodexThread(services: Services, operation: CodexThreadMutation, current: () => Promise<TurnAuthority | null>) {
    const { codex, leases } = services;
    const { method, params, threadId } = operation;
    const missing = () => json({ error: "missing" }, 404);
    const notSubmitted = () => json({ error: "thread_operation_not_submitted" }, 423);
    const executing = () => this.#activeCodexTurn?.threadId === threadId || leases.unsettledTargets(threadId).length > 0;
    if (!codex) return missing();
    if (executing()) return notSubmitted();
    const updatesArchive = method === "thread/archive" || method === "thread/unarchive";
    const observesResources = !!services.identity.ownerActorId && updatesArchive;
    let dispatched = false;
    this.#touch();
    try {
      return await codex.withMutationLane(async lane => {
        if (observesResources) await this.#flushThreadResources();
        if (method === "thread/archive") {
          const baseline = await lane.request("thread/read", { threadId, includeTurns: false });
          if (!isCodexThreadResult(baseline, threadId)) return missing();
          const { thread } = baseline as { thread: { status?: { type?: string } } };
          if (thread.status?.type !== "idle" && thread.status?.type !== "notLoaded") return notSubmitted();
        }
        if (method === "thread/settings/update") {
          if (!(await services.threadPlacements.isSideChat(threadId))) return missing();
          const baseline = await lane.request("thread/resume", { threadId, excludeTurns: true, config: CODEX_WORKBENCH_THREAD_CONFIG });
          if (!isCodexThreadResult(baseline, threadId)) return missing();
          const { model, reasoningEffort, thread } = baseline as { model?: unknown; reasoningEffort?: unknown; thread: { status?: { type?: unknown } } };
          const expected = params.collaborationMode.settings;
          if (thread.status?.type !== "idle" || model !== expected.model || (reasoningEffort ?? null) !== expected.reasoning_effort)
            return notSubmitted();
        }
        const authority = await current();
        if (!authority) return missing();
        if (executing()) return notSubmitted();
        dispatched = true;
        try {
          const receipt = parseCodexThreadMutationReceipt(await lane.request(method, params), operation);
          if (!receipt) throw new Error("Invalid native Thread mutation receipt");
          if (observesResources) {
            this.#pendingResourceObservation = { placement: authority.placement, state: method === "thread/archive" ? "archived" : "active" };
            await this.#flushThreadResources();
          } else if (updatesArchive) {
            await services.threadPlacements.recordArchive(authority.placement, method === "thread/archive");
          }
          return json(receipt);
        } finally {
          if (method === "thread/archive") lane.createdThreads.delete(threadId);
        }
      });
    } catch {
      return dispatched ? json({ error: "thread_operation_outcome_unknown" }, 409) : notSubmitted();
    }
  }

  async #observeCodexTurn(
    request: CodexResume,
    active: ActiveCodexTurn,
    turnId: string,
    resume: NonNullable<ActiveCodexTurn["resume"]>,
    current: () => Promise<boolean>,
  ): Promise<Response> {
    if (active.observers.size >= 4) return json({ error: "thread_resume_busy" }, 429);
    const limit = 512 * 1024;
    const snapshotLimit = 4 * 1024 * 1024;
    const encoder = new TextEncoder();
    const encode = (frame: unknown) => encoder.encode(JSON.stringify(frame) + "\n");
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let early: Uint8Array[] | undefined = [];
    let bytes = 0;
    let ended = false;
    let failed = false;
    const end = () => {
      if (ended) return;
      ended = true;
      active.observers.delete(observe);
      if (!early) output.close();
    };
    const observe = (event?: JsonRpcNotification) => {
      if (ended) return;
      if (!event) return end();
      try {
        const frame = encode(event);
        if (early) {
          bytes += frame.byteLength;
          if (bytes > limit) throw new Error("Resume output congested");
          early.push(frame);
        } else {
          if (frame.byteLength > (output.desiredSize ?? 0)) throw new Error("Resume output congested");
          output.enqueue(frame);
        }
        if (event.method === "turn/completed") end();
      } catch (error) {
        failed = true;
        active.observers.delete(observe);
        output.error(error);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      cancel() { active.observers.delete(observe); ended = true; },
    }, { highWaterMark: snapshotLimit + limit, size: (chunk) => chunk.byteLength });
    active.observers.add(observe);
    try {
      observe({ method: SHARED_INTERACTIONS_CHANGED, params: this.#codexInteractionSnapshot(request.threadId) });
      const result = await resume(request.excludeTurns);
      if (!matchesCodexResume(result, request) || !(await current()) || active.incarnation !== this.#bound) {
        await stream.cancel();
        return json({ error: "missing" }, 404);
      }
      const snapshot = encode({ turnId, result });
      if (failed || snapshot.byteLength > snapshotLimit) throw new Error("Resume snapshot unavailable");
      output.enqueue(snapshot);
      for (const event of early) output.enqueue(event);
      early = undefined;
      if (ended) output.close();
      return new Response(stream, { headers: { "content-type": CODEX_TURN_STREAM_TYPE, "cache-control": "no-store" } });
    } catch (error) {
      await stream.cancel().catch(() => undefined);
      throw error;
    }
  }

  async #startCodexTurn(services: Services, request: Request): Promise<Response> {
    const { codex, leases, identity } = services;
    if (!services.codexTurns || !this.#installation || !codex) return json({ error: "missing" }, 404);
    const input = await fetchHttpExchange(request).readBody(128 * 1024).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    ).catch(() => null);
    const call = parseCodexTurnCall(input);
    if (!call || call.placement.workspaceId !== identity.workspace) return json({ error: "invalid_turn" }, 400);
    const { turn, attachment, placement } = call;
    const { threadId, clientUserMessageId: inputId } = turn;
    const authorize = () => this.#currentCodexTurn(services, attachment, placement);
    if (!(await authorize())) return json({ error: "missing" }, 404);
    if (services.bridge) {
      const installation = this.#installation.get(this.#installation.idFromName(INSTALLATION_CORE_OBJECT));
      const latest = await lookupCodexThread(installation, attachment, threadId, { archiveState: true });
      const pending = this.#pendingResourceObservation;
      const archived = pending && sameThreadPlacement(pending.placement, placement)
        ? pending.state === "archived" : latest?.archived;
      if (!latest || !sameThreadPlacement(latest, placement) || archived) return json({ error: "missing" }, 404);
    }
    const sideChat = await services.threadPlacements.isSideChat(threadId);
    if (turn.model && !(await this.#hasConfiguredCodexModel(turn.model)))
      return json({ error: "model_unavailable" }, 422);
    if (leases.getSubmission(threadId, inputId)) return json({ error: "turn_outcome_unknown" }, 409);
    if (this.#activeCodexTurn || leases.unsettledThreads().length) return json({ error: "turn_busy" }, 429);
    const active: ActiveCodexTurn = { threadId, abort: new AbortController(), observers: new Set(), current: async () => !!(await authorize()) };
    this.#activeCodexTurn = active;
    const { abort } = active;
    const encoder = new TextEncoder();
    let submitted = false;
    let confirmed = false;
    let accepted = false;
    let detached = false;
    let completion: Promise<void> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (output) => {
        const publish = (frame: TurnStreamFrame) => {
          if (frame.kind !== "refused" && (active.incarnation !== this.#bound || abort.signal.aborted)) return;
          if (frame.kind === "accepted") {
            leases.started(threadId, frame.result.turn.id, inputId);
            active.turnId = frame.result.turn.id;
            accepted = true;
          } else if (frame.kind === "event" && frame.frame.method === "turn/completed") {
            const params = frame.frame.params as { turn: { id: string } };
            leases.finished(threadId, params.turn.id);
            completion = this.#rememberTurnCompletion(threadId, params.turn);
            active.interrupt = undefined;
            active.steer = undefined;
            active.respond = undefined;
            confirmed = true;
          }
          if (frame.kind === "event") for (const observer of active.observers) observer(frame.frame);
          if (detached || abort.signal.aborted) return;
          try {
            if ((output.desiredSize ?? 0) <= 0) throw new Error("Turn stream output congested");
            output.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
          } catch (error) {
            detached = true;
            output.error(error);
          }
        };
        const operation = (async () => {
          const timeout = setTimeout(() => abort.abort(), 90_000);
          try {
            this.#touch();
            await runCodexTurn(codex, { ...turn, sideChat }, abort.signal, async (engineIncarnation) => {
              await this.#events;
              const health = await codex.health(true);
              const authority = await authorize();
              if (!authority || health.incarnation !== engineIncarnation || !this.#bound || !this.modelLease("codex"))
                throw new Error("Turn admission unavailable");
              abort.signal.throwIfAborted();
              active.incarnation = this.#bound;
              leases.capture(threadId, inputId, { ownership: "human", principal: authority.principal });
              leases.begin(threadId, inputId, engineIncarnation);
              await this.ctx.storage.sync();
              if (!(await active.current()) || active.incarnation !== this.#bound)
                throw new Error("Turn admission revoked");
              abort.signal.throwIfAborted();
              // Admission has a deadline. After dispatch, a native Turn can
              // legitimately wait for an approval until it is answered or stopped.
              clearTimeout(timeout);
              submitted = true;
            }, publish, {
              interactions: this.#codexInteractions,
              interactionSnapshot: () => this.#codexInteractionSnapshot(threadId),
              expose(controls) { Object.assign(active, controls); },
            });
          } catch {
            if (submitted && !confirmed) {
              leases.suspend(threadId);
              this.#codexInteractions.markSourceUnavailable(threadId);
            }
            else if (!submitted && leases.getSubmission(threadId, inputId)) leases.outcome(threadId, inputId, true);
            if (!accepted) publish({ kind: "refused", outcome: submitted ? "unknown" : "not-submitted" });
          } finally {
            await completion;
            clearTimeout(timeout);
            finishCodexObservers(active);
            if (this.#activeCodexTurn === active) this.#activeCodexTurn = undefined;
            if (!detached) output.close();
          }
        })();
        this.ctx.waitUntil(operation);
      },
      cancel: () => {
        // Delivery belongs to the browser. After dispatch the WorkspaceHost owns
        // the Turn and keeps its native lane, lease and terminal observation.
        detached = true;
        if (!submitted) abort.abort();
      },
    }, { highWaterMark: 512 * 1024, size: (chunk) => chunk.byteLength });
    return new Response(stream, { headers: { "content-type": CODEX_TURN_STREAM_TYPE, "cache-control": "no-store" } });
  }

  async #startCodexThread(services: Services, request: Request): Promise<Response> {
    const { codex, identity, threadPlacements } = services;
    const installations = this.#installation;
    if (!codex || !installations) return json({ error: "missing" }, 404);
    const body = await fetchHttpExchange(request).readBody(CODEX_THREAD_START_BODY_BYTES).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    ).catch(() => null);
    const call = parseCodexStartAuthority(body);
    if (!call || call.workspace !== identity.workspace ||
      (identity.ownerActorId !== undefined && identity.ownerActorId !== call.attachment.actorId)) return json({ error: "missing" }, 404);
    const current = async () => {
      if (call.source) {
        const committed = await threadPlacements.readCommitted(call.source.placement);
        if (!committed || !sameThreadPlacement(committed, call.source.placement)) return false;
      }
      return currentCodexStart(installations.get(installations.idFromName(INSTALLATION_CORE_OBJECT)), call);
    };
    const unknown = () => json({ error: "thread_start_outcome_unknown" }, 409);
    if (!(await current())) return json({ error: "missing" }, 404);
    if ((call.options.historyMode || call.source) && !services.codexTurns) return json({ error: "missing" }, 404);
    const assignment = call.options.projectId === undefined ? null : parseWorkspaceProjectAssignment({ ...call.options });
    if (call.options.projectId !== undefined && (!assignment || !identity.ownerActorId || !this.#projectsEnabled))
      return json({ error: "missing" }, 404);
    const sourceThreadId = call.source?.placement.threadId;
    type Memo = { state: "dispatching" } | { state: "completed"; result: unknown };
    let state = await this.#codexCreations.read(call.operation) as Memo | null;
    if (!state) {
      if (this.#codexStarting) return json({ error: "thread_creator_busy" }, 429);
      this.#codexStarting = true;
      this.#touch();
      let dispatching = false;
      try {
        if (assignment && !(await this.#projectMatches(services, codex, assignment, async () => {
          if (!(await current())) throw Error("Thread creation revoked");
        }))) return json({ error: "project_unavailable" }, 422);
        if (call.options.model && !(await this.#hasConfiguredCodexModel(call.options.model)))
          return json({ error: "model_unavailable" }, 422);
        const result = await codex.startThread(async () => {
          if (sourceThreadId !== undefined && (services.leases.unsettledTargets(sourceThreadId).length ||
            this.#activeCodexTurn?.threadId === sourceThreadId)) throw new Error("Source Thread is executing");
          if (!(await current())) throw new Error("Thread creation revoked");
          // Once the durable claim begins, keep uncertain failures conservative across DO restarts.
          dispatching = true;
          const claimed = await this.#codexCreations.update(call.operation, (existing) => existing === null
            ? { result: true, next: { state: "dispatching" } }
            : { result: false });
          if (!claimed || !(await current())) throw new Error("Thread creation no longer admitted");
          this.#startup("codex-thread-dispatch");
        }, services.codexTurns, call.options);
        const nativeThread = (result as { thread?: { historyMode?: unknown; projectId?: unknown; cwd?: unknown } } | null)?.thread;
        const historyMode = nativeThread?.historyMode;
        if (!createdCodexThreadId(result, sourceThreadId) || (call.options.historyMode && historyMode !== call.options.historyMode) ||
          (assignment && (nativeThread?.projectId !== assignment.projectId || nativeThread?.cwd !== assignment.cwd)) ||
          new TextEncoder().encode(JSON.stringify(result)).byteLength > 48 * 1024) {
          this.#startup("codex-thread-invalid-receipt");
          return unknown();
        }
        state = { state: "completed", result };
        await this.#codexCreations.update(call.operation, (previous) => {
          if ((previous as Memo | null)?.state !== "dispatching") throw new Error("Thread creation lost its claim");
          return { result: undefined, next: state };
        });
      } catch (error) {
        if (error instanceof EndpointRpcError) this.#startup("codex-thread-rpc-error", { rpcCode: error.code });
        this.#startup(dispatching ? "codex-thread-outcome-unknown" : "codex-thread-not-submitted");
        return dispatching ? unknown() : json({ error: "thread_start_not_submitted" }, 503);
      } finally {
        this.#codexStarting = false;
      }
    }
    if (state.state !== "completed") return unknown();
    const threadId = createdCodexThreadId(state.result, sourceThreadId);
    if (!threadId) return unknown();
    const placement = await threadPlacements.commitCreated(threadId, call.options.fork?.sideChat ? sourceThreadId : undefined);
    if (!(await current())) return json({ error: "missing" }, 404);
    return json({ result: state.result, placement });
  }

  async #operate(
    operation: Exclude<WorkspaceHostOperation | WorkspaceHostInternalOperation, "open" | "status">,
    request: Request,
    url: URL,
  ): Promise<Response> {
    const services = this.services();
    if (this.#sleepingCodex) return json({ error: "workspace_sleep_in_progress" }, 409);
    switch (operation) {
      case WORKSPACE_TERMINAL_OPERATION:
        return this.#terminal(services, request);
      case WORKSPACE_TERMINAL_COMMAND_OPERATION:
        return this.#terminalCommand(services, request);
      case WORKSPACE_TERMINAL_RELEASE_OPERATION:
        return this.#releaseTerminal(services, request);
      case WORKSPACE_FILES_OPERATION:
        return this.#files(services, request);
      case WORKSPACE_PROJECTS_OPERATION:
        return this.#projects(services, request);
      case "wake": {
        this.#touch();
        await services.runtime.observe();
        if (services.bridge) {
          await checkWorkspaceBridge(services.bridge.request);
          await services.bridge.pull();
        }
        return this.#status();
      }
      case "sleep": {
        if (services.codex) {
          if (!this.#settings!.codexSnapshots) return json({ error: "workspace_codex_requires_resident_container" }, 409);
          return await this.#sleepCodex(services, services.codex) ? this.#status() : json({ error: "workspace_busy" }, 409);
        }
        await services.runtime.sleep();
        this.#idleTimer?.cancel();
        return this.#status();
      }
      case "inputs": {
        // An explicit Host input (an agent, schedule or goal): the module records its lease.
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const engine = this.#settings!.engineHostEngines[0]!;
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
      case "codex-health": {
        if (!services.codex) return json({ error: "missing" }, 404);
        this.#touch();
        return json(await services.codex.health());
      }
      case "codex-native": {
        if (!services.codex) return json({ error: "missing" }, 404);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "websocket_required" }, 426);
        const lanes = url.searchParams.getAll("lane");
        if (lanes.length !== 1 || !isWorkspaceCodexLane(lanes[0]!))
          return json({ error: "invalid_codex_lane" }, 400);
        this.#touch();
        return bridgeWorkspaceCodex(services.codex, lanes[0]!, (threadId) => {
          const commit = services.threadPlacements.commitCreated(threadId);
          // Publication can be retried from the committed receipt without replaying creation.
          this.ctx.waitUntil(
            commit
              .then(async (receipt) => {
                const response = await this.#publishThreadPlacement(receipt);
                await response.body?.cancel();
              })
              .catch(() => undefined),
          );
          return commit.then(() => undefined);
        });
      }
      case WORKSPACE_CODEX_START_OPERATION:
        return this.#startCodexThread(services, request);
      case WORKSPACE_CODEX_TURN_OPERATION:
        return this.#startCodexTurn(services, request);
      case WORKSPACE_CODEX_CONTROL_OPERATION:
        return this.#controlCodexTurn(services, request);
      case WORKSPACE_CODEX_THREAD_LIST_OPERATION: {
        const { codex, identity, threadPlacements } = services;
        if (!codex) return json({ error: "missing" }, 404);
        const input = await fetchHttpExchange(request).readBody(8192).then(
          (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        ).catch(() => null);
        const params = parseCodexThreadList(input);
        if (!params) return json({ error: "invalid_thread_list" }, 400);
        const { threadDirectory } = services;
        const recordedCursor = params.cursor !== null && isRecordedThreadCursor(params.cursor);
        const { searchTerm, ...query } = params;
        const projectedQuery = { ...query, useStateDbOnly: true };
        let recorded;
        if (threadDirectory && searchTerm === null && threadDirectory.catalog.supports(projectedQuery) && !this.container()?.running) {
          const checkpoint = await this.#documents.read("thread-directory");
          if (matchesDirectoryCheckpoint(checkpoint, await services.recordedPlacement()) && !this.container()?.running) {
            try { recorded = await threadDirectory.catalog.list(projectedQuery); }
            catch (error) { if (recordedCursor) return json({ error: "thread_directory_cursor_expired" }, 400); else throw error; }
            if (recorded.catalog.coverage !== "complete") recorded = undefined;
          }
        }
        if (!recorded && recordedCursor) return json({ error: "thread_directory_cursor_expired" }, 400);
        if (params.cursor === null && await services.neverStarted())
          return json({ data: [], nextCursor: null, backwardsCursor: null });
        const receipt = !recorded && this.#settings?.codexSnapshots ? await services.passiveReceipt() : undefined;
        if (!recorded && this.#settings?.codexSnapshots && !receipt)
          return json({ error: "thread_directory_unavailable" }, 503);
        if (this.#codexReads >= 4) return json({ error: "thread_reader_busy" }, 429);
        this.#codexReads++;
        try {
          if (!recorded && !receipt) this.#touch();
          const page = parseCodexThreadPage(recorded ?? (receipt
            ? await codex.readDirectoryAtPlacement("thread/list", params, receipt) : await codex.listThreads(params)));
          if (!page || page.data.length > params.limit) throw new Error("Invalid native Thread directory");
          const serverId = `server:${identity.machine}:codex`;
          const entries = await Promise.all(page.data.map(async (value) => {
            const entry = threadCatalogEntry(value);
            if (!entry) return null;
            const placement = await threadPlacements.readCommitted({ serverId, threadId: entry.id }, { includeSideChats: false });
            if (placement?.state !== "placed") return null;
            const thread = services.codexTurns ? { ...entry, latestTurnCompletion: parseThreadCatalogTurnCompletion(
              await this.#documents.read(await turnCompletionDocument(entry.id)),
            ) } : entry;
            return { thread, placement };
          }));
          return json({ ...page, data: entries.filter(entry => entry !== null) });
        } finally {
          this.#codexReads--;
        }
      }
      case WORKSPACE_CODEX_MODEL_LIST_OPERATION: {
        if (!services.codexTurns) return json({ error: "missing" }, 404);
        const input = await fetchHttpExchange(request).readBody(8192).then(
          (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        ).catch(() => null);
        const params = parseCodexModelList(input);
        if (!params) return json({ error: "invalid_model_list" }, 400);
        const { target, owner } = this.#modelDirectory();
        return owner.fetch(new Request(target, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
        }));
      }
      case WORKSPACE_CODEX_READ_OPERATION: {
        const { codex, identity, threadPlacements } = services;
        const installations = this.#installation;
        if (!codex || !installations) return json({ error: "missing" }, 404);
        const body = await fetchHttpExchange(request).readBody(8192).then(
          (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        ).catch(() => null);
        const call = parseWorkspaceCodexRead(body);
        if (!call) return json({ error: "invalid_thread_read" }, 400);
        const { attachment, placement, read } = call;
        const { threadId } = read.params;
        const initialPageRead = read.method === "thread/read" ? initialCodexTurnsRead(read.params) : undefined;
        if ((read.method !== "thread/read" || initialPageRead) && !services.codexTurns) return json({ error: "missing" }, 404);
        if (placement.workspaceId !== identity.workspace) return json({ error: "missing" }, 404);
        const installation = installations.get(installations.idFromName(INSTALLATION_CORE_OBJECT));
        const current = async (archiveState = false) => {
          const authorized = await lookupCodexThread(installation, attachment, threadId, { archiveState });
          if (!authorized || !sameThreadPlacement(authorized, placement)) return null;
          const committed = await threadPlacements.readCommitted(placement, {
            archiveState: archiveState && !identity.ownerActorId,
          });
          if (!committed || !sameThreadPlacement(authorized, committed)) return null;
          return committed.archived === undefined ? authorized : { ...authorized, archived: committed.archived };
        };
        const openArchive = read.params.openArchivedHistory === true;
        const ordinaryBody = readsOrdinaryCodexHistoryBody(read);
        const archivedResponse = () => json({ error: "thread_archived" }, 423);
        const authorized = await current(true);
        if (!authorized) return json({ error: "missing" }, 404);
        const archiveState = (observed: { readonly archived?: boolean }) => {
          const pending = this.#pendingResourceObservation;
          return pending && sameThreadPlacement(pending.placement, placement) ? pending.state === "archived" : observed.archived;
        };
        let archived = archiveState(authorized) === true;
        if (ordinaryBody && archived) return archivedResponse();
        let receipt = this.#settings?.codexSnapshots ? await services.passiveReceipt() : undefined;
        let restoreFrom: string | undefined;
        const previewCursor = isWorkspaceHistoryPreviewCursor(read);
        if (!this.#settings?.codexSnapshots && previewCursor) return json({ error: "history_preview_cursor_expired" }, 410);
        if (this.#settings?.codexSnapshots && (!receipt || previewCursor)) {
          const recorded = await services.recordedPlacement();
          const directory = services.threadDirectory?.catalog;
          const recordedArchive = authorized.archived === undefined && directory &&
            matchesDirectoryCheckpoint(await this.#documents.read("thread-directory"), recorded)
            ? directory.recordedArchiveState(threadId) : undefined;
          if (ordinaryBody && (archiveState(authorized) ?? recordedArchive) === true) return archivedResponse();
          const snapshot = await readWorkspaceHistory(this.#documents, recorded, placement, read);
          const latest = await current(true);
          if (!latest) return json({ error: "missing" }, 404);
          const state = archiveState(latest) ?? recordedArchive;
          if (ordinaryBody && state === true) return archivedResponse();
          if (snapshot !== null) return json(snapshot);
          if (previewCursor) return json({ error: "history_preview_cursor_expired" }, 410);
          if (openArchive && state === true) restoreFrom = directoryCheckpoint(recorded)?.snapshot;
          if (!restoreFrom) return json({ error: "history_preview_unavailable", archived: state }, 425);
          archived = true;
        }
        const nativeReads = initialPageRead ? 2 : 1;
        if (this.#codexReads + nativeReads > 4) return json({ error: "thread_reader_busy" }, 429);
        this.#codexReads += nativeReads;
        if (!receipt) this.#touch();
        try {
          if (restoreFrom) {
            if (this.#sleepingCodex) return json({ error: "workspace_sleep_in_progress" }, 409);
            receipt = await services.restoreHistoryReceipt(restoreFrom).catch(() => undefined);
            const latest = await current(true);
            if (!latest) return json({ error: "missing" }, 404);
            if (!receipt || archiveState(latest) === false)
              return json({ error: "history_preview_unavailable", archived: archiveState(latest) ?? true }, 425);
          }
          if (ordinaryBody && !identity.ownerActorId) {
            const local = await threadPlacements.readCommitted(placement, { archiveState: true });
            if (!local || !sameThreadPlacement(local, placement)) return json({ error: "missing" }, 404);
            if (local.archived === true) return archivedResponse();
          }
          if (ordinaryBody && archiveState({ archived }) === true) return archivedResponse();
          const metadata = codex.readHistory(read, archived, receipt);
          let result: unknown;
          let initialPage: { data: unknown[] } | undefined;
          if (initialPageRead) {
            // Hold both native read slots until both calls settle, including a partial failure.
            const [thread, page] = await Promise.allSettled([metadata, codex.readHistory(initialPageRead, archived, receipt)]);
            if (thread.status === "rejected") throw thread.reason;
            if (page.status === "rejected") throw page.reason;
            if (!isCodexHistoryResult(initialPageRead, page.value)) return json({ error: "missing" }, 404);
            initialPage = page.value as { data: unknown[] };
            result = { ...(thread.value as object), initialTurnsPage: initialPage };
          } else result = await metadata;
          if (!isCodexHistoryResult(read, result)) return json({ error: "missing" }, 404);
          let latest = await current(ordinaryBody || read.method === "thread/read");
          if (!latest) return json({ error: "missing" }, 404);
          if (ordinaryBody && archiveState(latest) === true) return archivedResponse();
          const newest = initialPage ?? (read.method === "thread/turns/list" && read.params.cursor === null && read.params.sortDirection === "desc"
            ? result as { data: unknown[] } : undefined);
          if (newest && !archived) {
            await this.#rememberTurnCompletion(threadId, newest.data[0], true);
            latest = await current(ordinaryBody || read.method === "thread/read");
            if (!latest) return json({ error: "missing" }, 404);
            if (ordinaryBody && archiveState(latest) === true) return archivedResponse();
          }
          const observedArchive = archiveState(latest) ?? (restoreFrom ? true : undefined);
          if (read.method === "thread/read" && observedArchive !== undefined) {
            const body = result as { thread: Record<string, unknown> };
            return json({ ...body, thread: { ...body.thread, archived: observedArchive } });
          }
          return json(result);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === CODEX_THREAD_ARCHIVED)
            return await current() ? archivedResponse() : json({ error: "missing" }, 404);
          if (isCodexHistorySizeError(error))
            return await current() ? json({ error: "history_response_too_large" }, 413) : json({ error: "missing" }, 404);
          if (read.method !== "thread/read" && error instanceof EndpointRpcError && error.code === -32601)
            return await current() ? json({ error: "history_method_unavailable" }, 501) : json({ error: "missing" }, 404);
          throw error;
        } finally {
          this.#codexReads -= nativeReads;
        }
      }
      case "thread-placement":
      case "publish-thread-placement": {
        const thread = parseThreadPlacementKey(await request.json().catch(() => null));
        if (!thread) return json({ error: "invalid_thread" }, 400);
        const receipt = await services.threadPlacements.readCommitted(thread);
        if (!receipt) return json({ error: "missing" }, 404);
        return operation === "thread-placement" ? json(receipt) : this.#publishThreadPlacement(receipt);
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

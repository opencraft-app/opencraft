import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { join } from "node:path";
import { CodexHostQueue, type HostQueuedSubmission } from "./codex-host-queue.js";
import { CodexHostStateDatabase } from "./codex-host-state-database.js";
import { CodexMessageSenders } from "./codex-message-senders.js";
import { projectCodexMessageResult, projectCodexMessageNotification } from "./codex-message-projection.js";
import { CodexMessageAttachments } from "./codex-message-attachments.js";
import { CodexThreadPins } from "./codex-thread-pins.js";
import { CODEX_NATIVE_SHARED_METHODS, discoverNativeCodexGoalCapability, projectSharedNativeCodexInitialize } from "./codex-native-surface.js";
import { projectCodexAttachmentNotification, projectCodexAttachmentResult } from "./codex-message-attachment-projection.js";

import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { LocalAttachmentStagingService } from "@opencraft/local-agent-host/attachments/local-staging";
import { SshAttachmentStagingService, type SshAttachmentStorage } from "./ssh-attachment-staging.js";
import type { LocalDesktopService, LocalDesktopOwner } from "@opencraft/local-agent-host/desktop";
import { OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_RELEASE, OPENCRAFT_DESKTOP_EXTENSION, type HostDesktopCapability } from "@opencraft/appserver-protocol/desktop";
import {
  OPENCRAFT_ATTACHMENT_STAGING_EXTENSION,
  OPENCRAFT_METHOD_ACCESS_EXTENSION,
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_THREAD_LIFECYCLE_EXTENSION,
  OPENCRAFT_THREAD_PINS_EXTENSION,
  OPENCRAFT_THREAD_PINS_CAPABILITY,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
  OPENCRAFT_THREAD_GOAL_EXTENSION,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  type OpenCraftThreadLifecycleCapability,
  type OpenCraftThreadQueueCapability,
  type OpenCraftThreadGoalCapability,
  type CodexAccountView,
  codexPermissionMode,
  parsePermissionModeProfileId,
  projectPermissionProfileCatalog,
  OPENCRAFT_PERMISSION_MODES_CAPABILITY,
  OPENCRAFT_PERMISSION_MODES_EXTENSION,
  type OpenCraftPermissionProfile,
  type AttachmentStagingCapability,
  type AttachmentRef,
} from "@opencraft/appserver-protocol";
import {
  AccountPoolStore,
  CodexAccountPoolProxy,
  CodexCredentialRefreshManager,
  CodexDeviceLoginService,
  CodexSubscriptionService,
  createCodexAccountPoolLaunch,
  createCodexMaintenanceClient,
  createManagedCodexRefresh,
  startCodexAccountPoolServer,
  type CodexMaintenanceClientFactory,
} from "@opencraft/account-pool-host";

type RpcRecord = Record<string, unknown>;

interface PendingRequest {
  readonly clientId: string;
  readonly clientEpoch: number;
  readonly originalId: string | number;
  readonly method: string;
  readonly params: RpcRecord;
  invalidated?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingServerRequest {
  readonly message: RpcRecord;
  readonly threadId: string;
  ownerClientId: string | null;
}

const MAX_PENDING_SERVER_REQUESTS = 256;

interface SharedCodexRoutingOptions {
  readonly createThreadMetadata?: (database: import("node:sqlite").DatabaseSync, context: import("@opencraft/appserver-client").ThreadMetadataContext) => import("@opencraft/appserver-client").ThreadMetadataExtension;
  readonly logDiagnostic?: (event: Record<string, unknown>) => void;
  readonly nativeSubscriptionGraceMs?: number;
}

interface LocalCodexEngineOptions extends SharedCodexRoutingOptions {
  readonly desktop?: LocalDesktopService;
  readonly kind?: "local";
  readonly executable: string;
  readonly runtimeDirectory: string;
  readonly dataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly upstreamBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly createMaintenanceClient?: CodexMaintenanceClientFactory;
  readonly spawnAppServer?: (input: { readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

export interface RemoteCodexEngineOptions extends SharedCodexRoutingOptions {
  readonly kind: "remote";
  readonly transport: DuplexTransport;
  readonly attachments?: Omit<SshAttachmentStorage, "request">;
  readonly attachmentHistoryDirectory?: string;
}

const SHARED_NATIVE_METHODS: ReadonlySet<string> = new Set(CODEX_NATIVE_SHARED_METHODS);

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function responseId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex account operation failed";
}

class CodexQueueRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

function withCodexHostCapabilities(value: unknown, attachmentStaging: AttachmentStagingCapability, desktop?: HostDesktopCapability): RpcRecord {
  const result = record(value);
  const capabilities = record(result.capabilities);
  const extensions = { ...record(capabilities.extensions) };
  delete extensions[OPENCRAFT_DESKTOP_EXTENSION]; // This extension belongs to this Host, not native Codex.
  return {
    ...result,
    capabilities: {
      ...capabilities,
      extensions: {
        ...extensions,
        [OPENCRAFT_THREAD_PINS_EXTENSION]: OPENCRAFT_THREAD_PINS_CAPABILITY,
        [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: attachmentStaging,
        ...(desktop ? { [OPENCRAFT_DESKTOP_EXTENSION]: desktop } : {}),
        [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]:
          OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
        [OPENCRAFT_THREAD_LIFECYCLE_EXTENSION]: {
          version: 1,
          fork: true,
          ephemeral: true,
          injectItems: true,
          rename: true,
          archive: true,
          unsubscribe: true,
        } satisfies OpenCraftThreadLifecycleCapability,
        [OPENCRAFT_THREAD_QUEUE_EXTENSION]: {
          version: 2,
          reorder: true,
          atomicSteer: true,
          unconfirmedSteerDiscard: true,
          perItemPause: false,
        } satisfies OpenCraftThreadQueueCapability,
        [OPENCRAFT_THREAD_GOAL_EXTENSION]: { version: 1, read: true, write: true },
        [OPENCRAFT_PERMISSION_MODES_EXTENSION]: OPENCRAFT_PERMISSION_MODES_CAPABILITY,
      },
    },
  };
}

export class CodexEngineAdapter implements DuplexTransport {
  private readonly attachmentStaging: LocalAttachmentStagingService | SshAttachmentStagingService | null;
  private remoteAttachmentsReady = false;
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly initializeWaiters: PendingRequest[] = [];
  private readonly initializedClients = new Set<string>();
  private readonly clientEpochs = new Map<string, number>();
  private readonly threadClients = new Map<string, Set<string>>();
  /** The one native stdio connection is not one subscription per logical Client. */
  private readonly nativeSubscribedThreads = new Set<string>();
  private readonly ephemeralThreads = new Set<string>();
  private readonly nativeReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nativeReleases = new Map<string, Promise<void>>();
  private readonly threadInteractionOwners = new Map<string, string>();
  private readonly serverRequests = new Map<string, PendingServerRequest>();
  private readonly internalRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; threadId: string; method: string; params: RpcRecord }>();
  private readonly threadOperations = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly activeGoalThreads = new Set<string>();
  private readonly goalContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: CodexHostQueue | null = null;
  private hostState: CodexHostStateDatabase | null = null;
  private messageSenders: CodexMessageSenders | null = null;
  private threadMetadata: import("@opencraft/appserver-client").ThreadMetadataExtension | null = null;
  private metadataRequests = 0;
  private messageAttachments: CodexMessageAttachments | null = null;
  private statusValue: TransportStatus = { state: "idle" };
  private sequence = 0;
  private clientSequence = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private initializeResult: unknown | null = null;
  private threadPins: CodexThreadPins | null = null;
  private physicalInitializePending = false;
  private physicalInitialized = false;
  private remoteGoalCapability: OpenCraftThreadGoalCapability | null = null;
  private poolStore: AccountPoolStore | null = null;
  private poolServer: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | null = null;
  private login: CodexDeviceLoginService | null = null;
  private refresh: CodexCredentialRefreshManager | null = null;
  private subscriptions: CodexSubscriptionService | null = null;
  private stderrTail = "";
  private closeOperation: Promise<void> | null = null;
  private readonly desktopOwnerNamespace = randomUUID();
  private readonly remoteDisposers: Array<() => void> = [];

  constructor(private readonly options: LocalCodexEngineOptions | RemoteCodexEngineOptions) {
    this.attachmentStaging = options.kind === "remote"
      ? options.attachments && options.attachmentHistoryDirectory
        ? new SshAttachmentStagingService({ ...options.attachments,
            isRetained: id => this.messageAttachments?.hasReference(id) === true,
            request: (method, params) => this.requestPhysical(method, params, 120_000) })
        : null
      : new LocalAttachmentStagingService(join(options.dataDirectory, "attachments"));
  }

  private get physicalAvailable(): boolean {
    return this.options.kind === "remote" ? this.options.transport.status.state === "open" : this.child !== null;
  }
  private get desktopService(): LocalDesktopService | undefined {
    return this.options.kind === "remote" ? undefined : this.options.desktop;
  }

  private diagnostic(event: Record<string, unknown>): void {
    const entry = { component: "codex-engine-adapter", at: new Date().toISOString(), ...event };
    if (this.options.logDiagnostic) this.options.logDiagnostic(entry);
    else console.info("[codex-engine-diagnostic]", JSON.stringify(entry));
  }

  private async modelVisibleAttachmentInput(input: readonly unknown[]): Promise<{
    readonly input: unknown[];
    readonly attachments: AttachmentRef[];
  }> {
    const prepared: unknown[] = [];
    const attachments: AttachmentRef[] = [];
    for (const item of input) {
      const mention = record(item);
      if (mention.type !== "mention" || !string(mention.name) || !string(mention.path)) {
        prepared.push(item);
        continue;
      }
      const ref = await this.attachmentStaging?.referenceForHostPath(string(mention.name), string(mention.path));
      if (ref?.location.kind !== "host-file") {
        prepared.push(item);
        continue;
      }
      if (!attachments.some(existing => existing.id === ref.id)) attachments.push(ref);
      // Codex persists a mention in UserMessage but does not place it in the
      // model-facing text. Keep the mention for the attachment UI and add a
      // text locator that Codex can actually pass to the model. An empty UI
      // placeholder lets the shared projector omit only this generated text.
      const text = `The user attached a file named ${JSON.stringify(ref.name)}. Its readable path on this Host is ${JSON.stringify(ref.location.path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
      prepared.push({ type: "text", text, text_elements: [{
        byteRange: { start: 0, end: Buffer.byteLength(text, "utf8") }, placeholder: "opencraft:staged-file:v1",
      }] });
      prepared.push(item);
    }
    return { input: prepared, attachments };
  }

  get status(): TransportStatus { return this.statusValue; }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.statusValue.state === "open") return;
    if (signal?.aborted) throw signal.reason;
    this.publishStatus({ state: "connecting" });
    if (this.options.kind === "remote") {
      const transport = this.options.transport;
      if (this.attachmentStaging && this.options.attachmentHistoryDirectory) {
        await mkdir(this.options.attachmentHistoryDirectory, { recursive: true, mode: 0o700 });
        this.messageAttachments = new CodexMessageAttachments(this.options.attachmentHistoryDirectory);
      }
      if (this.options.attachmentHistoryDirectory) {
        await mkdir(this.options.attachmentHistoryDirectory, { recursive: true, mode: 0o700 });
        this.hostState = new CodexHostStateDatabase(this.options.attachmentHistoryDirectory);
        this.messageSenders = new CodexMessageSenders(this.hostState.database);
        this.installThreadMetadata();
      }
      this.remoteDisposers.push(transport.subscribeMessage(this.receivePhysicalLine), transport.subscribeStatus(status => {
        if (["closing", "closed"].includes(this.statusValue.state)) return;
        if (status.state === "failed" || status.state === "closed") this.rejectInternalRequests(new Error("Remote connection was interrupted"));
        this.publishStatus(status);
      }));
      try { await transport.connect(signal); this.publishStatus(transport.status); }
      catch (error) { this.publishStatus(transport.status); throw error; }
      return;
    }
    const dataRoot = this.options.dataDirectory;
    const runtimeRoot = join(dataRoot, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    this.hostState = new CodexHostStateDatabase(dataRoot);
    const queue = new CodexHostQueue(dataRoot, this.hostState.database);
    try {
      const migrated = queue.migrateNativeQueue(runtimeRoot);
      if (migrated > 0) this.diagnostic({ event: "native-queue-migrated", count: migrated });
    } catch (error) {
      queue.close();
      this.hostState.close();
      this.hostState = null;
      throw error;
    }
    this.queue = queue;
    this.messageAttachments = new CodexMessageAttachments(dataRoot);
    this.messageSenders = new CodexMessageSenders(this.hostState.database);
        this.installThreadMetadata();
    const store = new AccountPoolStore({
      databasePath: join(dataRoot, "account-pool.sqlite"),
      secretsDirectory: join(dataRoot, "secrets"),
    });
    this.poolStore = store;
    const executable = this.options.executable;
    const createMaintenanceClient = this.options.createMaintenanceClient
      ?? (codexHome => createCodexMaintenanceClient({ executable, codexHome }));
    const managedRefresh = createManagedCodexRefresh({
      refreshRoot: join(dataRoot, "refresh"),
      createClient: createMaintenanceClient,
    });
    const refresh = new CodexCredentialRefreshManager({ store, refresh: managedRefresh });
    this.refresh = refresh;
    const subscriptions = new CodexSubscriptionService({
      store,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
      fetch: this.options.fetch,
    });
    this.subscriptions = subscriptions;
    this.login = new CodexDeviceLoginService({
      store,
      loginRoot: join(dataRoot, "login"),
      createClient: createMaintenanceClient,
    });
    const proxy = new CodexAccountPoolProxy({
      store,
      upstreamBaseUrl: this.options.upstreamBaseUrl ?? "https://chatgpt.com/backend-api/codex",
      fetch: this.options.fetch,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
    });
    const poolServer = await startCodexAccountPoolServer({ proxy });
    this.poolServer = poolServer;
    subscriptions.start();
    const hostToken = store.issueHostToken("local-codex");
    const launch = createCodexAccountPoolLaunch({ baseUrl: poolServer.url, hostToken });
    const childArgs = ["app-server", "--stdio", ...launch.args];
    const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...launch.env,
        CODEX_HOME: runtimeRoot,
        OPENAI_API_KEY: "opencraft-account-pool",
        CODEX_API_KEY: undefined,
        CODEX_ACCESS_TOKEN: undefined,
    };
    const child = this.options.spawnAppServer?.({
      args: childArgs,
      cwd: this.options.runtimeDirectory,
      env: childEnv,
    }) ?? spawn(this.options.executable, childArgs, {
      cwd: this.options.runtimeDirectory,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.diagnostic({ event: "appserver-start", pid: child.pid ?? null });
    child.stderr.on("data", chunk => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", this.receivePhysicalLine);
    child.once("error", this.fail);
    child.once("close", (code, childSignal) => {
      this.diagnostic({ event: "appserver-exit", pid: child.pid ?? null, code, signal: childSignal, intentional: ["closing", "closed"].includes(this.statusValue.state) });
      if (["closing", "closed"].includes(this.statusValue.state)) return;
      this.fail(new Error(`Codex AppServer exited (${code ?? childSignal ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
    });
    const abort = () => { void this.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      await this.close();
      throw signal.reason;
    }
    this.publishStatus({ state: "open" });
    signal?.removeEventListener("abort", abort);
  }

  async send(frame: string): Promise<void> { return this.sendWithContext(frame, { sender: null }); }

  async sendWithContext(frame: string, context: TransportSubmissionContext): Promise<void> {
    if (this.statusValue.state !== "open" || !this.physicalAvailable) throw new Error("Codex Engine is not connected");
    let message = record(JSON.parse(frame));
    const clientId = string(message[LOGICAL_CLIENT_FIELD]);
    if (!clientId) throw new Error("Codex Engine requires a logical client identity");
    delete message[LOGICAL_CLIENT_FIELD];
    if (message.method === "runtime/client/disconnect") {
      this.diagnostic({ event: "client-disconnect", clientId, pid: this.child?.pid ?? null });
      this.disconnectClient(clientId);
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("opencraft/codex/accounts/")) {
      await this.handleAccountRequest(clientId, message);
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "initialize") {
      await this.handleInitialize(clientId, message);
      return;
    }
    const id = responseId(message.id);
    if (id !== null && typeof message.method === "string" && this.threadMetadata?.supports(message.method)) {
      if (!this.initializedClients.has(clientId)) { this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId); return; }
      if (this.metadataRequests >= 16) { this.emit({ id, error: { code: -32000, message: "Metadata request limit exceeded" } }, clientId); return; }
      const epoch = this.clientEpoch(clientId);
      this.metadataRequests++;
      try {
        const result = await this.threadMetadata.request(message.method, record(message.params));
        if (this.initializedClients.has(clientId) && epoch === this.clientEpoch(clientId)) this.emit({ id, result }, clientId);
      } catch {
        if (this.initializedClients.has(clientId) && epoch === this.clientEpoch(clientId)) this.emit({ id, error: { code: -32000, message: "Thread metadata is unavailable" } }, clientId);
      } finally { this.metadataRequests--; }
      return;
    }
    if (this.options.kind === "remote" && typeof message.method === "string" && !SHARED_NATIVE_METHODS.has(message.method)
      && !(message.method === "thread/goal/get" && this.remoteGoalCapability?.read)
      && !((message.method === "thread/goal/set" || message.method === "thread/goal/clear") && this.remoteGoalCapability?.write)
      && !(this.remoteAttachmentsReady && (message.method === "attachment/stage" || message.method === "attachment/remove"))) {
      if (id !== null) this.emit({ id, error: { code: -32601, message: "This operation is unavailable on the remote connection" } }, clientId);
      return;
    }
    if (id !== null && message.method === undefined && ("result" in message || "error" in message)) {
      const request = this.serverRequests.get(JSON.stringify(id));
      if (request?.ownerClientId !== clientId || !this.initializedClients.has(clientId)) return;
      this.serverRequests.delete(JSON.stringify(id));
      await this.writePhysical(message);
      return;
    }
    if (id !== null && typeof message.method === "string") {
      if (!this.initializedClients.has(clientId)) {
        this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId);
        return;
      }
      if (this.options.kind === "remote" && this.pending.size >= 1024) {
        this.emit({ id, error: { code: -32000, message: "Remote request limit exceeded" } }, clientId);
        return;
      }
      const requestClientEpoch = this.clientEpoch(clientId);
      if (message.method === "opencraft/thread-pins/list" || message.method === "opencraft/thread-pins/set") {
        try {
          const pins = this.threadPins ??= new CodexThreadPins((method, params) => this.requestPhysical(method, params));
          const params = record(message.params);
          if (message.method.endsWith("/set") && (typeof params.threadId !== "string" || typeof params.pinned !== "boolean")) throw new Error("Invalid pin command");
          const result = message.method.endsWith("/list") ? await pins.list() : await pins.set(params.threadId as string, params.pinned as boolean);
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) this.emit({ id, result }, clientId);
          if (message.method.endsWith("/set")) for (const subscriber of this.initializedClients) {
            this.emit({ method: "thread/pins/updated", params: { threadId: params.threadId } }, subscriber);
          }
        } catch (error) {
          this.diagnostic({ event: "thread-pins-failed", reason: errorMessage(error) });
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) this.emit({ id, error: { code: -32000, message: "无法更新置顶会话，请刷新列表核对后重试" } }, clientId);
        }
        return;
      }
      if (message.method === "attachment/stage" || message.method === "attachment/remove") {
        if (!this.initializedClients.has(clientId)) {
          this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId);
          return;
        }
        try {
          if (message.method === "attachment/remove" && this.messageAttachments?.hasReference(string(record(message.params).id))) {
            throw new Error("Sent attachments cannot be removed from history");
          }
          if (!this.attachmentStaging) throw new Error("Attachment staging is unavailable");
          const result = await this.attachmentStaging.handle(message.method, message.params);
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) {
            this.emit({ id, result }, clientId);
          }
        } catch (error) {
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) {
            this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
          }
        }
        return;
      }
      if (message.method === OPENCRAFT_DESKTOP_ATTACH || message.method === OPENCRAFT_DESKTOP_RELEASE) {
        await this.handleDesktopRequest(clientId, requestClientEpoch, id, message.method, message.params);
        return;
      }
      if (message.method.startsWith("thread/queue/")) {
        await this.handleQueueRequest(clientId, id, message.method, record(message.params), context);
        return;
      }
      if (message.method === "thread/unsubscribe") {
        await this.handleLogicalUnsubscribe(clientId, id, record(message.params));
        return;
      }
      const physicalId = `opencraft:${++this.sequence}`;
      let params = record(message.params);
      if (typeof params.permissions === "string") {
        try {
          const native = await this.resolvePermissionSelection(params.permissions, params.cwd);
          if (native !== params.permissions) {
            params = { ...params, permissions: native };
            message = { ...message, params };
          }
        } catch (error) {
          this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
          return;
        }
      }
      if ((message.method === "turn/start" || message.method === "turn/steer") && Array.isArray(params.input)) {
        try {
          this.validateSubmissionContext(context);
          const prepared = await this.modelVisibleAttachmentInput(params.input);
          this.recordSender(params, context);
          if (prepared.attachments.length > 0) this.attachmentRecords().record(
            string(params.threadId), string(params.clientUserMessageId), prepared.attachments);
          params = { ...params, input: prepared.input };
          delete params.sender;
          message = { ...message, params };
        } catch (error) {
          this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
          return;
        }
      }
      if (message.method === "turn/interrupt") this.diagnostic({
        event: "turn-interrupt", clientId, requestId: physicalId,
        threadId: string(params.threadId), turnId: string(params.turnId), pid: this.child?.pid ?? null,
      });
      if (message.method === "thread/resume") this.diagnostic({
        event: "thread-resume-start", clientId, requestId: physicalId,
        threadId: string(params.threadId), pid: this.child?.pid ?? null,
      });
      const forward = async () => {
        if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== requestClientEpoch) return;
        const pending: PendingRequest = { clientId, clientEpoch: requestClientEpoch, originalId: id, method: message.method as string, params };
        // Native fork has no fixed deadline in Workbench. Preserve that
        // contract; its ledger is still bounded by the admission limit and
        // retired with the physical generation, rather than timed out here.
        if (this.options.kind === "remote" && message.method !== "thread/fork") {
          pending.timer = setTimeout(() => {
            if (this.pending.get(physicalId) !== pending) return;
            this.pending.delete(physicalId);
            if (this.validClientRequest(pending)) this.emit({ id, error: { code: -32000, message: "Remote request timed out; delivery outcome is unknown" } }, clientId);
          }, 30_000);
          pending.timer.unref();
        }
        this.pending.set(physicalId, pending);
        if (message.method === "thread/resume") {
          const threadId = string(params.threadId);
          this.cancelNativeRelease(threadId);
        }
        await this.writePhysical({ ...message, id: physicalId });
      };
      if (message.method === "thread/resume") {
        const threadId = string(params.threadId);
        await this.nativeReleases.get(threadId);
        await forward();
      } else if ((message.method === "turn/start" || message.method === "turn/steer") && string(params.threadId)) {
        await this.withThreadOperation(string(params.threadId), forward);
      } else await forward();
      return;
    }
    // No allowlisted request may bypass initialization/ID mapping by being
    // disguised as a notification. Native initialized is consumed above.
    if (this.options.kind !== "remote") await this.writePhysical(message);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener); return () => this.statusListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation;
    this.publishStatus({ state: "closing" });
    this.physicalInitialized = false;
    this.remoteGoalCapability = null;
    this.revokeDesktopOwners();
    this.closeOperation = (async () => {
      for (const dispose of this.remoteDisposers.splice(0)) dispose();
      this.rejectInternalRequests(new Error("Codex AppServer closed"));
      if (this.attachmentStaging instanceof SshAttachmentStagingService) await this.attachmentStaging.close();
      if (this.options.kind === "remote") await this.options.transport.close();
      const child = this.child;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.rejectInternalRequests(new Error("Codex AppServer closed"));
      await this.login?.dispose().catch(() => undefined);
      this.login = null;
      await this.subscriptions?.dispose();
      this.subscriptions = null;
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
          timer.unref();
          child.once("close", () => { clearTimeout(timer); resolve(); });
          child.stdin.end();
          child.kill("SIGTERM");
        });
      }
      await this.poolServer?.close().catch(() => undefined);
      this.poolServer = null;
      this.poolStore?.close();
      this.poolStore = null;
      await Promise.allSettled([...this.threadOperations.values()]);
      this.queue?.close();
      this.queue = null;
      this.threadMetadata?.close();
      this.threadMetadata = null;
      this.messageSenders = null;
      this.hostState?.close();
      this.hostState = null;
      this.messageAttachments?.close();
      this.messageAttachments = null;
      for (const request of this.pending.values()) if (request.timer) clearTimeout(request.timer);
      this.pending.clear();
      this.initializeWaiters.length = 0;
      this.initializedClients.clear();
      this.clientEpochs.clear();
      this.threadClients.clear();
      for (const timer of this.nativeReleaseTimers.values()) clearTimeout(timer);
      this.nativeReleaseTimers.clear();
      this.nativeSubscribedThreads.clear();
      this.ephemeralThreads.clear();
      this.nativeReleases.clear();
      this.threadInteractionOwners.clear();
      this.serverRequests.clear();
      this.activeTurns.clear();
      for (const timer of this.goalContinuationTimers.values()) clearTimeout(timer);
      this.goalContinuationTimers.clear();
      this.activeGoalThreads.clear();
      this.threadOperations.clear();
      this.publishStatus({ state: "closed" });
    })();
    return this.closeOperation;
  }

  private async handleInitialize(clientId: string, message: RpcRecord): Promise<void> {
    const id = responseId(message.id);
    if (id === null) throw new Error("Initialize requires an id");
    if (this.options.kind === "remote" && this.initializeWaiters.length >= 1024) {
      this.emit({ id, error: { code: -32000, message: "Remote initialization limit exceeded" } }, clientId);
      return;
    }
    if (this.initializedClients.has(clientId)) this.disconnectClient(clientId);
    this.clientEpochs.set(clientId, ++this.clientSequence);
    const pending: PendingRequest = { clientId, clientEpoch: this.clientEpoch(clientId), originalId: id, method: "initialize", params: record(message.params) };
    this.initializedClients.add(clientId);
    if (this.initializeResult !== null) {
      this.diagnostic({ event: "client-initialize", clientId, source: "cached", outcome: "succeeded", pid: this.child?.pid ?? null });
      this.emit({ id, result: this.initializeResult }, clientId);
      return;
    }
    if (this.physicalInitializePending) {
      this.diagnostic({ event: "client-initialize", clientId, source: "physical-waiter", outcome: "started", pid: this.child?.pid ?? null });
      this.initializeWaiters.push(pending);
      return;
    }
    this.diagnostic({ event: "client-initialize", clientId, source: "physical", outcome: "started", pid: this.child?.pid ?? null });
    this.physicalInitializePending = true;
    const physicalId = `opencraft:${++this.sequence}`;
    if (this.options.kind === "remote") {
      pending.timer = setTimeout(() => {
        if (this.pending.get(physicalId) !== pending) return;
        this.pending.delete(physicalId);
        this.physicalInitializePending = false;
        for (const request of [pending, ...this.initializeWaiters.splice(0)]) {
          if (this.validClientRequest(request)) this.emit({ id: request.originalId, error: {
            code: -32000, message: "Remote initialization timed out",
          } }, request.clientId);
        }
        // A late success cannot establish readiness in this failed generation.
        this.publishStatus({ state: "failed", reason: "Remote initialization timed out",
          failure: { code: "SSH_RPC_INITIALIZE_TIMEOUT", recovery: "automatic" } });
      }, 15_000);
      pending.timer.unref();
    }
    this.pending.set(physicalId, pending);
    await this.writePhysical(this.options.kind === "remote" ? {
      id: physicalId, method: "initialize", params: {
        clientInfo: { name: "opencraft-ssh-hub", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    } : { ...message, id: physicalId });
  }

  private async completeInitialize(pending: PendingRequest, response: RpcRecord): Promise<void> {
    let message = response;
    if ("result" in message) {
      await this.writePhysical({ method: "initialized", params: {} });
      if (this.statusValue.state !== "open") return;
      this.physicalInitialized = true;
      if (this.options.kind === "remote") {
        let goalCapability: OpenCraftThreadGoalCapability | null = null;
        try {
          goalCapability = await discoverNativeCodexGoalCapability(message.result,
            (method, params) => this.requestPhysical(method, params, 3_000));
        } catch (error) {
          this.diagnostic({ event: "remote-goal-capability-unavailable", reason: errorMessage(error) });
        }
        // Closing/replacing the physical connection revokes a late discovery.
        if (this.statusValue.state !== "open" || !this.physicalAvailable) return;
        this.remoteGoalCapability = goalCapability;
        const shared = projectSharedNativeCodexInitialize(message.result, this.remoteGoalCapability);
        if (this.attachmentStaging instanceof SshAttachmentStagingService) {
          this.remoteAttachmentsReady = this.attachmentStaging.initialize(record(message.result).codexHome);
          if (this.remoteAttachmentsReady) {
            const capabilities = record(shared.capabilities);
            const extensions = record(capabilities.extensions);
            const methods = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]).methods as readonly string[];
            this.initializeResult = { ...shared, capabilities: { ...capabilities, extensions: {
              ...extensions,
              [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: this.attachmentStaging.capability,
              [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods: [...methods, "attachment/stage", "attachment/remove"] },
            } } };
          } else this.initializeResult = shared;
        } else this.initializeResult = shared;
      } else {
        this.initializeResult = this.attachmentStaging
          ? withCodexHostCapabilities(message.result, this.attachmentStaging.capability, this.desktopService?.capability())
          : projectSharedNativeCodexInitialize(message.result);
      }
      if (this.threadMetadata) {
        const value = record(this.initializeResult), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
        const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult = { ...value, capabilities: { ...capabilities, extensions: { ...extensions, ...this.threadMetadata.capabilities,
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, ...this.threadMetadata.methods])] } } : {}),
        } } };
      }
      message = { ...message, result: this.initializeResult };
    }
    this.physicalInitializePending = false;
    if (this.validClientRequest(pending)) this.emit({ ...message, id: pending.originalId }, pending.clientId);
    this.diagnostic({ event: "client-initialize", clientId: pending.clientId, source: "physical",
      outcome: "result" in message ? "succeeded" : "failed", pid: this.child?.pid ?? null });
    for (const waiter of this.initializeWaiters.splice(0)) {
      if (this.validClientRequest(waiter)) this.emit("result" in message
        ? { id: waiter.originalId, result: message.result }
        : { id: waiter.originalId, error: message.error }, waiter.clientId);
      this.diagnostic({ event: "client-initialize", clientId: waiter.clientId, source: "physical-waiter",
        outcome: "result" in message ? "succeeded" : "failed", pid: this.child?.pid ?? null });
    }
    if ("result" in message) {
      for (const threadId of this.queue?.pendingThreads() ?? []) this.scheduleQueueMaintenance(threadId);
      if (this.options.kind !== "remote") void this.discoverActiveGoals()
        .catch(error => this.diagnostic({ event: "goal-discovery-failed", reason: errorMessage(error) }));
    }
  }

  private readonly receivePhysicalLine = (line: string): void => {
    let message: RpcRecord;
    try { message = record(JSON.parse(line)); } catch { return; }
    const id = responseId(message.id);
    if (id !== null) {
      const internal = this.internalRequests.get(String(id));
      if (internal && typeof message.method !== "string") {
        this.internalRequests.delete(String(id));
        clearTimeout(internal.timer);
        if ("error" in message) internal.reject(this.rpcError(record(message.error)));
        else {
          if (internal.threadId && (internal.method === "thread/resume" || internal.method === "turn/start")) {
            this.nativeSubscribedThreads.add(internal.threadId);
            this.cancelNativeRelease(internal.threadId);
          }
          this.observeMetadataResult(internal.method, internal.params, message.result);
          internal.resolve(message.result);
        }
        return;
      }
      const pending = this.pending.get(String(id));
      if (pending !== undefined && typeof message.method !== "string") {
        this.pending.delete(String(id));
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.method === "initialize") {
          void this.completeInitialize(pending, message).catch(error => {
            this.physicalInitializePending = false;
            if (["closing", "closed"].includes(this.statusValue.state)) return;
            for (const request of [pending, ...this.initializeWaiters.splice(0)]) {
              if (this.validClientRequest(request)) this.emit({ id: request.originalId, error: {
                code: -32000, message: "Codex initialization failed",
              } }, request.clientId);
            }
            this.diagnostic({ event: "client-initialize-failed", reason: errorMessage(error) });
            this.publishStatus({ state: "failed", reason: "Codex initialization failed" });
          });
          return;
        }
        if (pending.method === "permissionProfile/list" && "result" in message) {
          const result = record(message.result);
          message = { ...message, result: {
            ...result,
            data: Array.isArray(result.data) ? projectPermissionProfileCatalog(
              result.data.map(entry => record(entry) as unknown as OpenCraftPermissionProfile),
              profile => codexPermissionMode(string(profile.id)),
            ) : result.data,
          } };
        }
        if ("result" in message) {
          if (pending.method === "thread/goal/get" || pending.method === "thread/goal/set") {
            this.noteGoal(string(pending.params.threadId), record(message.result).goal);
          } else if (pending.method === "thread/goal/clear" && record(message.result).cleared === true) {
            this.noteGoal(string(pending.params.threadId), null);
          }
          if (pending.method === "thread/fork" && pending.params.excludeTurns !== true) this.messageSenders?.cloneThread(
            string(pending.params.threadId), string(record(record(message.result).thread).id));
          if (pending.method === "thread/fork") this.messageAttachments?.cloneThread(
            string(pending.params.threadId), string(record(record(message.result).thread).id));
          this.noteNativeSubscription(pending, message.result);
          this.commitThreadSubscription(pending, message.result);
          if (pending.method === "thread/delete") {
            const threadId = string(pending.params.threadId);
            if (this.queue?.discardThread(threadId)) this.emitQueueChanged(threadId);
            this.activeTurns.delete(threadId);
            this.noteGoal(threadId, null);
          }
          if (pending.method === "thread/resume" || pending.method === "thread/start" || pending.method === "turn/start") {
            const threadId = pending.method === "thread/start"
              ? string(record(record(message.result).thread).id)
              : string(pending.params.threadId);
            if (threadId) this.scheduleQueueMaintenance(threadId);
          }
        }
        if (pending.method === "thread/resume") this.diagnostic({
          event: "thread-resume-finish", clientId: pending.clientId,
          threadId: string(pending.params.threadId),
          outcome: "result" in message ? "succeeded" : "failed", pid: this.child?.pid ?? null,
        });
        if ("result" in message) this.observeMetadataResult(pending.method, pending.params, message.result);
        if (this.messageSenders && "result" in message) message = { ...message, result: projectCodexMessageResult(
          this.projectSender, pending.method, pending.params, message.result) };
        if (this.validClientRequest(pending)) this.emit({
          ...message,
          ...(this.messageAttachments && "result" in message ? {
            result: projectCodexAttachmentResult(this.messageAttachments, pending.method, pending.params, message.result),
          } : {}),
          id: pending.originalId,
        }, pending.clientId);
        if (["thread/start", "thread/fork", "thread/resume", "turn/start"].includes(pending.method)) {
          const threadId = pending.method === "thread/start" || pending.method === "thread/fork"
            ? string(record(record(message.result).thread).id) : string(pending.params.threadId);
          this.scheduleNativeRelease(threadId);
        }
        return;
      }
      if (typeof message.method === "string") this.receiveServerRequest(id, message);
      return;
    }
    const threadId = string(record(message.params).threadId) || string(record(record(message.params).thread).id);
    if (message.method === "turn/started" && threadId) {
      const turnId = string(record(record(message.params).turn).id);
      if (turnId) this.activeTurns.set(threadId, turnId);
    }
    if (message.method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      this.scheduleQueueMaintenance(threadId);
      if (!record(record(message.params).turn).error) this.scheduleGoalContinuation(threadId);
      this.scheduleNativeRelease(threadId);
    }
    if (message.method === "thread/status/changed" && threadId && record(record(message.params).status).type === "idle") {
      this.activeTurns.delete(threadId);
      this.scheduleQueueMaintenance(threadId);
      this.scheduleNativeRelease(threadId);
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = responseId(record(message.params).requestId);
      if (requestId !== null) {
        const key = JSON.stringify(requestId);
        if (this.serverRequests.get(key)?.threadId === threadId) {
          this.serverRequests.delete(key);
          this.scheduleNativeRelease(threadId);
        }
      }
    }
    if (message.method === "thread/closed" && threadId) {
      this.nativeSubscribedThreads.delete(threadId);
      this.ephemeralThreads.delete(threadId);
      this.cancelNativeRelease(threadId);
    }
    if (message.method === "thread/goal/updated" && threadId) this.noteGoal(threadId, record(message.params).goal);
    if (message.method === "thread/goal/cleared" && threadId) this.noteGoal(threadId, null);
    try { this.threadMetadata?.observeNotification(message); }
    catch { this.diagnostic({ event: "thread-metadata-observation-failed" }); }
    if (this.messageSenders) message = projectCodexMessageNotification(this.projectSender, message);
    if (this.messageAttachments) message = projectCodexAttachmentNotification(this.messageAttachments, message);
    const targets = threadId ? this.threadTargets(threadId) : [];
    if (threadId && targets.length === 0) return;
    if (targets.length === 0) this.emit(message);
    else for (const target of targets) this.emit(message, target);
  };

  private commitThreadSubscription(pending: PendingRequest, result: unknown): void {
    if (!this.validClientRequest(pending)) return;
    if (pending.method === "thread/start" || pending.method === "thread/fork") {
      const threadId = string(record(record(result).thread).id);
      this.subscribeThread(threadId, pending.clientId);
      this.claimInteractionOwner(threadId, pending.clientId);
    } else if (pending.method === "thread/resume") {
      const threadId = string(pending.params.threadId);
      if (string(record(record(result).thread).id) !== threadId) return;
      this.subscribeThread(threadId, pending.clientId);
      this.claimInteractionOwner(threadId, pending.clientId);
    } else if (pending.method === "turn/start") {
      this.subscribeThread(string(pending.params.threadId), pending.clientId);
    }
  }

  private noteNativeSubscription(pending: PendingRequest, result: unknown): void {
    const threadId = pending.method === "thread/start" || pending.method === "thread/fork"
      ? string(record(record(result).thread).id) : string(pending.params.threadId);
    if (!threadId || !["thread/start", "thread/fork", "thread/resume", "turn/start"].includes(pending.method)) return;
    this.nativeSubscribedThreads.add(threadId);
    if (record(record(result).thread).ephemeral === true) this.ephemeralThreads.add(threadId);
    this.cancelNativeRelease(threadId);
  }

  private receiveServerRequest(id: string | number, message: RpcRecord): void {
    const key = JSON.stringify(id);
    if (this.serverRequests.has(key)) return;
    const threadId = string(record(message.params).threadId);
    if (!threadId || this.serverRequests.size >= MAX_PENDING_SERVER_REQUESTS) {
      void this.writePhysical({ id, error: {
        code: !threadId ? -32602 : -32000,
        message: !threadId ? "Server request has no Thread identity" : "Too many pending server requests",
      } })?.catch(() => undefined);
      return;
    }
    const candidate = this.threadInteractionOwners.get(threadId) ?? null;
    const ownerClientId = candidate !== null && this.initializedClients.has(candidate) ? candidate : null;
    this.serverRequests.set(key, { message, threadId, ownerClientId });
    if (ownerClientId !== null) this.emit(message, ownerClientId);
  }

  private claimInteractionOwner(threadId: string, clientId: string): void {
    if (!threadId) return;
    const current = this.threadInteractionOwners.get(threadId);
    if (current && current !== clientId && this.initializedClients.has(current)) return;
    this.threadInteractionOwners.set(threadId, clientId);
    for (const request of this.serverRequests.values()) {
      if (request.threadId !== threadId || request.ownerClientId !== null) continue;
      request.ownerClientId = clientId;
      this.emit(request.message, clientId);
    }
  }

  private releaseServerRequests(clientId: string, threadId?: string): void {
    for (const request of this.serverRequests.values()) {
      if (request.ownerClientId === clientId && (threadId === undefined || request.threadId === threadId)) {
        request.ownerClientId = null;
      }
    }
  }

  private clientEpoch(clientId: string): number { return this.clientEpochs.get(clientId) ?? 0; }

  private validClientRequest(request: PendingRequest): boolean {
    return !request.invalidated && this.initializedClients.has(request.clientId)
      && this.clientEpoch(request.clientId) === request.clientEpoch;
  }

  private threadTargets(threadId: string): string[] {
    const targets = new Set(this.threadClients.get(threadId) ?? []);
    // A join begins before native resume is sent. The Client's resume buffer
    // holds these events until its authoritative snapshot has been committed.
    for (const request of this.pending.values()) {
      if ((request.method === "thread/resume" || request.method === "turn/start")
        && request.params.threadId === threadId && this.validClientRequest(request)) targets.add(request.clientId);
    }
    return [...targets];
  }

  private async handleLogicalUnsubscribe(clientId: string, id: string | number, params: RpcRecord): Promise<void> {
    if (!this.initializedClients.has(clientId)) {
      this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId);
      return;
    }
    const requestClientEpoch = this.clientEpoch(clientId);
    const threadId = string(params.threadId);
    if (!threadId) {
      this.emit({ id, error: { code: -32602, message: "Unsubscribe requires threadId" } }, clientId);
      return;
    }
    const clients = this.threadClients.get(threadId);
    const wasSubscribed = clients?.delete(clientId) ?? false;
    if (clients?.size === 0) this.threadClients.delete(threadId);
    for (const request of this.pending.values()) {
      if (request.clientId === clientId && (request.method === "thread/resume" || request.method === "turn/start")
        && request.params.threadId === threadId) {
        request.invalidated = true;
      }
    }
    if (this.threadInteractionOwners.get(threadId) === clientId) {
      this.threadInteractionOwners.delete(threadId);
      this.releaseServerRequests(clientId, threadId);
    }
    this.scheduleNativeRelease(threadId);
    if (wasSubscribed) {
      this.emit({ id, result: { status: "unsubscribed" } }, clientId);
      return;
    }
    try {
      const status = await this.threadStatus(threadId) === "notLoaded" ? "notLoaded" : "notSubscribed";
      if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) {
        this.emit({ id, result: { status } }, clientId);
      }
    } catch (error) {
      if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) {
        this.emit({ id, error: { code: -32000, message: errorMessage(error) } }, clientId);
      }
    }
  }

  private cancelNativeRelease(threadId: string): void {
    const timer = this.nativeReleaseTimers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    this.nativeReleaseTimers.delete(threadId);
  }

  private hasHostThreadDemand(threadId: string): boolean {
    if (this.activeGoalThreads.has(threadId)) return true;
    if (this.activeTurns.has(threadId) || this.queue?.firstUnsettled(threadId) != null) return true;
    if ([...this.serverRequests.values()].some(request => request.threadId === threadId)) return true;
    if ([...this.pending.values()].some(request => request.params.threadId === threadId
      && (request.method === "turn/start" || request.method === "turn/steer"))) return true;
    return [...this.internalRequests.values()].some(request => request.threadId === threadId);
  }

  private canReleaseNativeSubscription(threadId: string): boolean {
    return this.statusValue.state === "open" && this.nativeSubscribedThreads.has(threadId)
      && this.threadTargets(threadId).length === 0 && !this.hasHostThreadDemand(threadId);
  }

  private scheduleNativeRelease(threadId: string, minimumDelayMs = 0): void {
    if (!threadId) return;
    this.cancelNativeRelease(threadId);
    if (this.nativeReleases.has(threadId) || !this.canReleaseNativeSubscription(threadId)) return;
    // A logical detach never directly issues native unsubscribe: the Host may
    // still need completion/queue/interaction events after the last View closes.
    const delay = Math.max(minimumDelayMs, this.ephemeralThreads.has(threadId) ? 0 : this.options.nativeSubscriptionGraceMs ?? 2 * 60 * 1_000);
    const timer = setTimeout(() => {
      this.nativeReleaseTimers.delete(threadId);
      this.releaseNativeSubscription(threadId);
    }, delay);
    timer.unref();
    this.nativeReleaseTimers.set(threadId, timer);
  }

  private releaseNativeSubscription(threadId: string): void {
    if (this.nativeReleases.has(threadId)) return;
    const operation = this.withThreadOperation(threadId, async () => {
      if (!this.canReleaseNativeSubscription(threadId)) return;
      const status = await this.threadStatus(threadId);
      if (!this.canReleaseNativeSubscription(threadId)) return;
      if (status === "notLoaded") {
        this.nativeSubscribedThreads.delete(threadId);
        this.ephemeralThreads.delete(threadId);
        return;
      }
      if (status !== "idle") return;
      const result = record(await this.requestPhysical("thread/unsubscribe", { threadId }));
      if (!["unsubscribed", "notSubscribed", "notLoaded"].includes(string(result.status))) {
        throw new Error("Codex returned an invalid thread/unsubscribe result");
      }
      this.nativeSubscribedThreads.delete(threadId);
      this.ephemeralThreads.delete(threadId);
    });
    this.nativeReleases.set(threadId, operation);
    void operation.catch(error => this.diagnostic({ event: "native-thread-release-failed", threadId, reason: errorMessage(error) }))
      .finally(() => {
        if (this.nativeReleases.get(threadId) === operation) this.nativeReleases.delete(threadId);
        this.scheduleNativeRelease(threadId, 1_000);
      });
  }

  private subscribeThread(threadId: string, clientId: string): void {
    if (!threadId) return;
    this.cancelNativeRelease(threadId);
    let clients = this.threadClients.get(threadId);
    if (clients === undefined) { clients = new Set(); this.threadClients.set(threadId, clients); }
    clients.add(clientId);
  }

  private disconnectClient(clientId: string): void {
    this.desktopService?.revoke(this.desktopOwnerKey(clientId, this.clientEpoch(clientId)));
    this.clientEpochs.delete(clientId);
    this.initializedClients.delete(clientId);
    const affected = new Set<string>();
    for (const [threadId, clients] of this.threadClients) {
      if (clients.delete(clientId)) affected.add(threadId);
      if (clients.size === 0) this.threadClients.delete(threadId);
    }
    for (const pending of this.pending.values()) {
      if (pending.clientId !== clientId || (pending.method !== "thread/resume" && pending.method !== "turn/start")) continue;
      pending.invalidated = true;
      affected.add(string(pending.params.threadId));
    }
    for (const [threadId, owner] of this.threadInteractionOwners) {
      if (owner === clientId) this.threadInteractionOwners.delete(threadId);
    }
    this.releaseServerRequests(clientId);
    for (const threadId of affected) this.scheduleNativeRelease(threadId);
  }

  private desktopOwnerKey(clientId: string, epoch: number): string {
    return JSON.stringify([this.desktopOwnerNamespace, clientId, epoch]);
  }

  private revokeDesktopOwners(): void {
    for (const [clientId, epoch] of this.clientEpochs) this.desktopService?.revoke(this.desktopOwnerKey(clientId, epoch));
  }

  private async handleDesktopRequest(clientId: string, epoch: number, id: string | number, method: string, rawParams: unknown): Promise<void> {
    const service = this.desktopService;
    const current = () => this.statusValue.state === "open" && this.initializedClients.has(clientId)
      && this.clientEpoch(clientId) === epoch;
    const key = this.desktopOwnerKey(clientId, epoch);
    try {
      if (!service || !current() || !rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) throw new Error();
      const params = record(rawParams);
      let result: unknown;
      if (method === OPENCRAFT_DESKTOP_ATTACH) {
        if (Object.keys(params).length !== 1 || typeof params.threadId !== "string") throw new Error();
        const owner: LocalDesktopOwner = { key, isCurrent: current, readThread: async threadId => {
          const response = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }, 5_000));
          const thread = record(response.thread);
          if (thread.id !== threadId || typeof thread.path !== "string" || typeof thread.createdAt !== "number") throw new Error();
          return { id: threadId, path: thread.path, createdAt: thread.createdAt };
        } };
        const credential = await service.prepare(owner, params.threadId);
        if (!current()) { service.release(key, credential.attachmentId); return; }
        result = credential;
      } else {
        if (Object.keys(params).length !== 1 || typeof params.attachmentId !== "string") throw new Error();
        service.release(key, params.attachmentId);
        result = {};
      }
      if (current()) this.emit({ id, result }, clientId);
    } catch {
      if (current()) this.emit({ id, error: { code: -32600, message: "Desktop is unavailable" } }, clientId);
    }
  }

  private async handleAccountRequest(clientId: string, message: RpcRecord): Promise<void> {
    const id = responseId(message.id);
    if (id === null) return;
    try {
      const store = this.poolStore;
      const login = this.login;
      const refresh = this.refresh;
      const subscriptions = this.subscriptions;
      if (store === null || login === null || refresh === null || subscriptions === null) throw new Error("Codex account service is unavailable");
      const params = record(message.params);
      let result: unknown;
      switch (message.method) {
        case "opencraft/codex/accounts/list": result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/setEnabled":
          store.setEnabled(string(params.accountId), params.enabled === true);
          if (params.enabled === true) void subscriptions.refreshAccount(string(params.accountId)).catch(() => undefined);
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/reorder":
          if (!Array.isArray(params.accountIds)) throw new Error("Invalid account order");
          store.reorder("codex", params.accountIds.map(string));
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/remove":
          store.removeAccount(string(params.accountId));
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/refresh": {
          await subscriptions.refreshAccount(string(params.accountId));
          result = { accounts: this.accountViews(store) }; break;
        }
        case "opencraft/codex/accounts/import": {
          if (this.options.kind === "remote") throw new Error("Local account import is unavailable");
          const imported = await login.importFrom(this.options.nativeCodexHomeDirectory);
          void subscriptions.refreshAccount(imported.id).catch(() => undefined);
          const account = this.accountViews(store).find(candidate => candidate.id === imported.id);
          if (account === undefined) throw new Error("Imported Codex account was not found");
          result = { account };
          break;
        }
        case "opencraft/codex/accounts/deviceLogin/start": result = await login.start(); break;
        case "opencraft/codex/accounts/deviceLogin/poll": {
          const polled = await login.poll(string(params.sessionId));
          if (polled.status !== "complete") result = polled;
          else {
            void subscriptions.refreshAccount(polled.account.id).catch(() => undefined);
            const account = this.accountViews(store).find(candidate => candidate.id === polled.account.id);
            if (account === undefined) throw new Error("Codex account was not found after login");
            result = { status: "complete", account };
          }
          break;
        }
        case "opencraft/codex/accounts/deviceLogin/cancel": result = { cancelled: await login.cancel(string(params.sessionId)) }; break;
        default: throw new Error("Unsupported Codex account method");
      }
      this.emit({ id, result }, clientId);
    } catch (error) {
      this.emit({ id, error: { code: -32020, message: errorMessage(error) } }, clientId);
    }
  }

  private accountViews(store: AccountPoolStore): CodexAccountView[] {
    const states = new Map(store.listAccountStates().map(state => [state.accountId, state]));
    return store.listAccounts().map(account => {
      const state = states.get(account.id);
      if (state === undefined) throw new Error("Codex account state is unavailable");
      return {
        id: account.id,
        label: account.label,
        priority: account.priority,
        enabled: account.enabled,
        credentialConfigured: account.credentialConfigured,
        email: state.email,
        subscriptionType: state.subscriptionType,
        rateLimitTier: state.rateLimitTier,
        status: state.status,
        observedAt: state.observedAt,
        heldUntil: state.heldUntil,
        lastUsedAt: state.lastUsedAt,
        lastUsedHostId: state.lastUsedHostId,
        limitWindows: state.limitWindows.map(window => ({
          slot: window.slot,
          windowMinutes: window.windowMinutes,
          utilization: window.utilization,
          resetAt: window.resetAt,
          observedAt: window.observedAt,
        })),
      };
    });
  }

  private rpcError(error: RpcRecord): CodexQueueRpcError {
    return new CodexQueueRpcError(typeof error.code === "number" ? error.code : -32000,
      string(error.message) || "Codex AppServer request failed", error.data);
  }

  private async resolvePermissionSelection(selection: string, cwd: unknown): Promise<string> {
    const mode = parsePermissionModeProfileId(selection);
    if (mode === null) return selection;
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = record(await this.requestPhysical("permissionProfile/list", {
        cursor, limit: 100, ...(typeof cwd === "string" ? { cwd } : {}),
      }));
      if (!Array.isArray(result.data)) throw new Error("Codex permission catalog is unavailable");
      for (const entry of result.data) {
        const profile = record(entry);
        if (codexPermissionMode(string(profile.id)) !== mode) continue;
        if (profile.allowed !== true) throw new Error(`Permission mode is disabled by Codex requirements: ${mode}`);
        return string(profile.id);
      }
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) throw new Error("Codex permission catalog did not advance");
      cursor = result.nextCursor;
    }
    throw new Error(`Permission mode is unavailable on this Codex Host: ${mode}`);
  }

  private requestPhysical(method: string, params: RpcRecord, timeoutMs = 30_000): Promise<unknown> {
    if (this.statusValue.state !== "open" || !this.physicalAvailable || !this.physicalInitialized) {
      return Promise.reject(new Error("Codex AppServer is not initialized"));
    }
    const id = `opencraft:host:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internalRequests.delete(id);
        reject(new Error(`Codex ${method} delivery outcome is unknown after timeout`));
      }, timeoutMs);
      this.internalRequests.set(id, { resolve, reject, timer, threadId: string(params.threadId), method, params });
      try {
        const write = this.writePhysical({ id, method, params });
        void write?.catch(error => {
          if (!this.internalRequests.delete(id)) return;
          clearTimeout(timer); reject(error);
        });
      }
      catch (error) {
        clearTimeout(timer);
        this.internalRequests.delete(id);
        reject(error);
      }
    });
  }

  private rejectInternalRequests(error: Error): void {
    for (const request of this.internalRequests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.internalRequests.clear();
  }

  private queueStore(): CodexHostQueue {
    if (!this.queue) throw new Error("Codex Host queue is unavailable");
    return this.queue;
  }

  private attachmentRecords(): CodexMessageAttachments {
    if (!this.messageAttachments) throw new Error("Codex message attachments are unavailable");
    return this.messageAttachments;
  }

  private installThreadMetadata(): void {
    if (!this.options.createThreadMetadata || !this.hostState) return;
    this.threadMetadata = this.options.createThreadMetadata(this.hostState.database, {
      getSender: (threadId, messageId) => this.messageSenders?.get(threadId, messageId) ?? null,
      hasSenders: threadId => this.messageSenders?.hasEmployees(threadId) === true,
      readMessageIds: async (threadId, turnId) => {
        const ids: string[] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        for (let page = 0; page < 1000; page++) {
          const value = record(await this.requestPhysical("thread/items/list", {
            threadId, ...(turnId ? { turnId } : {}), ...(cursor ? { cursor } : {}), limit: 1000,
          }));
          if (!Array.isArray(value.data)) throw new Error("Invalid metadata history page");
          for (const entry of value.data) {
            const item = record(record(entry).item);
            if (item.type === "userMessage") {
              const id = string(item.clientId) || string(item.client_id) || string(item.clientUserMessageId);
              if (id) ids.push(id);
            }
          }
          if (value.nextCursor == null) return ids;
          if (typeof value.nextCursor !== "string" || cursors.has(value.nextCursor)) throw new Error("Invalid metadata history cursor");
          cursor = value.nextCursor; cursors.add(cursor);
        }
        throw new Error("Metadata history exceeds reconciliation limit");
      },
      notify: (method, params) => {
        // Every initialized reader on this Host receives catalog metadata changes.
        for (const clientId of this.initializedClients) this.emit({ method, params }, clientId);
      },
    });
  }

  private observeMetadataResult(method: string, params: RpcRecord, result: unknown): void {
    try { this.threadMetadata?.observeResult(method, params, result); }
    catch { this.diagnostic({ event: "thread-metadata-observation-failed" }); }
  }

  private readonly projectSender = (threadId: string, clientId: string, value: RpcRecord): RpcRecord => {
    const { sender: _untrusted, ...rest } = value;
    return { ...rest, sender: this.messageSenders?.get(threadId, clientId) ?? null };
  };

  private validateSubmissionContext(context: TransportSubmissionContext): void {
    if (context.sender && (!Number.isFinite(context.validUntil) || Date.now() > context.validUntil!)) {
      throw new Error("Employee identity expired; reconnect before sending");
    }
  }

  private recordSender(params: RpcRecord, context: TransportSubmissionContext): void {
    this.validateSubmissionContext(context);
    const threadId = string(params.threadId), messageId = string(params.clientUserMessageId);
    // Legacy native clients without message IDs remain unattributed.
    if (!messageId && !context.sender) return;
    if (!this.messageSenders) throw new Error("Message sender storage is unavailable");
    this.messageSenders.record(threadId, messageId, context.sender);
  }

  private queueProjection(row: HostQueuedSubmission): RpcRecord {
    return {
      id: row.id,
      input: row.input,
      clientUserMessageId: row.clientUserMessageId,
      sender: this.messageSenders?.get(row.threadId, row.clientUserMessageId) ?? null,
      createdAt: row.createdAt,
      pausedReason: row.pausedReason,
    };
  }

  private emitQueueChanged(threadId: string): void {
    const clients = this.threadClients.get(threadId);
    if (!clients || clients.size === 0) return;
    for (const clientId of clients) this.emit({ method: "thread/queue/changed", params: { threadId } }, clientId);
  }

  private withThreadOperation<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.threadOperations.get(threadId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(work);
    const tail = running.then(() => undefined, () => undefined);
    this.threadOperations.set(threadId, tail);
    void tail.then(() => {
      if (this.threadOperations.get(threadId) === tail) this.threadOperations.delete(threadId);
      this.scheduleNativeRelease(threadId);
    });
    return running;
  }

  private noteGoal(threadId: string, value: unknown): void {
    if (!threadId) return;
    if (record(value).status === "active") {
      this.activeGoalThreads.add(threadId);
      this.cancelNativeRelease(threadId);
    } else {
      this.activeGoalThreads.delete(threadId);
      const timer = this.goalContinuationTimers.get(threadId);
      if (timer) clearTimeout(timer);
      this.goalContinuationTimers.delete(threadId);
      this.scheduleNativeRelease(threadId);
    }
  }

  /** Goal continuation belongs to the Host, not a browser View or websocket lease. */
  private scheduleGoalContinuation(threadId: string): void {
    if (this.options.kind === "remote" || !this.activeGoalThreads.has(threadId) || this.goalContinuationTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.goalContinuationTimers.delete(threadId);
      void this.withThreadOperation(threadId, async () => {
        if (!this.activeGoalThreads.has(threadId) || this.activeTurns.has(threadId)) return;
        if (this.queue?.firstAwaitingAdmission(threadId)) return;
        if (!(await this.queueThreadIsIdle(threadId))) return;
        const result = record(await this.requestPhysical("thread/goal/get", { threadId }));
        this.noteGoal(threadId, result.goal);
        if (!this.activeGoalThreads.has(threadId) || this.activeTurns.has(threadId)) return;
        await this.requestPhysical("thread/goal/set", { threadId, status: "active" });
      }).catch(error => this.diagnostic({ event: "goal-continuation-failed", threadId, reason: errorMessage(error) }));
    }, 150);
    timer.unref();
    this.goalContinuationTimers.set(threadId, timer);
  }

  /** Rebuild the Host's active Goal index from Codex's durable Thread state. */
  private async discoverActiveGoals(): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < 1_000 && this.statusValue.state === "open"; page++) {
      const response = record(await this.requestPhysical("thread/list", {
        limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}),
      }));
      if (!Array.isArray(response.data)) throw new Error("Codex Thread list has no data");
      for (const thread of response.data) {
        const threadId = string(record(thread).id);
        if (!threadId || this.ephemeralThreads.has(threadId)) continue;
        const result = record(await this.requestPhysical("thread/goal/get", { threadId }));
        this.noteGoal(threadId, result.goal);
        if (this.activeGoalThreads.has(threadId)) this.scheduleGoalContinuation(threadId);
      }
      if (response.nextCursor === null) return;
      if (typeof response.nextCursor !== "string" || response.nextCursor === cursor) throw new Error("Codex Thread list did not advance");
      cursor = response.nextCursor;
    }
    if (cursor !== null) throw new Error("Codex Goal discovery exceeded its safety bound");
  }

  private scheduleQueueMaintenance(threadId: string): void {
    if (!threadId || this.queue === null || this.initializeResult === null) return;
    void this.withThreadOperation(threadId, () => this.maintainQueue(threadId)).catch(error => {
      this.diagnostic({ event: "queue-maintenance-failed", threadId, reason: errorMessage(error) });
    });
  }

  private async threadStatus(threadId: string): Promise<string> {
    const response = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
    return string(record(record(response.thread).status).type);
  }

  private async assertDurableQueueThread(threadId: string): Promise<void> {
    const response = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
    const thread = record(response.thread);
    if (string(thread.id) !== threadId) throw new CodexQueueRpcError(-32600, "Queued Thread was not found");
    if (thread.ephemeral === true) throw new CodexQueueRpcError(-32600, "Ephemeral Thread cannot own durable queued input");
    if (thread.canAcceptDirectInput === false) throw new CodexQueueRpcError(-32600, "Thread does not accept direct user input");
  }

  private async queueThreadIsIdle(threadId: string): Promise<boolean> {
    let status = await this.threadStatus(threadId);
    if (status === "notLoaded") {
      await this.requestPhysical("thread/resume", { threadId });
      status = await this.threadStatus(threadId);
    }
    return status === "idle";
  }

  private async historyHasClientMessage(threadId: string, clientId: string, turnId: string | null): Promise<boolean> {
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const response = record(await this.requestPhysical("thread/items/list", {
        threadId, ...(turnId ? { turnId } : {}), ...(cursor ? { cursor } : {}), limit: 100,
      }));
      const entries = response.data;
      if (!Array.isArray(entries)) throw new Error("Codex history response has no items");
      for (const entry of entries) {
        const item = record(record(entry).item);
        if (item.type === "userMessage" && item.clientId === clientId) return true;
      }
      const next = response.nextCursor;
      if (next === null || next === undefined) return false;
      if (typeof next !== "string" || next === cursor) throw new Error("Codex history pagination did not advance");
      cursor = next;
    }
    throw new Error("Codex history is too long to reconcile safely");
  }

  private async reconcileQueue(threadId: string): Promise<void> {
    const queue = this.queueStore();
    const unsettled = queue.list(threadId).filter(row => row.state === "unknown" || row.state === "steering");
    for (const row of unsettled) {
      if (await this.historyHasClientMessage(threadId, row.clientUserMessageId,
        row.targetTurnId === "unknown" ? null : row.targetTurnId)) {
        queue.settle(threadId, row.id, "delivered");
        this.emitQueueChanged(threadId);
      } else if (row.state === "steering" && await this.queueThreadIsIdle(threadId)) {
        queue.settle(threadId, row.id, "unknown", "steer-delivery-unconfirmed");
        this.emitQueueChanged(threadId);
      }
    }
  }

  private async maintainQueue(threadId: string): Promise<void> {
    const queue = this.queueStore();
    await this.reconcileQueue(threadId);
    const first = queue.firstAwaitingAdmission(threadId);
    if (!first || first.state !== "queued") return;
    if ([...this.pending.values()].some(pending => pending.method === "turn/start" && pending.params.threadId === threadId)) return;
    if (this.activeTurns.has(threadId) || !(await this.queueThreadIsIdle(threadId))) return;
    await this.dispatchQueuedStart(threadId, first.id);
  }

  private async dispatchQueuedStart(threadId: string, id: string): Promise<RpcRecord> {
    const queue = this.queueStore();
    const head = queue.firstAwaitingAdmission(threadId);
    if (head?.state === "unknown") throw new CodexQueueRpcError(-32600, "Earlier delivery is unconfirmed; review it before sending another message");
    if (head?.state === "dispatching") throw new CodexQueueRpcError(-32600, "Earlier delivery is still being sent");
    const queued = queue.find(threadId, id);
    if (!queued) throw new CodexQueueRpcError(-32600, "Queued message is unavailable");
    const prepared = await this.modelVisibleAttachmentInput(queued.input);
    if (prepared.attachments.length > 0) this.attachmentRecords().record(
      threadId, queued.clientUserMessageId, prepared.attachments);
    const row = queue.claim(threadId, id, "unknown");
    if (!row) throw new CodexQueueRpcError(-32600, "Queued message is already being dispatched");
    this.emitQueueChanged(threadId);
    try {
      const response = record(await this.requestPhysical("turn/start", {
        threadId, input: prepared.input, clientUserMessageId: row.clientUserMessageId,
      }));
      if (!string(record(response.turn).id)) throw new Error("Codex returned an invalid turn/start acknowledgement");
      queue.settle(threadId, id, "delivered");
      this.emitQueueChanged(threadId);
      return response;
    } catch (error) {
      queue.settle(threadId, id, "unknown", "steer-delivery-unconfirmed");
      this.emitQueueChanged(threadId);
      throw error;
    }
  }

  private definitiveSteerRejection(error: unknown): boolean {
    if (!(error instanceof CodexQueueRpcError)) return false;
    if (error.code === -32601) return true;
    if (error.code !== -32600) return false;
    const info = record(record(error.data).codexErrorInfo);
    return Boolean(info.activeTurnNotSteerable) || error.message === "no active turn to steer"
      || /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.message)
      || error.message === "active turn uses a different output schema";
  }

  private async dispatchQueuedSteer(threadId: string, id: string, expectedTurnId: string): Promise<RpcRecord> {
    const queue = this.queueStore();
    if (queue.firstAwaitingAdmission(threadId)?.state === "unknown") await this.reconcileQueue(threadId);
    const head = queue.firstAwaitingAdmission(threadId);
    if (head?.state === "unknown") throw new CodexQueueRpcError(-32600, "Earlier delivery is unconfirmed; review it before sending another message");
    if (head?.state === "dispatching") throw new CodexQueueRpcError(-32600, "Earlier delivery is still being sent");
    const queued = queue.find(threadId, id);
    if (!queued) throw new CodexQueueRpcError(-32600, "Queued message is unavailable");
    const prepared = await this.modelVisibleAttachmentInput(queued.input);
    if (prepared.attachments.length > 0) this.attachmentRecords().record(
      threadId, queued.clientUserMessageId, prepared.attachments);
    const row = queue.claim(threadId, id, expectedTurnId);
    if (!row) throw new CodexQueueRpcError(-32600, "Queued message is already being dispatched");
    this.emitQueueChanged(threadId);
    try {
      const response = record(await this.requestPhysical("turn/steer", {
        threadId, expectedTurnId, input: prepared.input, clientUserMessageId: row.clientUserMessageId,
      }));
      const turnId = string(response.turnId) || string(record(response.turn).id);
      if (turnId !== expectedTurnId) throw new Error("Codex returned an invalid steer acknowledgement");
      queue.settle(threadId, id, "steering");
      this.emitQueueChanged(threadId);
      return { turnId };
    } catch (error) {
      const rejected = this.definitiveSteerRejection(error);
      queue.settle(threadId, id, rejected ? "queued" : "unknown",
        rejected ? null : "steer-delivery-unconfirmed");
      this.emitQueueChanged(threadId);
      throw error;
    }
  }

  private async handleQueueRequest(clientId: string, id: string | number, method: string, params: RpcRecord, context: TransportSubmissionContext): Promise<void> {
    const threadId = string(params.threadId);
    try {
      if (!this.initializedClients.has(clientId)) throw new CodexQueueRpcError(-32600, "Client is not initialized");
      if (!threadId) throw new CodexQueueRpcError(-32602, "Queue request requires threadId");
      const queue = this.queueStore();
      let result: RpcRecord;
      if (method === "thread/queue/list") {
        const cursor = params.cursor == null ? 0 : Number(params.cursor);
        const limit = params.limit == null ? 50 : Number(params.limit);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new CodexQueueRpcError(-32602, "Invalid queue pagination");
        const rows = queue.list(threadId);
        const queued = rows.filter(row => row.state === "queued");
        const page = queued.slice(cursor, cursor + Math.min(limit, 100));
        result = {
          data: page.map(row => this.queueProjection(row)),
          nextCursor: cursor + page.length < queued.length ? String(cursor + page.length) : null,
          ...(cursor === 0 ? { steering: rows.filter(row => row.state === "steering" || row.state === "unknown" || row.state === "dispatching")
            .map(row => ({ ...this.queueProjection(row), targetTurnId: row.targetTurnId ?? "unknown" })) } : {}),
        };
      } else if (method === "thread/queue/add") {
        await this.assertDurableQueueThread(threadId);
        const row = this.hostState!.transaction(() => {
          this.recordSender(params, context);
          return queue.add(threadId, string(params.clientUserMessageId), params.input as readonly unknown[]);
        });
        result = { queuedSubmission: this.queueProjection(row) };
        this.emitQueueChanged(threadId);
        this.scheduleQueueMaintenance(threadId);
      } else if (method === "thread/queue/update") {
        const row = queue.update(threadId, string(params.queuedSubmissionId), params.input as readonly unknown[]);
        if (!row) throw new CodexQueueRpcError(-32600, "Queued message is not editable");
        result = { queuedSubmission: this.queueProjection(row) };
        this.emitQueueChanged(threadId);
      } else if (method === "thread/queue/delete") {
        const itemId = string(params.queuedSubmissionId);
        if (params.acknowledgeUnknownDelivery === true) {
          const target = string(params.expectedTurnId);
          const row = queue.find(threadId, itemId);
          if (!target || !row || row.state !== "unknown" || row.targetTurnId !== target) {
            throw new CodexQueueRpcError(-32600, "Unknown delivery claim does not match the target turn");
          }
          await this.withThreadOperation(threadId, async () => {
            if (!(await this.queueThreadIsIdle(threadId))) throw new CodexQueueRpcError(-32600, "Turn is still active");
            if (await this.historyHasClientMessage(threadId, row.clientUserMessageId, target === "unknown" ? null : target)) {
              queue.settle(threadId, itemId, "delivered");
              this.emitQueueChanged(threadId);
              throw new CodexQueueRpcError(-32600, "Steered input is present in Codex history");
            }
            if (!queue.discardUnknown(threadId, itemId, target)) throw new CodexQueueRpcError(-32600, "Delivery claim changed before discard");
          });
          result = { deleted: true };
        } else {
          result = { deleted: queue.delete(threadId, itemId) };
        }
        this.emitQueueChanged(threadId);
        this.scheduleQueueMaintenance(threadId);
      } else if (method === "thread/queue/reorder") {
        if (!Array.isArray(params.queuedSubmissionIds)) throw new CodexQueueRpcError(-32602, "Queue order must be an array");
        queue.reorder(threadId, params.queuedSubmissionIds as string[]);
        result = {};
        this.emitQueueChanged(threadId);
      } else if (method === "thread/queue/start") {
        result = await this.withThreadOperation(threadId, async () => {
          if (!(await this.queueThreadIsIdle(threadId))) throw new CodexQueueRpcError(-32600, "Thread is not idle");
          await this.reconcileQueue(threadId);
          const row = string(params.queuedSubmissionId)
            ? queue.find(threadId, string(params.queuedSubmissionId))
            : queue.firstAwaitingAdmission(threadId);
          if (row?.state === "unknown") throw new CodexQueueRpcError(-32600, "Earlier delivery is unconfirmed; review it before sending another message");
          if (!row || row.state !== "queued") throw new CodexQueueRpcError(-32600, "Queued message is unavailable");
          return this.dispatchQueuedStart(threadId, row.id);
        });
      } else if (method === "thread/queue/steer") {
        const target = string(params.expectedTurnId);
        if (!target) throw new CodexQueueRpcError(-32602, "Steer requires expectedTurnId");
        result = await this.withThreadOperation(threadId, () => this.dispatchQueuedSteer(threadId, string(params.queuedSubmissionId), target));
      } else throw new CodexQueueRpcError(-32601, `Unknown queue method ${method}`);
      this.emit({ id, result }, clientId);
    } catch (error) {
      this.emit({ id, error: { code: error instanceof CodexQueueRpcError ? error.code : -32000,
        message: errorMessage(error), ...(error instanceof CodexQueueRpcError && error.data !== undefined ? { data: error.data } : {}) } }, clientId);
    }
  }

  private writePhysical(message: RpcRecord): Promise<void> | void {
    // Product default, not a second reasoning owner: all native starts (also
    // Host queue delivery) request returned summaries. Explicit null keeps
    // native inheritance; explicit modes and invalid values remain native's
    // responsibility. Never put this option on steer or another engine.
    if (message.method === "turn/start" && responseId(message.id) !== null) {
      const params = record(message.params);
      if (!Object.hasOwn(params, "summary")) {
        message = { ...message, params: { ...params, summary: "auto" } };
      }
    }
    if (this.options.kind === "remote") {
      return this.options.transport.send(JSON.stringify(message)).catch(() => {
        this.rejectInternalRequests(new Error("Remote delivery outcome is unknown"));
        this.publishStatus({ state: "failed", reason: "Remote delivery outcome is unknown", failure: { code: "SSH_DELIVERY_UNKNOWN", recovery: "automatic" } });
        throw new Error("Remote delivery outcome is unknown");
      });
    }
    if (this.child === null || this.child.stdin.destroyed) throw new Error("Codex AppServer stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private emit(message: RpcRecord, clientId?: string): void {
    const frame = JSON.stringify(clientId ? { ...message, [LOGICAL_CLIENT_FIELD]: clientId } : message);
    for (const listener of this.listeners) listener(frame);
  }

  private readonly fail = (error: Error): void => {
    this.revokeDesktopOwners();
    this.rejectInternalRequests(error);
    for (const timer of this.goalContinuationTimers.values()) clearTimeout(timer);
    this.goalContinuationTimers.clear();
    this.publishStatus({ state: "failed", reason: error.message, failure: { code: "codex-appserver-exited", recovery: "automatic" } });
  };

  private publishStatus(status: TransportStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

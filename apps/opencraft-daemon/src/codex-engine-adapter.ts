import { ensureNativeCreationIndex } from "./native-empty-thread-index.js";
import { collaborationQueueGuard, type CodexBridgeOwners } from "./codex-bridge-owners.js";
import { prepareHistoryImages } from "./history-image-resources.js";
import { readInputCompletion } from "./input-completion.js";
import { CodexAccountOperationError, classifyAccountFailure, logAccountFailure } from "@opencraft/account-pool-host";
import { inputExecutionEnded, isThreadGoalPauseRequest } from "@opencraft/appserver-protocol";
import { bindModelGatewaySponsor, requiresModelGateway, configuredModelGatewayPath, ModelGatewayStore, ModelGatewayError } from "@opencraft/account-pool-host";
import { captureGeneratedOutputs } from "@opencraft/local-agent-host/artifacts/tool-output";
import { generatedFileRootsFromEnvironment } from "@opencraft/local-agent-host/artifacts/host-capture";
import { type GeneratedFileReader } from "@opencraft/local-agent-host/artifacts/generated-output";
import { prepareLocalArtifact, type Artifact } from "@opencraft/local-agent-host/artifacts";
import { SERVER_REQUEST_CANCEL, SERVER_REQUEST_CANCELLATION_EXTENSION } from '@opencraft/appserver-protocol';
import { assertModelPolicy, readPolicy, resolvePolicySelection, ModelPolicyError } from '@opencraft/model-usage-policy/native';
import { ProvisionalThreads } from "./provisional-threads.js";
import { nativeEmptyCreation } from "./native-empty-creation.js";
import { HostInteractions, InteractionFault } from "@opencraft/app-host-server/interactions";
import { COLLABORATION_CAPABILITIES, type CollaborationCapabilities } from '@opencraft/appserver-protocol/collaboration';
import { SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND, isHumanInteraction, type InteractionSourceRequest } from "@opencraft/appserver-protocol";
import { projectThreadTopologyResult } from "./thread-orchestration-projection.js";
import type { HumanGitExecutionPort } from '@opencraft/execution-environment/human-git-execution';
import type { GitExecutionHandoff, GitExecutionReservation } from '@opencraft/execution-environment/git-execution';
import { observeNativeExecutionProcess, observeStandaloneCodexExecution } from './native-execution-origin.js';
import { ExecutionLeaseStore, type ExecutionSubmission, originalExecutionInputIds, snapshotExecutionSubmission } from "./execution-lease-store.js";
import { EXECUTION_ENVIRONMENT_FIELD, requiresEnvironmentAuthority, requiresCurrentEnvironmentAuthority, executionEnvironmentOwner, type ExecutionEnvironmentRuntime, type ExecutionEnvironmentSnapshot, type EnvironmentExecutionScope } from '@opencraft/execution-environment';
import { CodexOrchestrationControl, OrchestrationControlError } from "./codex-orchestration-control.js";
import { ExecutionFaultWriter } from "./execution-fault-writer.js";
import { TokenUsageAttemptWriter } from "./token-usage-attempt-writer.js";
import { serializeHistoryReply, isHistoryResponseTooLargeError, AppServerRpcError, threadUnavailableReason } from "@opencraft/appserver-client";
import { historyLengthBucket, historyTurnCountBucket, NativeItemPaginationUnsupported, NativeItemReadScheduler, TranscriptReadCache, type HistoryReadContext, type ItemHydrationPath } from "@opencraft/native-history-node";
import { CodexNativeStorage } from "./codex-native-storage.js";
import type { AppServerThread } from "@opencraft/appserver-protocol";
import { InterruptedTurnRecovery, RecoveryNotSubmitted, ProviderTurnRetry, codexProviderFailure, pooledRetryAt, type ProviderRetry, type ProviderFailure, type RecoveryTurn } from "@opencraft/host-recovery";
import { TURN_RECOVERY_EXTENSION } from "@opencraft/appserver-protocol";
import { nodeObserver } from "@opencraft/observability-contract/node";
import { labelUsagePeople } from "./token-usage-people.js";
import { TokenUsageStateDatabase } from "./token-usage-state-database.js";
import { TokenUsageTelemetry } from "./token-usage-telemetry.js";
import { TokenUsageQueryService } from "./token-usage-query-service.js";
import { TokenUsageQueryError } from "./token-usage-query.js";
import { COLLABORATION_METHOD, CONVERSATION_TOOLS, THREAD_ORCHESTRATION_TOOLS, type ThreadOrchestrationSnapshot } from "@opencraft/appserver-protocol/collaboration";
import { ConversationSchedules, ScheduleFault, type ScheduleExecutionPort, type ScheduleExecutionEvent } from "./conversation-schedules.js";
import { CONVERSATION_SCHEDULES, CONVERSATION_SCHEDULES_EXTENSION, type ConversationScheduleRun } from "@opencraft/appserver-protocol";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { join } from "node:path";
import { OpenCraftHostQueue, type HostQueuedSubmission } from "./opencraft-host-queue.js";
import { dispatchQueuedStart, dispatchQueuedSteer, reconcileThreadQueue } from "@opencraft/thread-queue";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageSubmission } from "./token-usage-ledger.js";
import { CodexTokenUsageRuntime } from "./token-usage-runtime.js";
import { TokenUsageCollector } from "./token-usage-collector.js";
import { CodexThreadTitles } from "./codex-thread-titles.js";
import { ThreadCatalogPublisher } from "@opencraft/app-host-server/thread-catalog";
import { DurableThreadCatalog } from "./durable-thread-catalog.js";
import { ThreadIdentity, assertSubmissionIdentity, readThreadMessageIds } from "./thread-identity.js";
import { projectThreadMessageResult, projectThreadMessageNotification } from "./thread-message-projection.js";
import { OpenCraftMessageAttachments } from "./opencraft-message-attachments.js";
import { CodexThreadPins } from "./codex-thread-pins.js";
import { CodexCoreBridge } from "./codex-core-bridge.js";
import { CODEX_MAINTENANCE_READ, CODEX_MAINTENANCE_EXTENSION, CODEX_MAINTENANCE_CAPABILITY, codexAdmissionKey, codexAdmissionPaused, codexMaintenanceError, isCodexAdmission, type CodexMaintenanceSnapshot } from "./codex-maintenance.js";
import { CodexNativeCoreTransport } from "./codex-native-core-transport.js";
import { TasksService, TasksFault } from "@opencraft/plugin-tasks/server";
import { CODEX_NATIVE_SHARED_METHODS, discoverNativeCodexGoalCapability, projectSharedNativeCodexInitialize } from "./codex-native-surface.js";
import { projectThreadAttachmentNotification, projectThreadAttachmentResult } from "./thread-message-attachment-projection.js";
import { readHistoryResourceMetadata } from "./history-resource-metadata.js";

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
  AccountCredentialRefreshManager,
  CodexDeviceLoginService,
  CodexSubscriptionService,
  CodexResetCreditService,
  createCodexAccountPoolLaunch,
  createCodexMaintenanceClient,
  createManagedCodexRefresh,
  startCodexAccountPoolServer,
  acquireCodexWriter,
  type CodexMaintenanceClientFactory,
  accountCreditStatus,
} from "@opencraft/account-pool-host";

function nativeHistoryTooLarge(error: unknown): boolean {
  const value = error as { code?: number; data?: { code?: string } } | null;
  return isHistoryResponseTooLargeError(error) || value?.code === -32072 || value?.data?.code === "HISTORY_RESPONSE_TOO_LARGE";
}

type RpcRecord = Record<string, unknown>;

/** Private physical-request admission, not a resource lease or a wire credential.
 * context() rechecks the original request/connection and trusted ingress authority.
 * Missing admission does not classify execution as local. */
export interface CodexNativeRequestAdmission {
  readonly method: string;
  context(): TransportSubmissionContext;
}

interface PendingRequest {
  nativeAdmission?: CodexNativeRequestAdmission;
  finalizeWorkspaceReceipt?: (reply: { result?: unknown; error?: unknown }) => Promise<void>;
  workspaceFinalizing?: boolean;
  readonly modelCreator?: () => string | null;
  readonly gatewayViewer?: () => string | null;
  environmentCreationScope?: EnvironmentExecutionScope;
  readonly executionAuthorityAdmitted?: boolean;
  readonly historyTiming?: { readonly pairId: string; readonly started: number; nativeStarted?: number };
  usageAttemptId?: string;
  readonly metadataSender?: import("@opencraft/appserver-protocol").MessageSender | null;
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
  cancelled?: boolean;
}

const MAX_PENDING_SERVER_REQUESTS = 256;
const DEFAULT_HISTORY_READ_TIMEOUT_MS = 30_000;
const MAX_HISTORY_READ_TIMEOUT_MS = 120_000;

interface SessionMcpCreation {
  readonly configuration: RpcRecord;
  bindThread?(threadId: string): void;
  bind(threadId: string, inputId: string, executionId: string): void;
  cancel(): void;
}
class SessionMcpRecoveryPending extends Error {
  constructor() { super("The previous reply is recovering; input was not sent. Retry shortly."); }
}
type SessionMcpStage = "initial-preparation" | "resolve-tools" | "resolve-environment" | "read-thread"
  | "check-idle" | "capture-settings" | "preserve-permissions" | "unsubscribe" | "wait-for-unload"
  | "apply-tools" | "restore-settings" | "release-initial";
interface SessionMcpRpcFailureDiagnostic {
  readonly rpcMethod: string;
  readonly rpcElapsedMs: number;
  readonly nativeErrorHint: string;
}
// Only bounded, public error categories enter the server log. In particular,
// -32601 may describe an unsupported nested operation, not the outer method.
// Never copy native messages, data, stacks, request params or environment values.
function sessionMcpNativeErrorHint(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message === "list_turns is not supported yet") return "turn-history-unsupported";
  if (/^(?:method not found|unknown method|unsupported method)(?:: thread\/(?:read|resume|unsubscribe|settings\/update))?\.?$/iu.test(message)) return "method-not-found";
  if (/^No client handler for [a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*$/iu.test(message)) return "client-handler-missing";
  if (/experimental[^\n]*(?:not enabled|disabled|unsupported)/iu.test(message)) return "experimental-api-unavailable";
  return "redacted";
}
class SessionMcpPreparationFailure extends Error {
  readonly diagnosticId = randomUUID();
  constructor(readonly stage: SessionMcpStage, cause: unknown, readonly threadId: string,
    readonly inputId?: string, readonly nativeStatus?: string, readonly rpcFailure?: SessionMcpRpcFailureDiagnostic,
    readonly connectionGeneration?: number) {
    super(errorMessage(cause), { cause });
  }
}
// Only controlled local messages become public reasons. Native error messages can
// contain credentials, environment values or paths and never cross this boundary.
function sessionMcpReason(cause: unknown): string {
  if (cause instanceof SessionMcpRecoveryPending) return "reconfiguration-pending";
  const message = cause instanceof Error ? cause.message : "";
  switch (message) {
    case "Wait until the Codex thread is idle before changing its tools": return "thread-busy";
    case "Codex AppServer closed": return "connection-closed";
    case "Codex AppServer is not initialized": return "connection-not-ready";
    case "Thread creation belongs to an expired connection":
    case "Session tool preparation belongs to an expired connection": return "connection-expired";
    case "Environment belongs to another account or project; start a new session": return "environment-owner-mismatch";
    case "Environment variables require a Codex owner handoff": return "environment-handoff-required";
    case "Session tools require an attested execution": return "execution-unattested";
    case "Cannot preserve this Codex sandbox while refreshing tools": return "sandbox-unsupported";
    default:
      if (typeof record(cause).code === "number") {
        if (/(?:permission denied|\bEACCES\b|os error 13)/i.test(message)) return "workspace-access-denied";
        if (/exec-server[^\n]*(?:no such file or directory|\bENOENT\b)/i.test(message)) return "execution-start-unavailable";
      }
      if (/^Codex thread\/(?:read|resume|unsubscribe|settings\/update) delivery outcome is unknown after timeout$/.test(message)) return "preparation-timeout";
      return typeof record(cause).code === "number" ? "native-rpc-failed" : "preparation-failed";
  }
}
function sessionMcpRetryable(cause: unknown): boolean {
  return ["thread-busy", "connection-closed", "connection-not-ready", "connection-expired",
    "preparation-timeout", "reconfiguration-pending"].includes(sessionMcpReason(cause));
}
interface SharedCodexRoutingOptions {
  readonly artifactDirectory?: string;
  readonly readGeneratedFile?: GeneratedFileReader;
  readonly readWorkspaceArtifact?: (threadId: string, path: string, context: TransportSubmissionContext, signal?: AbortSignal) => ReturnType<GeneratedFileReader>;
  /**
   * Extra directories whose files a tool may deliver by `savedPath`. The engine's own
   * home is always included; tool output naming any other path is rejected.
   */
  readonly generatedFileRoots?: readonly string[];
  readonly prepareArtifact?: (artifact: Artifact, owner: string, signal?: AbortSignal) => Promise<Artifact>;
  /** Trusted submission/physical-turn lifecycle; independent of tool domains. */
  readonly executionAuthority?: {
    admit(context: NonNullable<TransportSubmissionContext['actorContext']>, threadId: string, inputId: string): void;
    started(threadId: string, inputId: string, turnId: string): void;
    ended(threadId: string, turnId: string): void;
    rejected(threadId: string, inputId: string): void;
    invalidate(): void;
  };
  /** Trusted Host dispatcher. Null leaves a tool with its existing renderer
   * handler. Domain authorization and effect receipts belong to the dispatcher. */
  readonly nativeTool?: (context: { threadId: string; turnId: string; callId: string },
    tool: { namespace?: string | null; name: string }, args: unknown, signal: AbortSignal) => Promise<unknown> | null;
  readonly executionEnvironment?: ExecutionEnvironmentRuntime;
  /** Compiled composition owns the sole vault; the adapter attests its actual native owner. */
  readonly createExecutionGit?: (native: {
    inspect(value: GitExecutionHandoff): Promise<boolean>;
    inspectReservation(value: GitExecutionReservation): Promise<boolean>;
  }) => Pick<HumanGitExecutionPort, 'reserve' | 'prepare' | 'close'>;
  /** Trusted composition delegates input control, never executor credentials. */
  readonly sharedTurnInput?: boolean;
  /** Trusted Host composition. Never accepted from renderer requests. */
  readonly sessionMcp?: (threadId: string, inputId?: string, executionId?: string) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  readonly createSessionMcp?: () => SessionMcpCreation | Promise<SessionMcpCreation>;
  readonly restoreSessionMcp?: (threadId: string) => SessionMcpCreation | null | Promise<SessionMcpCreation | null>;
  readonly observationComponent?: 'core' | 'gateway';
  /** Current identity lookup for model admission, independent of statistics
   * collection. Legacy hosts may reuse their tokenUsage identity lookup. */
  readonly modelActor?: (context: NonNullable<TransportSubmissionContext['actorContext']>) => {id:string;kind:'human'|'session'} | null;
  readonly tokenUsage?: {
    readonly queryWorkerEntry?: string;
    readonly serverId: string;
    readonly actor: (context: NonNullable<TransportSubmissionContext["actorContext"]>) => {id:string;kind:"human"|"session"} | null;
    readonly submission?: (threadId:string,inputId:string) => UsageSubmission | null;
    readonly person?: (actorId:string) => {kind:string;displayName:string} | null;
    /** Shared deployment owner; its lifetime belongs to Headless, not a transport. */
    readonly derivedQueries?: TokenUsageQueryService;
  };
  /** Headless observes gateway model grants in its Server owner Worker. */
  readonly filterGatewayModelCatalog?: (path: string, actorId: string | null, models: unknown[]) => Promise<unknown[]>;
  readonly collaboration?: {
    readonly capabilities?: CollaborationCapabilities;
    modelExecutionAuthority?(threadId:string,inputId:string):{authorizer:string;executor:string|null;expiresAt:number;authorityId?:string;parentAuthorityId?:string};
    topology?(threadId: string): {parentThreadId:string|null;visibility:"visible"|"hidden"} | null;
    queuedContext?(threadId: string, inputId: string, input: readonly unknown[]): Promise<unknown>;
    workspaceTurnContext?(threadId: string, turnId: string): Promise<TransportSubmissionContext>;
    restoreWorkspaceSubmission?(threadId: string, inputId: string, submission: ExecutionSubmission | undefined): Promise<TransportSubmissionContext>;
    continued?(threadId: string, fromTurnId: string, turnId: string): void;
    continuing?(threadId:string,fromTurnId:string,inputId:string):void;
    inputDelegation?(threadId:string,inputId:string,expectedTurnId?:string):string|null;
    prepare?(context: NonNullable<TransportSubmissionContext["actorContext"]>, input: readonly unknown[]): Promise<unknown>;
    canCancel?(context: NonNullable<TransportSubmissionContext["actorContext"]>, requestId: string): boolean;
    command(context: NonNullable<TransportSubmissionContext["actorContext"]>, body: Record<string, unknown>, submission?: TransportSubmissionContext): Promise<unknown>;
    authorize(context: NonNullable<TransportSubmissionContext["actorContext"]>, threadId: string, inputId: string, input?: readonly unknown[]): void;
    orchestration?: { available?():boolean; tool(threadId:string,turnId:string,key:string,name:string,args:Record<string,unknown>,delegationId?:string,callbackIncarnation?:string):Promise<unknown>; observed(snapshot:ThreadOrchestrationSnapshot):void };
    started(threadId: string, inputId: string, turnId: string): void;
    tool(threadId: string, turnId: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  };
  readonly onStorageOpened?: (outcomes: readonly { name: string; outcome: DatabaseOutcome }[]) => void;
  /** Trusted deployment hook: durably bind a positive Native creation before any
   * subscription or success publication. Observe the receipt even if admission
   * expired during Native I/O; the owner persists it, then rechecks authorization.
   * Negative receipts also pass through this hook so the owner can finish cleanup.
   * Must not await the public RPC reply (which this hook deliberately holds). */
  readonly finalizeNativeCreation?: (input: { context: TransportSubmissionContext;
    requestId: string | number; params: Readonly<Record<string, unknown>>; result?: unknown; error?: unknown }) => Promise<void>;
  /** Same private receipt barrier for restored workspaces; never mark a restored
   * binding live merely because its compute instance has started. */
  readonly finalizeNativeResume?: SharedCodexRoutingOptions['finalizeNativeCreation'];
  /** Trusted host-wide journal classification; only owned sandbox resumes bypass
   * provisional reply caching. Normal local empty conversations stay unchanged. */
  readonly prepareWorkspaceArtifact?: (artifact: Artifact, threadId: string, context?: TransportSubmissionContext, signal?: AbortSignal) => Promise<Artifact | null>;
  readonly requiresWorkspaceResume?: (threadId:string)=>boolean;
  /** A live, positively empty Native thread needs no Native resume (stock Native
   * cannot list its turns yet). Restore compute before returning its creation
   * evidence; confirm rechecks the real live Native thread and request epoch. */
  readonly restoreProvisionalWorkspace?: (input: { threadId: string;
    context: TransportSubmissionContext; confirm(): Promise<unknown> }) => Promise<void>;
  readonly createThreadMetadata?: (database: import("node:sqlite").DatabaseSync, context: import("@opencraft/appserver-client").ThreadMetadataContext) => import("@opencraft/appserver-client").ThreadMetadataExtension;
  readonly logDiagnostic?: (event: Record<string, unknown>) => void;
  /** Trusted Host hook for slow history-read resources; defaults to process metadata. */
  readonly historyResourceMetadata?: () => Promise<Awaited<ReturnType<typeof readHistoryResourceMetadata>>>;
  readonly nativeSubscriptionGraceMs?: number;
  /** Trusted core authority for reserved collaboration inputs; absent means reject. */
  readonly collaborationInput?: {
    readonly available: () => boolean;
    mode(clientUserMessageId: string): 'queue' | 'steer' | null;
    authorize(threadId: string, clientUserMessageId: string, mode: 'queue' | 'steer', expectedTurnId?: string): boolean;
  };
}

interface LocalCodexEngineOptions extends SharedCodexRoutingOptions {
  readonly desktop?: LocalDesktopService;
  readonly kind?: "local";
  /** Explicit opt-in to the independently owned native core; never falls back to stdio. */
  readonly coreEndpoint?: string;
  readonly coreAuthToken?: string;
  /** Headless owns downstream overlays while the independent core owns only native/accounts. */
  readonly coreHostOverlays?: boolean;
  /** Trusted in-process native transport decoration; never supplied by an RPC. */
  readonly decorateNativeTransport?: (transport: DuplexTransport,
    admission: (requestId: string | number) => CodexNativeRequestAdmission | null) => DuplexTransport;
  /** Opt in before migrating a legacy embedded writer to independently owned core storage. */
  readonly writerOwnership?: boolean;
  /** Tasks belong to a Host services front; this Host opens no tasks store. */
  readonly externalTasks?: boolean;
  readonly executable: string;
  /** Builtin (bundled, pinned), user-installed, explicit or unresolved; diagnostics only. */
  readonly executableSource?: "explicit" | "builtin" | "user-installed" | "unresolved";
  readonly runtimeDirectory: string;
  readonly modelPolicyPath?: string;
  readonly dataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly upstreamBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly createMaintenanceClient?: CodexMaintenanceClientFactory;
  readonly spawnAppServer?: (input: { readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  /** Read-only history requests are independently cancellable from execution. */
  readonly historyReadTimeoutMs?: number;
  /** Candidate rollout only; requires verified artifact delivery. Off until the Host opts in. */
  readonly historyImageResources?: boolean;
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

class OpenCraftQueueRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}

function withCodexHostCapabilities(value: unknown, attachmentStaging: AttachmentStagingCapability, desktop?: HostDesktopCapability, collaboration?: CollaborationCapabilities): RpcRecord {
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
        ...(collaboration ? {"opencraft/collaboration": collaboration} : {}),
        [OPENCRAFT_THREAD_PINS_EXTENSION]: OPENCRAFT_THREAD_PINS_CAPABILITY,
        [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: attachmentStaging,
        ...(desktop ? { [OPENCRAFT_DESKTOP_EXTENSION]: desktop } : {}),
        [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]:
          OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
        [OPENCRAFT_THREAD_LIFECYCLE_EXTENSION]: {
          version: 1,
          fork: true,
          ephemeral: true,
          injectItems: false,
          sideChatSettings: true,
          rename: true,
          archive: true,
          unsubscribe: true,
        } satisfies OpenCraftThreadLifecycleCapability,
        [OPENCRAFT_THREAD_QUEUE_EXTENSION]: {
          version: 2,
          reorder: true,
          atomicSteer: true,
          unconfirmedSteerDiscard: true,
          unconfirmedDeliveryRetry: true,
          perItemPause: false,
        } satisfies OpenCraftThreadQueueCapability,
        [OPENCRAFT_THREAD_GOAL_EXTENSION]: { version: 1, read: true, write: true },
        "opencraft/capacity-retry": { version: 1 },
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
  private readonly historyWatchers = new Map<string, Set<string>>();
  /** The one native stdio connection is not one subscription per logical Client. */
  private readonly nativeSubscribedThreads = new Set<string>();
  private readonly nativeUnloadDiagnosticOwner = randomUUID();
  private readonly ephemeralThreads = new Set<string>();
  private readonly nativeReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nativeReleases = new Map<string, Promise<void>>();
  private readonly threadInteractionOwners = new Map<string, string>();
  private readonly collaborationCalls = new Map<string, symbol>();
  private readonly nativeToolCalls = new Map<string, { threadId: string; turnId: string; abort: AbortController }>();
  private readonly serverRequests = new Map<string, PendingServerRequest>();
  private readonly humanInteractions = new HostInteractions();
  private readonly sharedInteractionClients = new Set<string>();
  private readonly removeHumanInteractionListener = this.humanInteractions.subscribe(threadId => {
    for (const clientId of this.threadTargets(threadId)) this.publishHumanInteractions(threadId, clientId);
  });
  private publishHumanInteractions(threadId: string, clientId: string): void {
    if (!this.initializedClients.has(clientId) || !this.sharedInteractionClients.has(clientId)) return;
    this.emit({ method: SHARED_INTERACTIONS_CHANGED, params: this.humanInteractions.snapshot(threadId,
      this.threadClients.get(threadId)?.has(clientId) === true || this.historyWatchers.get(threadId)?.has(clientId) === true) }, clientId);
  }

  private readonly internalRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; threadId: string; method: string; params: RpcRecord; usageAttemptId?:string; recoveryAdmission?: boolean; environmentCreationScope?: EnvironmentExecutionScope; nativeAdmission?: CodexNativeRequestAdmission; finalizeWorkspaceReceipt?: PendingRequest["finalizeWorkspaceReceipt"]; workspaceFinalizing?: boolean }>();
  private readonly threadOperations = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly activeGoalThreads = new Set<string>();
  private readonly goalContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private providerRetry: ProviderTurnRetry | null = null;
  private recovery: InterruptedTurnRecovery | null = null;
  private coreReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coreReinitializing = false;
  private generationFenceEpoch = 0;
  private generationRoutingEpoch = "";
  private generationDefaultId: string | null = null;
  private generationLegacyId: string | null = null;
  private readonly generationFencedIds = new Set<string>();
  private readonly executionFaults = new Map<string, {id: string; incarnation: number; state: "recovering" | "recovered"; threadIds?: readonly string[]}>();
  private readonly executionFaultNotifications = new Set<string>();
  private executionFaultWriter: ExecutionFaultWriter | null = null;
  private readonly executionFaultCommits = new Map<string, {generationId: string; operation: Promise<void>}>();
  private readonly executionFaultCommitFailures = new Map<string, string>();
  private readonly executionFaultRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queueableThreads = new Set<string>();
  private readonly generationRoutes = new Map<string, string>();
  private generationGoalScan = 0;
  private generationDiscoveryComplete = false;
  private readonly generationReconciling = new Map<string, ReturnType<typeof setTimeout> | null>();
  private readonly generationLosses = new Set<string>();
  private readonly generationIncarnations = new Map<string, number>();
  private generationUsageTimer: ReturnType<typeof setInterval> | undefined;
  private queue: OpenCraftHostQueue | null = null;
  private schedules: ConversationSchedules | null = null;
  private hostState: OpenCraftHostStateDatabase | null = null;
  private provisionalThreads: ProvisionalThreads | null = null;
  private get executionLeases(): ExecutionLeaseStore | null { return this.hostState ? new ExecutionLeaseStore(this.hostState.database) : null; }
  private async reconcileExecutionLeases(): Promise<void> {
    const store = this.executionLeases;
    for (const threadId of store?.unsettledThreads() ?? []) {
      try {
        const targets = store!.unsettledTargets(threadId);
        const turnIds = new Set(targets.flatMap(target => target.turnId ? [target.turnId] : []));
        const inputIds = new Set(targets.filter(target => !target.turnId).map(target => target.inputId));
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < 1000 && (turnIds.size || inputIds.size); page++) {
          // A known Turn needs only its native status. An unknown admission
          // needs original input IDs from summaries, never the full transcript.
          const result = record(await this.requestPhysical("thread/turns/list", {
            threadId, cursor, limit: inputIds.size ? 10 : 100,
            itemsView: inputIds.size ? "summary" : "notLoaded", sortDirection: "desc",
          }));
          if (!Array.isArray(result.data)) throw new Error("Invalid execution reconciliation page");
          const matched: { id: string; status: string; items: readonly unknown[] }[] = [];
          for (const value of result.data) {
            const turn = record(value), id = string(turn.id), status = string(turn.status);
            if (!id || !status) throw new Error("Invalid execution reconciliation Turn");
            const items = Array.isArray(turn.items) ? turn.items : [];
            const inputs = originalExecutionInputIds({ items });
            if (!turnIds.has(id) && !inputs.some(input => inputIds.has(input))) continue;
            matched.push({ id, status, items });
            turnIds.delete(id);
            for (const input of inputs) inputIds.delete(input);
          }
          const generation = this.generationRoutes.get(threadId), incarnation = generation ? this.generationIncarnations.get(generation) : undefined;
          store!.reconcile(threadId, matched,
            generation && incarnation !== undefined ? JSON.stringify([generation, incarnation]) : this.nativeCore?.executionIncarnation);
          // Reattach a read-only broker to an existing native execution after
          // Gateway replacement. Do not resume/reconfigure/restart the Turn or
          // transfer credentials to a newer sender. Retained sealed evidence can
          // discover this replica through its canonical authority directory.
          for (const turn of matched) if (turn.status === 'inProgress' && this.executionGit) {
            try { await this.executionGit.prepare({hostId: 'local-codex', threadId, turnId: turn.id}); }
            catch { this.diagnostic({event: 'git-execution-reattachment-pending'}); }
          }
          if (result.nextCursor == null || (!turnIds.size && !inputIds.size)) break;
          if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new Error("Invalid execution reconciliation cursor");
          cursor = result.nextCursor; seen.add(cursor);
        }
      } catch { this.diagnostic({ event: "execution-lease-reconciliation-pending" }); }
    }
  }
  private observeExecutionReply(method: string, params: RpcRecord, message: RpcRecord, incarnation?: string): void {
    if (method !== "turn/start") return; // steer records its author, never replaces a Turn lease.
    const threadId = string(params.threadId), inputId = string(params.clientUserMessageId);
    if ("result" in message) {
      const turnId = string(record(record(message.result).turn).id);
      if (turnId) this.executionLeases?.started(threadId, turnId, inputId, incarnation);
      else this.executionLeases?.outcome(threadId, inputId, false);
    } else this.executionLeases?.outcome(threadId, inputId, [-32600,-32601,-32602].includes(Number(record(message.error).code)));
  }
  private tokenUsageState: TokenUsageStateDatabase | null = null;
  private tokenUsageAttemptWriter: TokenUsageAttemptWriter | null = null;
  private tokenUsageClosing: Promise<void> | null = null;
  private tokenUsageStorageUnavailable = false;
  private tokenUsage: CodexTokenUsageRuntime | TokenUsageCollector | null = null;
  private tokenUsageQueries: TokenUsageQueryService | null = null;
  private identity: ThreadIdentity | null = null;
  private get messageSenders() { return this.identity?.senders ?? null; }
  private get threadMetadata() { return this.identity?.metadata ?? null; }
  private readonly catalogChanges = new ThreadCatalogPublisher((method, params) => {
    const change = params.change;
    const topology = change.type === "upsert" ? this.options.collaboration?.topology?.(change.thread.id) : null;
    const metadata = topology && change.type === "upsert"
      ? { ...params, change: { ...change, thread: { ...change.thread, ...topology } } } : params;
    for (const clientId of this.initializedClients) this.emit({ method, params: metadata }, clientId);
  }, true, () => this.provisionalThreads?.catalog, () => this.diagnostic({ event: "thread-catalog-observation-failed" }));
  private durableCatalog: DurableThreadCatalog | null = null;
  private metadataRequests = 0;
  private messageAttachments: OpenCraftMessageAttachments | null = null;
  private statusValue: TransportStatus = { state: "idle" };
  private sequence = 0;
  private clientSequence = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private initializeResult: unknown | null = null;
  private threadPins: CodexThreadPins | null = null;
  private readonly tasks: TasksService | null;
  private readonly coreBridge: CodexCoreBridge | null;
  private readonly nativeCore: CodexNativeCoreTransport | null;
  private executionGit: Pick<HumanGitExecutionPort, 'reserve' | 'prepare' | 'close'> | undefined;
  /** Fresh native identity, never last sender, a cached environment or a browser PID. */
  private async gitNativeIncarnation(threadId: string): Promise<string | undefined> {
    if (this.closeOperation || !this.physicalAvailable || !this.physicalInitialized || this.executionBlocked(threadId)) return undefined;
    if (this.nativeCore) {
      const signal = AbortSignal.timeout(1500);
      const health = await this.nativeCore.control.health(signal, 'native');
      if (health.routingEpoch) {
        const directory = await this.nativeCore.control.generationDirectory(threadId, signal);
        const route = directory?.route;
        const home = route && directory?.homes.find(home => home.generationId === route.generationId);
        if (directory?.routingEpoch !== health.routingEpoch || !home || home.incarnation < 1) return undefined;
        return JSON.stringify([home.generationId, home.incarnation]);
      }
      return (await observeStandaloneCodexExecution(health)).incarnation;
    }
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return undefined;
    const value = (await observeNativeExecutionProcess(child.pid)).incarnation;
    return this.child === child && child.exitCode === null && child.signalCode === null ? value : undefined;
  }
  private async inspectGitNative(value: GitExecutionHandoff | GitExecutionReservation): Promise<boolean> {
    try {
      const threadId = value.scope.threadId, incarnation = await this.gitNativeIncarnation(threadId);
      if (!incarnation || incarnation !== value.native.incarnation) return false;
      if ('turnId' in value.native) {
        const page = record(await this.requestPhysical('thread/turns/list', {
          threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
        }, 1500));
        const turn = record(Array.isArray(page.data) && page.data.length === 1 ? page.data[0] : null);
        if (turn.id !== value.native.turnId || turn.status !== 'inProgress') return false;
        const state = record(record(await this.requestPhysical('thread/read', {threadId, includeTurns: false}, 1500)).thread);
        if (record(state.status).type !== 'active') return false;
      }
      return !this.closeOperation && await this.gitNativeIncarnation(threadId) === incarnation;
    } catch { return false; }
  }
  private async beginExecution(threadId: string, inputId: string): Promise<string | undefined> {
    const incarnation = this.executionGit ? await this.gitNativeIncarnation(threadId) : this.nativeCore?.executionIncarnation;
    if (this.executionGit && !incarnation) throw new Error('git_execution_unavailable');
    return this.executionLeases?.begin(threadId, inputId, incarnation);
  }
  private transcriptCache: TranscriptReadCache | null = null;
  private readonly historyItemReadScheduler = new NativeItemReadScheduler(4);
  private readonly historyAdapterFallbackSignals = new WeakSet<AbortSignal>();
  private readonly historyUnsupportedItemSignals = new WeakSet<AbortSignal>();
  private readonly historyReadTraces = new WeakMap<AbortSignal, { pairId: string; nativeRpcMs: number; nativeRpcCount: number; itemHydrationPath: string; turnCountBucket: string; lengthBucket: string; itemQueueMs?: number }>();
  private readonly historyTurnCounts = new WeakMap<AbortSignal, number>();
  private cachedHistoryInFlight = 0;
  private readonly cachedHistoryReads = new Map<string, Map<AbortController, string>>();
  private readonly cachedHistoryFlights = new Map<string, { promise: Promise<RpcRecord>; controller: AbortController; readers: Set<object> }>();
  private cachedHistoryWaiters = 0;
  private readonly cachedHistoryCancellations = new Map<string, { threadId: string; cancel(): void }>();
  private readonly nativeTransport: DuplexTransport | null;
  private releaseOverlays: (() => void) | null = null;
  private releaseWriter: (() => void) | null = null;
  private physicalInitializePending = false;
  private physicalInitialized = false;
  private remoteGoalCapability: OpenCraftThreadGoalCapability | null = null;
  private poolStore: AccountPoolStore | null = null;
  private poolServer: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | null = null;
  private login: CodexDeviceLoginService | null = null;
  private refresh: AccountCredentialRefreshManager | null = null;
  private subscriptions: CodexSubscriptionService | null = null;
  private resetCreditService: CodexResetCreditService | null = null;
  private poolAuth: ReturnType<typeof createCodexAccountPoolLaunch>["auth"] | null = null;
  private stderrTail = "";
  private closeOperation: Promise<void> | null = null;
  private readonly desktopOwnerNamespace = randomUUID();
  private readonly remoteDisposers: Array<() => void> = [];
  private readonly threadTitles: CodexThreadTitles | null;

  constructor(private readonly options: LocalCodexEngineOptions | RemoteCodexEngineOptions) {
    if(options.requiresWorkspaceResume&&(options.kind==='remote'||!options.finalizeNativeResume||!options.decorateNativeTransport||!options.coreEndpoint))
      throw new Error('Workspace resume requires private Native transport and receipt finalizer');
    this.threadTitles = options.kind !== "remote" && options.coreEndpoint && !options.coreHostOverlays ? null : new CodexThreadTitles({
      request: async (method, params, signal) => {
        const inputId=method==="turn/start"?`internal-input:${randomUUID()}`:null;
        const identity:UsageSubmission|undefined=inputId?{threadId:string(params.threadId),inputId,mode:"start",actorId:null,actorKind:"session",sourceKind:"system",submittedAt:Date.now()}:undefined;
        const result=await this.requestPhysical(method,inputId?{...params,clientUserMessageId:inputId}:params,10_000,signal,identity);
        if(method==="thread/start")this.tokenUsage?.threadStarted(result);
        if(method==="thread/resume")this.tokenUsage?.threadLoaded(string(record(record(result).thread).id));
        if(method==="thread/unsubscribe"&&this.threadTitles?.owns(string(params.threadId)))this.tokenUsage?.releaseEphemeral(string(params.threadId));
        return result;
      },
      sponsor: (temporary, source) => {
        const path=configuredModelGatewayPath();if(!path)return;
        const store=new ModelGatewayStore(path);
        try{if(!store.execution(source)&&!store.sponsor(source))return;}finally{store.close();}
        bindModelGatewaySponsor(temporary,null,id => id === temporary ? source : null,path);
      },
      serialize: (threadId, work) => this.withThreadOperation(threadId, work),
      changed: (threadId, name) => {
        this.catalogChanges.observeNotification("thread/name/updated", { threadId, threadName: name });
        this.durableCatalog?.observe("thread/name/updated", { threadId, threadName: name });
        // Native name/set notifications are subscription-scoped; every admitted
        // catalog reader must invalidate even when this Thread has no open View.
        for (const clientId of this.initializedClients) this.emit({ method: "thread/name/updated", params: { threadId, threadName: name } }, clientId);
      },
      failed: () => this.diagnostic({ event: "thread-title-generation-failed" }),
    });
    if (options.kind !== "remote" && options.coreHostOverlays && !options.coreEndpoint) throw new Error("Host overlays require an explicit core endpoint");
    this.nativeCore = options.kind !== "remote" && options.coreEndpoint && options.coreHostOverlays
      ? new CodexNativeCoreTransport(options.coreEndpoint, options.coreAuthToken ?? "", createHash("sha256").update(options.dataDirectory).digest("hex")) : null;
    this.nativeTransport = this.nativeCore
      ? options.kind !== "remote" && options.decorateNativeTransport ? options.decorateNativeTransport(this.nativeCore, id => this.pending.get(String(id))?.nativeAdmission ?? this.internalRequests.get(String(id))?.nativeAdmission ?? null) : this.nativeCore : null;
    this.coreBridge = options.kind !== "remote" && options.coreEndpoint !== undefined && !options.coreHostOverlays
      ? new CodexCoreBridge(options.coreEndpoint, options.coreAuthToken ?? "", () => this.maintenanceSnapshot(),
        (method, params, clientId) => this.admissionRejected(method, params, clientId, "maintenance")) : null;
    if (this.coreBridge && options.createExecutionGit) throw new Error('Git execution requires native Host overlays');
    if (options.createExecutionGit) {
      if (options.executionEnvironment) throw new Error('Git execution cannot have two environment owners');
      this.executionGit = options.createExecutionGit({
        inspect: value => this.inspectGitNative(value),
        inspectReservation: value => this.inspectGitNative(value),
      });
    }
    if (this.coreBridge) {
      // A core client must not create local stores or a second queue/account writer.
      this.tasks = null;
      this.attachmentStaging = null;
      return;
    }
    // A Host services front may own tasks; then this Host opens no tasks store.
    this.tasks = options.kind !== "remote" && options.externalTasks ? null : new TasksService(options.kind === "remote" ? null : join(options.dataDirectory, "tasks.sqlite"), () => {
      for (const subscriber of this.initializedClients) this.emit({ method: "opencraft/tasks/changed", params: {} }, subscriber);
    });
    this.attachmentStaging = options.kind === "remote"
      ? options.attachments && options.attachmentHistoryDirectory
        ? new SshAttachmentStagingService({ ...options.attachments, artifactDirectory: options.artifactDirectory,
            isRetained: id => this.messageAttachments?.hasReference(id) === true,
            request: (method, params) => this.requestPhysical(method, params, 120_000) })
        : null
      : new LocalAttachmentStagingService(join(options.dataDirectory, "attachments"), options.artifactDirectory);
    if (this.nativeCore) {
      this.generationUsageTimer = setInterval(() => {
        if (this.physicalInitialized && !this.closeOperation) void this.nativeCore!.publishGenerationUsage(() => this.generationUsageSnapshot(), state => this.applyGenerationFences(state)).catch(() => {});
      }, 5_000);
      this.generationUsageTimer.unref();
    }
  }

  private readonly orchestrationControl = new CodexOrchestrationControl({
    supported: () => this.nativeCore?.supportsOrchestration === true,
    incarnation: () => this.nativeCore?.callbackIncarnation ?? null,
    routed: () => this.nativeCore?.supportsOrchestrationRouting === true,
    request: (method, params, admit) => this.requestPhysical(method, params, 30_000, undefined, undefined, admit),
    materialize: async threadId => {
      const creation = this.provisionalThreads?.get(threadId);
      if (creation) await this.materializeCreation(creation.result, {});
    },
    read: async (threadId, limit) => {
      if (!this.transcriptCache) throw new OrchestrationControlError(503, "Read-only conversation history is unavailable");
      const cached = await this.transcriptCache.read(threadId, limit);
      return { thread: { ...cached.thread, turns: [...cached.initialTurnsPage.data].reverse() } };
    },
    recovery: threadId => this.recovery?.snapshot(threadId) ?? null,
    pendingInput: threadId => {
      const rows = this.queue?.list(threadId) ?? [];
      if (rows.some(row => row.state === "unknown")) return "unknown";
      const head = rows.find(row => ["queued", "dispatching", "steering"].includes(row.state));
      // maintainQueue never admits a head paused for a human Resume, so nothing behind it moves either.
      if (head) return head.state === "queued" && ["session-tools-unavailable", "model-restricted"].includes(head.pausedReason ?? "") ? "paused" : "pending";
      const outcomes = this.queue?.inputOutcomes(threadId);
      return outcomes && outcomes.discarded > 0 && outcomes.delivered === 0 ? "abandoned" : false;
    },
  });

  private get physicalAvailable(): boolean {
    return this.options.kind === "remote" ? this.options.transport.status.state === "open"
      : this.nativeCore ? this.nativeTransport!.status.state === "open" : this.child !== null;
  }
  private get desktopService(): LocalDesktopService | undefined {
    return this.options.kind === "remote" ? undefined : this.options.desktop;
  }

  private historyDiagnostic(event: Record<string, unknown>): void {
    try { this.diagnostic(event); } catch { /* Read settlement is independent of diagnostics. */ }
  }

  private noteHistoryReadContext(signal: AbortSignal | undefined, context: HistoryReadContext): void {
    if (!signal) return;
    const trace = this.historyReadTraces.get(signal);
    if (trace) Object.assign(trace, context);
  }

  private diagnostic(event: Record<string, unknown>): void {
    const raw = { component: "codex-engine-adapter", at: new Date().toISOString(), ...event };
    const entry = (this.options.executionEnvironment?.redact(raw) ?? raw) as Record<string, unknown>;
    if (this.options.logDiagnostic) this.options.logDiagnostic(entry);
    else console.info("[codex-engine-diagnostic]", JSON.stringify(entry));
  }

  private get historyImageResourcesEnabled(): boolean {
    return this.options.kind !== "remote" && this.options.historyImageResources === true
      && this.attachmentStaging instanceof LocalAttachmentStagingService && !!this.options.prepareArtifact;
  }

  private readonly artifactLifetime = new AbortController();
  private readonly artifactOutputs = new Set<Promise<unknown>>();
  private readonly artifactReaders = new Map<AbortController,string>();
  private captureArtifactOutput(threadId: string, item: RpcRecord, turnId?: string) {
    const staging=this.attachmentStaging;
    if (!staging || !['imageGeneration','mcpToolCall','dynamicToolCall','functionCallOutput'].includes(string(item.type)) || this.artifactLifetime.signal.aborted) return;
    // Resource projections were already captured and delivered before publication.
    if (item.type === "imageGeneration" && item.result === null && item.imageDimensions && item.historyDetail) return;
    // Remote sessions read execution-side paths over SFTP; local sessions use the configured reader.
    const workspace = this.options.requiresWorkspaceResume?.(threadId) === true;
    const reader: GeneratedFileReader | undefined = workspace ? async (path, signal) => {
      if (!turnId || !this.options.collaboration?.workspaceTurnContext || !this.options.readWorkspaceArtifact)
        throw Error('Workspace output authority unavailable');
      const context = await this.options.collaboration.workspaceTurnContext(threadId, turnId);
      context.resourceOwner?.assertCurrent();
      return this.options.readWorkspaceArtifact(threadId, path, context, signal);
    } : staging instanceof SshAttachmentStagingService
      ? (path, signal) => staging.readRemoteFile(path, signal) : this.options.readGeneratedFile;
    const operation = Promise.resolve().then(()=>captureGeneratedOutputs(staging.catalog, staging instanceof SshAttachmentStagingService ? 'codex-generated-remote' : 'codex-generated', threadId, item,
      reader, this.artifactLifetime.signal, { savedPathRoots: workspace ? ["/workspace"] : [
        ...(string(record(this.initializeResult).codexHome) ? [string(record(this.initializeResult).codexHome)] : []),
        ...(this.options.generatedFileRoots ?? generatedFileRootsFromEnvironment()) ] }))
      .catch(() => this.diagnostic({event:'artifact-output-save-failed',threadId,itemId:string(item.id)}));
    this.artifactOutputs.add(operation);
    void operation.finally(()=>this.artifactOutputs.delete(operation)).catch(()=>{});
  }
  private async modelVisibleAttachmentInput(input: readonly unknown[], threadId: string, clientId?: string, context?: TransportSubmissionContext): Promise<{
    readonly input: unknown[];
    readonly attachments: AttachmentRef[];
  }> {
    const controller=new AbortController();
    if(clientId)this.artifactReaders.set(controller,clientId);
    const signal=AbortSignal.any([controller.signal,this.artifactLifetime.signal]);
    try {
    const prepared: unknown[] = [];
    const attachments: AttachmentRef[] = [];
    for (const item of input) {
      signal.throwIfAborted();
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
      let executionPath = ref.location.path;
      if (this.attachmentStaging instanceof LocalAttachmentStagingService) {
        const owner = JSON.stringify(['thread',threadId]);
        const artifact = await this.attachmentStaging.artifact(ref,owner,signal);
        const workspaceArtifact = await this.options.prepareWorkspaceArtifact?.(artifact,threadId,context,signal);
        const delivered = workspaceArtifact ?? (this.options.prepareArtifact
          ? await this.options.prepareArtifact(artifact,owner,signal)
          : await prepareLocalArtifact(artifact,this.attachmentStaging.catalog,owner,signal));
        executionPath = delivered.path;
      }
      if (!attachments.some(existing => existing.id === ref.id)) attachments.push(ref);
      // Codex persists a mention in UserMessage but does not place it in the
      // model-facing text. Keep the mention for the attachment UI and add a
      // text locator that Codex can actually pass to the model. An empty UI
      // placeholder lets the shared projector omit only this generated text.
      const text = `The user attached a file named ${JSON.stringify(ref.name)}. Its readable path on this Host is ${JSON.stringify(executionPath)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
      prepared.push({ type: "text", text, text_elements: [{
        byteRange: { start: 0, end: Buffer.byteLength(text, "utf8") }, placeholder: "opencraft:staged-file:v1",
      }] });
      prepared.push(item);
    }
    return { input: prepared, attachments };
    } finally {this.artifactReaders.delete(controller);}
  }

  get storageOutcomes(): readonly { name: string; outcome: DatabaseOutcome }[] {
    return [
      ...(this.hostState ? [{ name: "opencraft-host-state", outcome: this.hostState.outcome }] : []),
      ...(this.provisionalThreads ? [{ name: "thread-creation-lifecycle", outcome: this.provisionalThreads.outcome }] : []),
      ...(this.tokenUsageState ? [{ name: "token-usage", outcome: this.tokenUsageState.outcome }] : []),
      ...(this.schedules ? [{ name: "conversation-schedules", outcome: this.schedules.outcome }] : []),
      ...(this.recovery ? [{ name: "interrupted-turn-recovery", outcome: this.recovery.outcome }] : []),
      ...(this.providerRetry ? [{ name: "provider-turn-retry", outcome: this.providerRetry.outcome }] : []),
      ...(this.messageAttachments ? [{ name: "opencraft-message-attachments", outcome: this.messageAttachments.outcome }] : []),
      ...(this.tasks?.outcome ? [{ name: "tasks", outcome: this.tasks.outcome }] : []),
      ...(this.poolStore ? [{ name: "account-pool", outcome: this.poolStore.outcome }] : []),
    ];
  }
  private reportStorage(): void { this.options.onStorageOpened?.(this.storageOutcomes); }

  get status(): TransportStatus { return this.coreBridge?.status ?? (this.coreReinitializing && this.statusValue.state === "open" ? { state: "connecting" } : this.statusValue); }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.coreBridge) return this.coreBridge.connect(signal);
    if (this.statusValue.state === "open") return;
    if (signal?.aborted) throw signal.reason;
    this.publishStatus({ state: "connecting" });
    if (this.options.kind === "remote") {
      try {
      const transport = this.options.transport;
      if (this.attachmentStaging && this.options.attachmentHistoryDirectory) {
        await mkdir(this.options.attachmentHistoryDirectory, { recursive: true, mode: 0o700 });
        this.messageAttachments = new OpenCraftMessageAttachments(this.options.attachmentHistoryDirectory);
      }
      if (this.options.attachmentHistoryDirectory) {
        await mkdir(this.options.attachmentHistoryDirectory, { recursive: true, mode: 0o700 });
        this.hostState = new OpenCraftHostStateDatabase(this.options.attachmentHistoryDirectory);
        this.installThreadMetadata();
        this.installDurableCatalog();
      }
      this.remoteDisposers.push(transport.subscribeMessage(this.receivePhysicalLine), transport.subscribeStatus(status => {
        if (["closing", "closed"].includes(this.statusValue.state)) return;
        if (status.state === "failed" || status.state === "closed") this.rejectInternalRequests(new Error("Remote connection was interrupted"));
        this.publishStatus(status);
      }));
      this.reportStorage();
      try { await transport.connect(signal); this.publishStatus(transport.status); }
      catch (error) { this.publishStatus(transport.status); throw error; }
      return;
      } catch (error) { await this.close(); this.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
    }
    try {
    const dataRoot = this.options.dataDirectory;
    // Legacy Headless keeps its current opening path. A directory already claimed
    // by the core must nevertheless honor that owner's lock, even without opt-in.
    if (!this.nativeCore && (this.options.writerOwnership === true || existsSync(join(dataRoot, ".codex-writer.sqlite")))) {
      this.releaseWriter = await acquireCodexWriter(dataRoot);
    }
    // A separate kernel-held guard scopes only Host overlays. It never claims
    // the core's account/native writer or opens its account stores.
    if (this.nativeCore) this.releaseOverlays = await acquireCodexWriter(join(dataRoot, "host-overlays-owner"));
    const runtimeRoot = join(dataRoot, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    this.hostState = new OpenCraftHostStateDatabase(dataRoot);
    this.provisionalThreads = new ProvisionalThreads(dataRoot);
    this.executionLeases?.suspend();
    const adapter = this;
    const nativeStorage = new CodexNativeStorage(this.nativeCore?.control ?? null,
      () => string(record(adapter.initializeResult).codexHome) || runtimeRoot);
    const listTurnItems = async (threadId: string, turnId: string, signal?: AbortSignal, path: ItemHydrationPath = "adapter-oversize-fallback") => {
      const actualPath = signal && this.historyAdapterFallbackSignals.has(signal) ? "adapter-oversize-fallback" : path;
      this.noteHistoryReadContext(signal, { itemHydrationPath: actualPath });
      const items: import("@opencraft/appserver-protocol").AppServerThreadItem[] = [];
      let itemCursor: string | null = null, budget = 100;
      const seen = new Set<string>();
      do {
        let response: any;
        for (;;) {
          try { response = await this.requestPhysical("thread/items/list", { threadId, turnId,
            cursor: itemCursor, limit: budget, sortDirection: "asc" }, 30_000, signal); break; }
          catch (error) {
            if (budget === 1 || !nativeHistoryTooLarge(error)) throw error;
            budget = Math.max(1, Math.floor(budget / 2));
          }
        }
        if (!Array.isArray(response.data) || !(response.nextCursor === null || typeof response.nextCursor === "string"))
          throw new Error("Invalid native Item page");
        for (const entry of response.data) {
          const item = record(entry.item ?? entry);
          if (typeof item.id !== "string" || (typeof entry.turnId === "string" && entry.turnId !== turnId)) throw new Error("Invalid native Item");
          items.push(item as import("@opencraft/appserver-protocol").AppServerThreadItem);
        }
        itemCursor = response.nextCursor;
        if (itemCursor !== null && seen.has(itemCursor)) throw new Error("Repeated native Item cursor");
        if (itemCursor !== null) seen.add(itemCursor);
      } while (itemCursor !== null);
      return items;
    };
    const listTurns = async (threadId: string, cursor: string | null, limit: number, signal?: AbortSignal, sortDirection: "asc" | "desc" = "desc") => {
        const request = (itemsView: "full" | "notLoaded", pageLimit: number) => this.requestPhysical("thread/turns/list", {
          threadId, cursor, limit: pageLimit, itemsView, sortDirection,
        }, 30_000, signal) as Promise<{ data: import("@opencraft/appserver-protocol").AppServerTurn[]; nextCursor: string | null }>;
        let pageLimit = limit, page;
        for (;;) {
          try { page = await request("full", pageLimit); break; }
          catch (fullPageSizeError) {
            if (!nativeHistoryTooLarge(fullPageSizeError)) throw fullPageSizeError;
            let headers;
            try { headers = await request("notLoaded", pageLimit); }
            catch (headerError) {
              if (![-32601, -32602].includes(Number(record(headerError).code))) throw headerError;
              if (pageLimit === 1) throw fullPageSizeError;
              pageLimit = Math.max(1, Math.floor(pageLimit / 2));
              continue;
            }
            // Once Item pagination is known to be unavailable, the cache must
            // receive full Turns. Keep the original page-size error so its
            // bounded page reduction can find a full page that fits.
            if (signal && this.historyUnsupportedItemSignals.has(signal)) {
              if (pageLimit === 1) throw fullPageSizeError;
              pageLimit = Math.max(1, Math.floor(pageLimit / 2));
              continue;
            }
            page = { ...headers, data: headers.data.map(turn => turn.itemsView !== "notLoaded" && turn.items?.length
              ? turn : { ...turn, items: [], itemsView: "notLoaded" as const }) };
            if (signal) this.historyAdapterFallbackSignals.add(signal);
            break;
          }
        }
        if (signal) {
          const count = (this.historyTurnCounts.get(signal) ?? 0) + page.data.length;
          if (page.nextCursor === null) this.noteHistoryReadContext(signal, { turnCountBucket: historyTurnCountBucket(count) });
        }
        if (signal) this.historyTurnCounts.set(signal, (this.historyTurnCounts.get(signal) ?? 0) + page.data.length);
        return page;
      };
    this.transcriptCache = new TranscriptReadCache(dataRoot, {
      prepareImageResources: this.historyImageResourcesEnabled ? (threadId, turns, signal) =>
        prepareHistoryImages(this.attachmentStaging!.catalog, threadId, turns, this.options.prepareArtifact!, signal) : undefined,
      get nativeHome() { return string(record(adapter.initializeResult).codexHome) || runtimeRoot; },
      resolveSource: (threadId, path) => nativeStorage.resolve(threadId, path),
      listTurnItems: async (threadId, turnId, signal, path) => {
        try { return await listTurnItems(threadId, turnId, signal, path); }
        catch (error) {
          if ([-32601, -32602].includes(Number(record(error).code))) {
            if (signal) this.historyUnsupportedItemSignals.add(signal);
            throw new NativeItemPaginationUnsupported("Native Item pagination is unavailable", { cause: error });
          }
          throw error;
        }
      },
      listTurnHeaders: async (threadId, cursor, limit, signal) => {
        try {
          const page = await this.requestPhysical("thread/turns/list", {
            threadId, cursor, limit, itemsView: "notLoaded", sortDirection: "desc",
          }, 30_000, signal) as { data: import("@opencraft/appserver-protocol").AppServerTurn[]; nextCursor: string | null };
          return { ...page, data: page.data.map(turn => turn.itemsView !== "notLoaded" && turn.items?.length
            ? turn : { ...turn, items: [], itemsView: "notLoaded" as const }) };
        }
        catch (error) {
          // An older native reader can serve full pages without a header view.
          if (![-32601, -32602].includes(Number(record(error).code))) throw error;
          return listTurns(threadId, cursor, limit, signal);
        }
      },
      readThread: async (threadId, signal) => {
        const thread = record(record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }, 30_000, signal)).thread) as AppServerThread;
        let bytes = -1;
        try { if (typeof thread.path === "string") bytes = (await stat(thread.path)).size; } catch { /* Missing metadata stays unknown. */ }
        this.noteHistoryReadContext(signal, { lengthBucket: historyLengthBucket(bytes) });
        return thread;
      },
      listTurns,
    }, { itemReadScheduler: this.historyItemReadScheduler, measured: metric => this.diagnostic({ event: "thread-read-cache", ...metric }) });
    try {
      const telemetry=new TokenUsageTelemetry();
      this.tokenUsageState = new TokenUsageStateDatabase(dataRoot, this.hostState.path);
      const usageEntry=this.options.tokenUsage?.queryWorkerEntry;
      // Collection reads native rollouts and writes the ledger for every turn.
      // With a worker entry it runs off the Host thread; the in-process
      // runtime remains for entries without a bundled worker (tests/dev).
      if(usageEntry){
        const derived=this.options.tokenUsage?.derivedQueries;
        this.tokenUsage=await TokenUsageCollector.start({entry:usageEntry,directory:dataRoot,serverId:this.options.tokenUsage?.serverId??"local-codex",
          projectLegacy:derived?false:undefined,submission:!!this.options.tokenUsage?.submission,derived:!!derived,
          ...(this.nativeCore&&this.options.coreEndpoint?{coreEndpoint:this.options.coreEndpoint,coreAuthToken:this.options.coreAuthToken??""}:{})},{
          request:(method,params)=>this.requestPhysical(method,params,5000),
          submission:this.usageSubmissionByRecord(),
          diagnostic:category=>this.diagnostic({event:"token-usage-partial",category}),
          invalidate:derived?(threadId,path)=>derived.invalidate(threadId,path):undefined,
          failed:()=>{this.tokenUsage=null;this.diagnostic({event:"token-usage-unavailable",category:"collector-exit"});},
        });
      } else this.tokenUsage = new CodexTokenUsageRuntime(new OpenCraftTokenUsageLedger(this.tokenUsageState,this.options.tokenUsage?.serverId ?? "local-codex",Date.now,telemetry,{projectLegacy:this.options.tokenUsage?.derivedQueries?false:undefined}), {
        request:(method,params)=>this.requestPhysical(method,params,5000),
        source:(threadId,path)=>nativeStorage.resolve(threadId,path),
        submission:this.usageSubmissionByRecord(),
        diagnostic:category=>this.diagnostic({event:"token-usage-partial",category}),
        derived:this.options.tokenUsage?.derivedQueries,
      });
      if(this.options.tokenUsage?.derivedQueries)this.tokenUsageQueries=this.options.tokenUsage.derivedQueries;
      else if(this.options.tokenUsage?.queryWorkerEntry)this.tokenUsageQueries=new TokenUsageQueryService({entry:this.options.tokenUsage.queryWorkerEntry,databasePath:join(dataRoot,"token-usage.sqlite"),serverId:this.options.tokenUsage.serverId,telemetry});
    } catch {
      this.tokenUsageStorageUnavailable=true;
      if(!this.options.tokenUsage?.derivedQueries)this.tokenUsageQueries?.close();this.tokenUsageQueries=null;
      const usage=this.tokenUsage;this.tokenUsage=null;
      if(usage instanceof TokenUsageCollector)await usage.close().catch(()=>{});else usage?.close();
      this.tokenUsageState?.close();this.tokenUsageState=null;
      this.diagnostic({event:"token-usage-unavailable",category:"storage-open"});
    }
    const queue = new OpenCraftHostQueue(dataRoot, this.hostState.database);
    try {
      const migrated = this.nativeCore ? 0 : queue.migrateNativeQueue(runtimeRoot);
      if (migrated > 0) this.diagnostic({ event: "native-queue-migrated", count: migrated });
    } catch (error) {
      queue.close();
      this.hostState.close();
      this.hostState = null;
      throw error;
    }
    this.queue = queue;
    this.executionFaultWriter = new ExecutionFaultWriter(dataRoot);
    this.recovery = new InterruptedTurnRecovery(dataRoot, {
      serialize: (threadId, operation) => this.withThreadOperation(threadId, operation),
      inspect: turn => this.inspectInterruptedTurn(turn),
      continue: async (turn, current, admit) => {
        await this.prepareSessionMcp(turn.threadId);
        if (!current()) return null;
        const inputId = turn.inputId!;
        this.options.collaboration?.continuing?.(turn.threadId,turn.turnId,inputId);
        const identity: UsageSubmission = { threadId: turn.threadId, inputId, actorId: null, actorKind: "session", mode: "start", sourceKind: "system", submittedAt: Date.now() };
        this.tokenUsage?.submission(identity);
        const workspaceContext = await this.workspaceResumeContext(turn.threadId, undefined, turn.turnId);
        const response = record(await this.requestPhysical("turn/start", { threadId: turn.threadId, input: [], clientUserMessageId: inputId }, 30_000, undefined, identity, admit, workspaceContext));
        // Recovery is system work, never a continuation of a human's cost grant.
        return string(record(response.turn).id) || null;
      },
      changed: (threadId, recovery) => {
        const state = this.recovery?.snapshot(threadId);
        if (state && ["interrupted", "preparing", "dispatching", "exhausted", "unconfirmed"].includes(state.state)) this.options.collaboration?.orchestration?.observed({
          threadId, turnId: state.turnId, rootTurnId: state.rootTurnId, state: state.state === "exhausted" ? "exhausted" : state.state === "unconfirmed" ? "unconfirmed" : "recovering",
        });
        for (const clientId of this.initializedClients) this.emit({ method: "opencraft/turn-recovery/updated", params: { threadId, recovery } }, clientId);
      },
    });
    this.providerRetry = new ProviderTurnRetry(dataRoot, {
      serialize: (threadId, operation) => this.withThreadOperation(threadId, operation),
      inspect: turn => this.inspectProviderRetry(turn),
      continue: async (turn, current, admit) => {
        await this.prepareSessionMcp(turn.threadId);
        if (!current()) return null;
        const inputId = turn.inputId!;
        this.options.collaboration?.continuing?.(turn.threadId, turn.turnId, inputId);
        const identity: UsageSubmission = { threadId: turn.threadId, inputId, actorId: null, actorKind: "session", mode: "start", sourceKind: "system", submittedAt: Date.now() };
        this.tokenUsage?.submission(identity);
        const workspaceContext = await this.workspaceResumeContext(turn.threadId, undefined, turn.turnId);
        const result = record(await this.requestPhysical("turn/start", { threadId: turn.threadId, input: [], clientUserMessageId: inputId }, 30_000, undefined, identity, admit, workspaceContext));
        const turnId = string(record(result.turn).id);
        if (turnId) this.options.collaboration?.continued?.(turn.threadId, turn.turnId, turnId);
        return turnId || null;
      },
      changed: threadId => {
        const recovery = this.providerRetry?.notice(threadId) ?? null;
        if (recovery && ["scheduled", "exhausted", "unconfirmed"].includes(recovery.state)) this.options.collaboration?.orchestration?.observed({
          threadId, turnId: recovery.turnId, rootTurnId: recovery.rootTurnId,
          state: recovery.state === "scheduled" ? "recovering" : recovery.state === "exhausted" ? "exhausted" : "unconfirmed",
        });
        this.diagnostic({ event: "provider-retry-updated", threadId, state: recovery?.state ?? "cleared", attempts: recovery?.attempts, retryAt: recovery?.retryAt });
        for (const clientId of this.initializedClients) this.emit({ method: "opencraft/turn-recovery/updated", params: { threadId, recovery } }, clientId);
      },
    }, Date.now, Math.random, () => !this.closeOperation && this.physicalInitialized && this.physicalAvailable && !this.admissionPaused());
    this.schedules = new ConversationSchedules(dataRoot, this.scheduleExecutionPort(), Date.now, event => this.diagnostic(event), () => {
      for (const clientId of this.initializedClients) this.emit({ method: "opencraft/schedules/changed", params: {} }, clientId);
    });
    this.messageAttachments = new OpenCraftMessageAttachments(dataRoot);
    this.installThreadMetadata();
    if (this.nativeCore) {
      const transport = this.nativeTransport!;
      this.remoteDisposers.push(transport.subscribeMessage(this.receivePhysicalLine), transport.subscribeStatus(status => {
        if (["closing", "closed"].includes(this.statusValue.state)) return;
        if (status.state === "failed" || status.state === "closed") {
          this.physicalInitialized = false;
          this.recovery?.lost();
          this.rejectInternalRequests(new Error("Core connection was interrupted"));
          this.scheduleCoreReconnect();
        }
        // Transport open precedes native initialize. Clients must not consume
        // the old cached initialize response in this new native incarnation.
        if (status.state === "open" && this.coreReinitializing) { this.statusValue = status; return; }
        this.publishStatus(status);
      }));
      this.reportStorage(); await transport.connect(signal); this.publishStatus(transport.status);
      return;
    }
    const store = new AccountPoolStore({
      databasePath: join(dataRoot, "account-pool.sqlite"),
      secretsDirectory: join(dataRoot, "secrets"),
    });
    this.poolStore = store;
    this.reportStorage();
    const executable = this.options.executable;
    const createMaintenanceClient = this.options.createMaintenanceClient
      ?? (codexHome => createCodexMaintenanceClient({ executable, codexHome }));
    const managedRefresh = createManagedCodexRefresh({
      refreshRoot: join(dataRoot, "refresh"),
      createClient: createMaintenanceClient,
    });
    const refresh = new AccountCredentialRefreshManager({ store, refresh: managedRefresh });
    this.refresh = refresh;
    const subscriptions = new CodexSubscriptionService({
      store,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
      fetch: this.options.fetch,
    });
    this.subscriptions = subscriptions;
    this.resetCreditService = new CodexResetCreditService({ store, fetch: this.options.fetch,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
      refreshUsage: accountId => subscriptions.refreshAccount(accountId) });
    this.login = new CodexDeviceLoginService({
      store,
      loginRoot: join(dataRoot, "login"),
      createClient: createMaintenanceClient,
      onAccountImported: account => { void subscriptions.refreshAccount(account.id).catch(() => undefined); },
    });
    await this.login.ready();
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
    this.poolAuth = launch.auth;
    const childArgs = ["app-server", "--stdio", ...launch.args];
    const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...launch.env,
        CODEX_HOME: runtimeRoot,
        OPENAI_API_KEY: undefined,
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
    this.diagnostic({ event: "appserver-start", pid: child.pid ?? null,
      ...(this.options.executableSource ? { executableSource: this.options.executableSource } : {}) });
    child.stderr.on("data", chunk => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", this.receivePhysicalLine);
    child.once("error", this.fail);
    child.once("close", (code, childSignal) => {
      this.diagnostic({ event: "appserver-exit", pid: child.pid ?? null, code, signal: childSignal, intentional: ["closing", "closed"].includes(this.statusValue.state) });
      if (["closing", "closed"].includes(this.statusValue.state)) return;
      this.fail(new Error(`Codex AppServer exited (${code ?? childSignal ?? "unknown"})${this.stderrTail && !this.options.executionEnvironment ? `: ${this.stderrTail}` : ""}`));
    });
    const abort = () => { void this.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      await this.close();
      throw signal.reason;
    }
    this.publishStatus({ state: "open" });
    signal?.removeEventListener("abort", abort);
    } catch (error) {
      await this.close();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async send(frame: string): Promise<void> { return this.sendWithContext(frame, { sender: null }); }

  private readonly admissionsInFlight = new Map<number, string>();
  private readonly generationAdmissionsInFlight = new Map<number, string>();
  private maintenanceSequence = 0;
  private admissionPaused(): boolean { return this.options.kind !== "remote" && codexAdmissionPaused(this.options.dataDirectory); }
  private rejectedAdmissions = 0;
  private admissionRejected(method: string, params: unknown, clientId: string, reason: "maintenance" | "generation-fence"): void {
    const threadId = record(params).threadId;
    const entry = { event: "codex-admission-rejected", reason, method, clientId, pid: process.pid,
      threadId: typeof threadId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(threadId) ? threadId : null,
      rejectedAdmissions: ++this.rejectedAdmissions };
    // Diagnostic sink failures must never change the admission decision or response.
    try { this.diagnostic(entry); }
    catch { console.warn("[codex-admission-audit] diagnostic sink unavailable"); }
  }
  private maintenanceSnapshot(): CodexMaintenanceSnapshot {
    const queue = this.queue?.maintenanceCounts();
    const pending = [...this.pending.values()].filter(request => isCodexAdmission(request.method, request.params))
      .map(request => codexAdmissionKey(request.method, request.params, JSON.stringify([request.clientId, request.originalId])));
    const internal = [...this.internalRequests.entries()].filter(([, request]) => isCodexAdmission(request.method, request.params))
      .map(([id, request]) => codexAdmissionKey(request.method, request.params, id));
    return { paused: this.admissionPaused(), rejectedAdmissions: this.rejectedAdmissions,
      pendingAdmissions: new Set([...this.admissionsInFlight.values(), ...(this.coreBridge?.pendingAdmissionKeys ?? []),
        ...(queue?.inFlightKeys ?? []), ...pending, ...internal]).size,
      queued: queue?.queued ?? 0, unknown: queue?.unknown ?? 0, activeGoals: this.activeGoalThreads.size,
      pendingTitles: this.threadTitles?.pendingCount ?? 0, pendingApprovals: this.serverRequests.size + this.humanInteractions.size + (this.coreBridge?.pendingApprovals ?? 0),
      capacityRetries: this.providerRetry?.pendingThreadIds().length ?? 0 };
  }

  private applyGenerationFences(state: import("@opencraft/account-pool-host").CodexGenerationFenceState): void {
    if (!state || typeof state.routingEpoch !== "string" || !Number.isSafeInteger(state.fenceEpoch) || !Array.isArray(state.fencedGenerationIds)) return;
    if (this.generationRoutingEpoch !== state.routingEpoch) {
      if (this.generationRoutingEpoch) for (const call of this.nativeToolCalls.values()) call.abort.abort();
      this.generationRoutingEpoch = state.routingEpoch; this.generationFenceEpoch = 0; this.generationRoutes.clear(); this.generationIncarnations.clear(); this.generationLosses.clear();
    }
    if (state.fenceEpoch < this.generationFenceEpoch) return;
    this.generationFenceEpoch = state.fenceEpoch; this.generationFencedIds.clear();
    for (const id of state.fencedGenerationIds) this.generationFencedIds.add(id);
    this.generationDefaultId = state.defaultGenerationId; this.generationLegacyId = state.legacyGenerationId;
    for (const row of state.routes ?? []) this.generationRoutes.set(row.threadId, row.generationId);
    for (const fault of state.executionRecoveries ?? []) this.observeExecutionFault(fault);
  }
  private executionBlocked(threadId: string): boolean {
    const id = this.generationRoutes.get(threadId) ?? this.generationDefaultId;
    return !!id && (this.executionFaults.get(id)?.state === "recovering" || [...this.executionFaultCommitFailures.values()].includes(id)
      || [...this.executionFaultCommits.values()].some(commit => commit.generationId === id));
  }
  private observeExecutionFault(fault: {id: string; generationId: string; incarnation: number; state: "recovering" | "recovered"; threadIds?: readonly string[]}, threadIds: readonly string[] = []): void {
    if (typeof fault.id !== "string" || !fault.id || typeof fault.generationId !== "string" || !Number.isSafeInteger(fault.incarnation) || !["recovering", "recovered"].includes(fault.state)) return;
    if (fault.threadIds !== undefined && (!Array.isArray(fault.threadIds) || fault.threadIds.some(id => typeof id !== "string" || !id))) return;
    const prior = this.executionFaults.get(fault.generationId);
    if (prior && prior.incarnation > fault.incarnation) return;
    if (prior?.id === fault.id && prior.state === "recovered" && fault.state === "recovering") return;
    this.executionFaults.set(fault.generationId, fault);
    const candidates = new Set(fault.threadIds ?? (threadIds.length ? threadIds : [...this.generationRoutes].filter(([, id]) => id === fault.generationId).map(([id]) => id)));
    const threads = [...candidates].filter(threadId => {
      const key = JSON.stringify([fault.id, fault.state, threadId]);
      return !this.executionFaultNotifications.has(key) && !this.executionFaultCommits.has(key);
    });
    if (!threads.length || !this.executionFaultWriter || this.closeOperation) { this.publishExecutionStatus(); return; }
    const operation = this.executionFaultWriter.write({recoveryId: fault.id, threadIds: threads, recovered: fault.state === "recovered"})
      .then(changedThreadIds => {
        for (const threadId of threads) {
          this.executionFaultNotifications.add(JSON.stringify([fault.id, fault.state, threadId]));
          // A completed historical receipt must not interrupt a successor Turn
          // when a new Host observes the same controller snapshot.
          if (fault.state === "recovered" && !changedThreadIds.includes(threadId)) continue;
          const turnId = this.activeTurns.get(threadId);
          this.activeGoalThreads.delete(threadId);
          const timer = this.goalContinuationTimers.get(threadId); if (timer) clearTimeout(timer);
          this.goalContinuationTimers.delete(threadId);
          this.activeTurns.delete(threadId); this.nativeSubscribedThreads.delete(threadId);
          this.humanInteractions.markSourceUnavailable(threadId);
          if (turnId) for (const client of this.threadClients.get(threadId) ?? []) this.emit({method: "turn/completed", params: {
            threadId, turn: {id: turnId, status: "interrupted", items: [], error: null}}}, client);
          for (const client of this.initializedClients) this.emit({method: "opencraft/turn-recovery/updated", params: {threadId, recovery: null}}, client);
        }
        for (const threadId of threads) {
          this.executionFaultCommitFailures.delete(JSON.stringify([fault.id, fault.state, threadId]));
          if (fault.state === "recovered") this.executionFaultCommitFailures.delete(JSON.stringify([fault.id, "recovering", threadId]));
        }
        if (fault.state === "recovered" && this.executionFaults.get(fault.generationId)?.id === fault.id) {
          // A later completed fault also supersedes missed failure stages from
          // older incarnations; failures in this fault's other threads remain.
          for (const [key, generationId] of this.executionFaultCommitFailures) {
            if (generationId === fault.generationId && JSON.parse(key)[0] !== fault.id) this.executionFaultCommitFailures.delete(key);
          }
        }
        if (![...this.executionFaultCommitFailures.values()].includes(fault.generationId)) {
          clearTimeout(this.executionFaultRetries.get(fault.generationId)); this.executionFaultRetries.delete(fault.generationId);
        }
      }).catch(() => {
        for (const threadId of threads) this.executionFaultCommitFailures.set(JSON.stringify([fault.id, fault.state, threadId]), fault.generationId);
        if (!this.closeOperation && !this.executionFaultRetries.has(fault.generationId)) {
          const timer = setTimeout(() => {
            this.executionFaultRetries.delete(fault.generationId);
            const latest = this.executionFaults.get(fault.generationId);
            if (latest) this.observeExecutionFault({...latest, generationId: fault.generationId}, [...candidates]);
          }, 1_000);
          timer.unref(); this.executionFaultRetries.set(fault.generationId, timer);
        }
      }).finally(() => {
        for (const threadId of threads) {
          const key = JSON.stringify([fault.id, fault.state, threadId]);
          if (this.executionFaultCommits.get(key)?.operation === operation) this.executionFaultCommits.delete(key);
          this.emitQueueChanged(threadId);
          if (!this.executionBlocked(threadId) && !this.closeOperation) this.scheduleQueueMaintenance(threadId);
        }
        this.publishExecutionStatus();
      });
    for (const threadId of threads) this.executionFaultCommits.set(JSON.stringify([fault.id, fault.state, threadId]), {generationId: fault.generationId, operation});
    this.publishExecutionStatus();
  }
  private publishExecutionStatus(): void {
    if (!this.generationDefaultId || this.statusValue.state !== "open") return;
    const execution = this.executionBlocked("") ? "recovering" : "ready";
    const executionUnavailableThreadIds = [...this.generationRoutes.keys()].filter(id => this.executionBlocked(id)).sort();
    if (this.statusValue.execution !== execution || JSON.stringify(this.statusValue.executionUnavailableThreadIds) !== JSON.stringify(executionUnavailableThreadIds)) {
      this.publishStatus({...this.statusValue, execution, executionUnavailableThreadIds});
    }
  }

  private isGenerationAdmission(method: unknown, params: unknown): boolean {
    return isCodexAdmission(method, params) || method === CONVERSATION_SCHEDULES.save
      || (method === CONVERSATION_SCHEDULES.action && ["resume", "run-now"].includes(string(record(params).action)));
  }
  private generationAdmissionBlocked(params: unknown): boolean {
    if (!this.generationFencedIds.size) return false;
    const p = record(params), threadId = string(p.threadId);
    const generation = threadId ? this.generationRoutes.get(threadId) ?? this.generationLegacyId : this.generationDefaultId;
    return !generation || this.generationFencedIds.has(generation);
  }

  private generationUsageSnapshot(): { routingEpoch: string; blockedThreadIds: string[]; unscopedBusy: boolean; discoveryComplete: boolean; acknowledgedFenceEpoch: number } {
    const blocked = new Set<string>([...this.activeTurns.keys(), ...(this.queue?.pendingThreads() ?? []), ...this.activeGoalThreads, ...(this.providerRetry?.pendingThreadIds() ?? []), ...(this.recovery?.pendingThreadIds() ?? []), ...this.generationReconciling.keys(), ...(this.threadTitles?.pendingThreadIds() ?? []), ...this.generationAdmissionsInFlight.values()]);
    for (const schedule of this.schedules?.list().schedules ?? []) if (schedule.status === "active" || schedule.needsReview) blocked.add(schedule.threadId);
    let unscopedBusy = false;
    for (const request of [...this.pending.values(), ...this.internalRequests.values()]) {
      if (!isCodexAdmission(request.method, request.params)) continue;
      const threadId = string(request.params.threadId);
      if (threadId) blocked.add(threadId); else if (!["thread/start", "command/exec", "process/spawn"].includes(request.method)) unscopedBusy = true;
    }
    for (const request of this.serverRequests.values()) {
      if (request.threadId) blocked.add(request.threadId); else unscopedBusy = true;
    }
    for (const call of this.nativeToolCalls.values()) {
      if (call.threadId) blocked.add(call.threadId); else unscopedBusy = true;
    }
    for (const threadId of this.nativeSubscribedThreads) if (this.humanInteractions.hasThread(threadId)) blocked.add(threadId);
    return { routingEpoch: this.generationRoutingEpoch, acknowledgedFenceEpoch: this.generationFenceEpoch, blockedThreadIds: [...blocked], unscopedBusy, discoveryComplete: this.generationDiscoveryComplete && !this.coreReinitializing && this.physicalInitialized && this.statusValue.state === "open" };
  }

  async sendWithContext(frame: string, context: TransportSubmissionContext): Promise<void> {
    const bridgeRequest = record(JSON.parse(frame));
    if (bridgeRequest.method === 'thread/start' && record(bridgeRequest.params).agentBridge !== undefined) {
      this.emit({ id: bridgeRequest.id, error: { code: -32601, message: 'Codex provider bridge is not configured for this Host' } }, string(bridgeRequest[LOGICAL_CLIENT_FIELD]));
      return;
    }
    if (this.coreBridge) {
      if (context.sender !== null) throw new Error("Codex core mode does not support verified sender attribution");
      return this.coreBridge.send(frame);
    }
    if (this.statusValue.state !== "open" || !this.physicalAvailable || this.coreReinitializing) throw new Error("Codex Engine is not connected");
    const message = record(JSON.parse(frame));
    const admission = this.isGenerationAdmission(message.method, message.params) ? ++this.maintenanceSequence : null;
    if (admission !== null) this.admissionsInFlight.set(admission, codexAdmissionKey(String(message.method), message.params,
      JSON.stringify([message[LOGICAL_CLIENT_FIELD], message.id])));
    if (admission !== null && typeof record(message.params).threadId === "string") this.generationAdmissionsInFlight.set(admission, string(record(message.params).threadId));
    try { await this.sendClientMessage(message, context); }
    finally { if (admission !== null) { this.admissionsInFlight.delete(admission); this.generationAdmissionsInFlight.delete(admission); } }
  }

  private async sendClientMessage(message: RpcRecord, context: TransportSubmissionContext): Promise<void> {
    delete message[EXECUTION_ENVIRONMENT_FIELD]; delete record(message.params)[EXECUTION_ENVIRONMENT_FIELD];
    const params = record(message.params);
    // The durable collaboration ledger is the authority for this queue
    // admission. No creator credentials exist for the internal connection;
    // the Host verifies the request before accepting it, and dispatch later
    // restores the original execution provenance for turn/start.
    const collaborationQueueAdmission = message.method === 'thread/queue/add'
      && params.mode !== 'steer'
      && typeof context.collaborationRequestId === 'string'
      && params.clientUserMessageId === `actor-input:${context.collaborationRequestId}`;
    try {
      if (this.options.executionEnvironment && requiresEnvironmentAuthority(string(message.method)) && !collaborationQueueAdmission) {
        const scope = this.options.executionEnvironment.scope(context, 'local-codex', params);
        if (requiresCurrentEnvironmentAuthority(string(message.method), message.params)) this.assertCurrentEnvironmentOwner(scope);
        else if (['turn/steer', 'thread/queue/steer'].includes(string(message.method)) && !this.options.sharedTurnInput)
          this.assertCurrentEnvironmentOwner(scope);
      }
    } catch (cause) {
      if (responseId(message.id) === null) throw cause;
      const error = cause instanceof OpenCraftQueueRpcError ? { code: cause.code, message: cause.message, data: cause.data } : this.sessionMcpFailure(cause);
      if (isThreadGoalPauseRequest(message.method, message.params)) this.diagnostic({
        event: "goal-pause-admission-failed", threadId: string(record(message.params).threadId),
        requestId: String(message.id), rpcCode: error.code,
      });
      // Scope validation failed before any native command or queue admission.
      this.emit({ id: message.id, error: { ...error, data: { ...record(error.data),
        notSubmitted: true, submissionOutcome: "rejected", retryable: false } } }, string(message[LOGICAL_CLIENT_FIELD])); return;
    }
    // Shared input is fenced by native Turn identity, not a volatile ENV cache.
    // Run before queue insertion as well as after asynchronous preparation.
    if (this.options.sharedTurnInput && ['turn/steer', 'thread/queue/steer'].includes(string(message.method))) {
      try { await this.assertNativeTurnInputReady(string(record(message.params).threadId)); }
      catch (cause) {
        if (responseId(message.id) === null) throw cause;
        const error = cause as OpenCraftQueueRpcError;
        this.emit({ id: message.id, error: { code: error.code, message: error.message, data: error.data } }, string(message[LOGICAL_CLIENT_FIELD]));
        return;
      }
    }
    const receivedAt = performance.now();
    const clientId = string(message[LOGICAL_CLIENT_FIELD]);
    if (!clientId) throw new Error("Codex Engine requires a logical client identity");
    delete message[LOGICAL_CLIENT_FIELD];
    try { await this.checkModelPolicy(message.method, record(message.params)); }
    catch (cause) {
      const error=cause as Error & {code?:number;data?:unknown};
      this.emit({id:message.id,error:{code:error.code ?? -32043,message:error.message,data:error.data}},clientId);return;
    }

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
    if (id !== null && (message.method === SHARED_INTERACTIONS_READ || message.method === SHARED_INTERACTIONS_RESPOND)) {
      const p = record(message.params), threadId = string(p.threadId);
      const reader = this.threadClients.get(threadId)?.has(clientId) || this.historyWatchers.get(threadId)?.has(clientId);
      if (!this.initializedClients.has(clientId) || !reader) { this.emit({ id, error: { code: 403, message: "Conversation subscription required" } }, clientId); return; }
      // A read subscription does not start execution. Answering an existing
      // human wait is an explicit command under the instance's current access.
      const canRespond = reader === true;
      const epoch = this.clientEpoch(clientId);
      try {
        if (message.method === SHARED_INTERACTIONS_READ) {
          this.emit({ id, result: this.humanInteractions.snapshot(threadId, canRespond) }, clientId); return;
        }
        context.resourceOwner?.assertCurrent();
        if (!canRespond) throw new InteractionFault({ code: "READ_ONLY" }, "This subscription cannot answer interactions");
        if (!string(p.interactionId) || !string(p.submissionId) || !p.result || typeof p.result !== "object" || Array.isArray(p.result))
          throw new InteractionFault({ code: "INVALID_RESPONSE" }, "Invalid interaction response");
        const disposition = await this.humanInteractions.respond(threadId, string(p.interactionId), string(p.submissionId), record(p.result),
          async (source, result) => {
            if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== epoch || !(this.threadClients.get(threadId)?.has(clientId) || this.historyWatchers.get(threadId)?.has(clientId))) throw new Error("Interaction subscription expired");
            context.resourceOwner?.assertCurrent();
            await this.writePhysical({ id: source.id, result, __opencraftInteractionKey: source.__opencraftInteractionKey });
          });
        if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === epoch)
          this.emit({ id, result: { disposition, snapshot: this.humanInteractions.snapshot(threadId, true) } }, clientId);
      } catch (cause) {
        if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === epoch) this.emit({ id, error: { code: cause instanceof InteractionFault ? cause.rpcCode : -32000,
          message: cause instanceof Error ? cause.message : "Interaction submission failed" } }, clientId);
      }
      return;
    }
    if (id !== null && message.method === "thread/history/cancel") {
      const params = record(message.params), key = JSON.stringify([clientId, this.clientEpoch(clientId), params.historyReadId]);
      const reader = this.initializedClients.has(clientId) ? this.cachedHistoryCancellations.get(key) : undefined;
      const cancelled = !!reader && reader.threadId === params.threadId;
      if (cancelled) reader!.cancel();
      this.emit({ id, result: { cancelled } }, clientId);
      return;
    }
    const historyParams = record(message.params);
    const cachedRead = message.method === "thread/read" && historyParams.initialTurnsPage !== undefined;
    const cachedPage = message.method === "thread/turns/list" && (historyParams.sortDirection === undefined || historyParams.sortDirection === "desc" || historyParams.sortDirection === "asc")
      && (historyParams.itemsView === "full" || historyParams.itemsView === "notLoaded" || historyParams.itemsView === "presentation") && (historyParams.cursor == null || string(historyParams.cursor).startsWith("transcript:") || string(historyParams.cursor).startsWith("transcript-asc:"));
    if (id !== null && this.initializedClients.has(clientId)
      && (message.method === "thread/read" || message.method === "thread/resume")
      && (message.method !== 'thread/resume' || !this.options.requiresWorkspaceResume?.(string(historyParams.threadId))
        || !!this.options.restoreProvisionalWorkspace)
      && Object.keys(historyParams).every(key => ["threadId", "includeTurns", "excludeTurns", "watch", "initialTurnsPage", "historyReadId", "history", "path", "model", "modelProvider", "cwd"].includes(key))) {
      const epoch = this.clientEpoch(clientId), generation = this.sessionMcpGeneration, routing = this.generationRoutingEpoch;
      const provisional = await this.provisionalResult(string(historyParams.threadId), historyParams);
      if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== epoch) return;
      if (provisional && this.provisionalThreads?.get(string(historyParams.threadId))?.phase === "created") {
        if (message.method === "thread/resume") {
          if (this.options.requiresWorkspaceResume?.(string(historyParams.threadId))) {
            const threadId = string(historyParams.threadId);
            const check = () => {
              if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== epoch
                || generation !== this.sessionMcpGeneration || routing !== this.generationRoutingEpoch
                || !this.physicalAvailable || this.coreReinitializing)
                throw Error("Provisional workspace request expired");
              this.validateSubmissionContext(context); context.resourceOwner?.assertCurrent();
            };
            try {
              check();
              await this.options.restoreProvisionalWorkspace!({ threadId, context, confirm: async () => {
                check();
                const evidence = await this.provisionalResult(threadId, historyParams);
                check();
                if (!evidence) throw Error("Native provisional evidence expired");
                return evidence;
              } });
              check();
            } catch {
              if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === epoch)
                this.emit({ id, error: { code: -32000, message: "Workspace restoration unavailable" } }, clientId);
              return;
            }
          }
          // Native resume requires a rollout. Only a retained callback lane (or
          // this connection's original subscription) can watch an empty Thread.
          if (!this.nativeSubscribedThreads.has(string(historyParams.threadId))
            && !this.nativeCore?.supportsOrchestration) {
            this.emit({ id, error: { code: -32600, message: "当前连接无法恢复空会话" } }, clientId);
            return;
          }
          this.nativeSubscribedThreads.add(string(historyParams.threadId));
          this.subscribeThread(string(historyParams.threadId), clientId);
          this.claimInteractionOwner(string(historyParams.threadId), clientId);
        } else if (historyParams.watch === true) this.watchHistory(string(historyParams.threadId), clientId);
        if (this.initializedClients.has(clientId)) this.emit({ id, result: { ...provisional,
          ...(message.method === "thread/read" ? { initialTurnsPage: { data: [], nextCursor: null } } : {}) } }, clientId);
        return;
      }
    }
    if (id !== null && this.transcriptCache && (cachedRead || cachedPage)) {
      if (!this.initializedClients.has(clientId)) { this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId); return; }
      // Cache hydration has its own reply; it must not retain the frame send lane.
      void this.serveCachedHistory(clientId, id, string(message.method), historyParams, cachedRead);
      return;
    }
    if (id !== null && message.method === CODEX_MAINTENANCE_READ) {
      if (!this.initializedClients.has(clientId)) { this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId); return; }
      this.emit({ id, result: this.maintenanceSnapshot() }, clientId); return;
    }
    const maintenanceRejected = isCodexAdmission(message.method, message.params) && this.admissionPaused();
    if (maintenanceRejected || (this.isGenerationAdmission(message.method, message.params) && this.generationAdmissionBlocked(message.params))) {
      this.admissionRejected(String(message.method), message.params, clientId, maintenanceRejected ? "maintenance" : "generation-fence");
      if (id !== null) this.emit({ id, error: codexMaintenanceError() }, clientId);
      return;
    }
    if (id !== null && message.method === "opencraft/token-usage/configure") {
      if (!this.initializedClients.has(clientId)) {this.emit({id,error:{code:-32600,message:"Client is not initialized"}},clientId);return;}
      if (!this.tokenUsage) {this.emit({id,error:{code:this.tokenUsageStorageUnavailable?-32000:-32601,message:this.tokenUsageStorageUnavailable?"unavailable":"Token statistics are unsupported"}},clientId);return;}
      const authority=context.tokenUsageAuthority?.();
      if(!authority||!authority.administrator){this.emit({id,error:{code:authority?403:401,message:authority?"forbidden":"unauthorized"}},clientId);return;}
      const params=record(message.params);
      if(typeof params.enabled!=="boolean"||Object.keys(params).some(key=>key!=="enabled")){this.emit({id,error:{code:-32602,message:"invalid-query"}},clientId);return;}
      try{
        const usage=this.tokenUsage;
        if(usage instanceof TokenUsageCollector)await usage.setEnabled(params.enabled);else usage.ledger.setEnabled(params.enabled);
        this.options.tokenUsage?.derivedQueries?.invalidate("*");
        const {enabled,enabledAt,revision}=usage instanceof TokenUsageCollector?usage.coverage():usage.ledger.coverage();
        this.emit({id,result:{enabled,enabledAt,revision}},clientId);
      }catch{this.emit({id,error:{code:-32000,message:"unavailable"}},clientId);}
      return;
    }
    if (id !== null && message.method === "opencraft/token-usage/query") {
      if (!this.initializedClients.has(clientId)) { this.emit({id,error:{code:-32600,message:"Client is not initialized"}},clientId); return; }
      if (!this.tokenUsageQueries) { this.emit({id,error:{code:this.tokenUsageStorageUnavailable?-32000:-32601,message:this.tokenUsageStorageUnavailable?"unavailable":"Token statistics are unsupported"}},clientId); return; }
      const epoch=this.clientEpoch(clientId);
      try {
        const authorize=context.tokenUsageAuthority??(()=>null),before=authorize();
        const result=labelUsagePeople(await this.tokenUsageQueries.read(message.params,authorize), this.options.tokenUsage?.person);
        const liveGaps=this.tokenUsage?.liveGapCount()??0;
        if(liveGaps)result.coverage={...result.coverage,partial:true,openGaps:Math.max(result.coverage.openGaps,liveGaps)};
        const after=authorize();
        if(!after)throw new TokenUsageQueryError("unauthorized");
        if(!before||after.actorId!==before.actorId||after.administrator!==before.administrator)throw new TokenUsageQueryError("forbidden");
        if(epoch===this.clientEpoch(clientId)&&this.initializedClients.has(clientId))this.emit({id,result},clientId);
      } catch (error) {
        const kind=error instanceof TokenUsageQueryError?error.code:"unavailable";
        if(epoch===this.clientEpoch(clientId)&&this.initializedClients.has(clientId))this.emit({id,error:{code:kind==="unauthorized"?401:kind==="forbidden"?403:kind==="stale-snapshot"?409:kind==="invalid-query"?-32602:-32000,message:kind}},clientId);
      }
      return;
    }
    if (id !== null && message.method === "thread/list" && this.durableCatalog?.supports(record(message.params))) {
      if (!this.initializedClients.has(clientId)) { this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId); return; }
      const epoch = this.clientEpoch(clientId);
      try {
        const page = await this.durableCatalog.list(record(message.params));
        const result = this.catalogChanges.projectList(message.params, page);
        if (this.initializedClients.has(clientId) && epoch === this.clientEpoch(clientId)) this.emit({ id, result }, clientId, "thread/list");
      } catch {
        if (this.initializedClients.has(clientId) && epoch === this.clientEpoch(clientId)) this.emit({ id, error: { code: -32000, message: "Conversation catalog is unavailable" } }, clientId);
      }
      return;
    }
    // Remote discovery is explicitly unsupported; never forward a local-only
    // identity probe to the native execution protocol or report the hub machine.
    if (this.options.kind === "remote" && message.method === "runtime/machine/read") {
      if (id !== null) this.emit({ id, error: { code: -32601, message: "Remote machine identity is unavailable" } }, clientId);
      return;
    }
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
      && !(this.remoteAttachmentsReady && ["attachment/stage", "attachment/remove", "attachment/uploadChunk", "attachment/uploadCancel"].includes(message.method))) {
      if (id !== null) this.emit({ id, error: { code: -32601, message: "This operation is unavailable on the remote connection" } }, clientId);
      return;
    }
    if (id !== null && message.method === undefined && ("result" in message || "error" in message)) {
      const humanThread = this.humanInteractions.threadForNative(id);
      if (humanThread !== null) {
        if (!this.initializedClients.has(clientId) || !this.humanInteractions.wasOffered(id, clientId) || this.sharedInteractionClients.has(clientId)) return;
        if ("result" in message) await this.humanInteractions.respondNative(id, `legacy:${clientId}:${JSON.stringify(id)}`, record(message.result),
          (source, result) => this.writePhysical({ id: source.id, result, __opencraftInteractionKey: source.__opencraftInteractionKey }));
        return;
      }
      const request = this.serverRequests.get(JSON.stringify(id));
      if (request?.ownerClientId !== clientId || !this.initializedClients.has(clientId)) return;
      this.serverRequests.delete(JSON.stringify(id));
      // A terminal Turn retired this native callback. The client's late reply
      // only acknowledges provider settlement; it cannot complete native work.
      if (!request.cancelled) await this.writePhysical(message);
      return;
    }
    if (id !== null && typeof message.method === "string") {
      if (!this.initializedClients.has(clientId)) {
        this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId);
        return;
      }
      if (message.method.startsWith("opencraft/orchestration/")) {
        try {
          const result = await this.orchestrationControl.handle(message.method, record(message.params), context);
          this.emit({ id, result }, clientId);
        }
        catch (error) { this.emit({ id, error: { code: error instanceof OrchestrationControlError ? error.code : -32000, message: errorMessage(error) } }, clientId); }
        return;
      }
      if (Object.keys(record(message.params)).some(key => key.startsWith("__opencraftOrchestration") || key === "__opencraftDelegationId")) {
        this.emit({ id, error: { code: 403, message: "Orchestration metadata requires its trusted control lane" } }, clientId); return;
      }
      if (message.method === "opencraft/turn-recovery/read") {
        const threadId = string(record(message.params).threadId);
        this.emit({ id, result: { recovery: this.providerRetry?.notice(threadId) ?? this.recovery?.notice(threadId) ?? null } }, clientId);
        return;
      }
      if (["turn/start", "turn/steer", "turn/interrupt", "thread/archive", "thread/delete", "thread/goal/set", "thread/goal/clear", "thread/settings/update", "thread/queue/add", "thread/queue/steer", "thread/queue/start", "thread/queue/retry"].includes(message.method)) {
        if (!context.collaborationRequestId) {
          this.recovery?.handled(string(record(message.params).threadId), message.method === "turn/interrupt" ? "user_stop" : "user_input");
          this.providerRetry?.handled(string(record(message.params).threadId));
        }
      }
      if (this.options.kind === "remote" && this.pending.size >= 1024) {
        this.emit({ id, error: { code: -32000, message: "Remote request limit exceeded" } }, clientId);
        return;
      }
      const requestClientEpoch = this.clientEpoch(clientId);
      if (message.method === COLLABORATION_METHOD) {
        try {
          this.validateSubmissionContext(context);
          if (!this.options.collaboration) throw Object.assign(new Error('unsupported_capability'), {status:409,code:'unsupported_capability'});
          if (!context.actorContext) throw Object.assign(new Error('actor_authentication_required'), {status:401,code:'actor_authentication_required'});
          context.resourceOwner?.assertCurrent();
          const result = await this.options.collaboration.command(context.actorContext, record(message.params), context);
          context.resourceOwner?.assertCurrent();
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) this.emit({id,result},clientId);
        } catch (error) {
          const fault = error as { status?: number; code?: unknown };
          const code = fault?.code === -32601 ? 'unsupported_capability' : fault?.code;
          const status = fault?.code === -32601 ? 409 : fault?.status;
          const known = typeof code === 'string' && /^[a-z_]{1,80}$/u.test(code) && [400,401,403,404,409,503].includes(status ?? 0);
          this.emit({id,error:{code:-32070,message:"Conversation operation could not be confirmed. Review its receipt before retrying.",
            ...(known ? {data:{code,status}} : {})}},clientId);
        }
        return;
      }
      if (message.method.startsWith("opencraft/schedules/")) {
        try {
          this.validateSubmissionContext(context);
          if (!this.schedules) throw new ScheduleFault(-32601, "Schedules are not available on this Host");
          const result = message.method === CONVERSATION_SCHEDULES.list ? this.schedules.list()
            : await this.schedules.handle(message.method, message.params, context.sender?.loginName ?? null);
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) this.emit({ id, result }, clientId);
        } catch (error) {
          if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch) this.emit({ id, error: {
            code: error instanceof ScheduleFault ? error.code : -32000,
            message: error instanceof ScheduleFault ? error.message : "Schedule request could not be completed",
          } }, clientId);
        }
        return;
      }
      if (message.method.startsWith("opencraft/tasks/")) {
        try {
          if (!this.tasks) throw new TasksFault(-32601, "Tasks are served by this Host's services layer");
          const result = this.tasks.handle(message.method, message.params);
          this.reportStorage();
          this.emit({ id, result }, clientId);
        } catch (error) {
          this.emit({ id, error: { code: error instanceof TasksFault ? error.code : -32050, message: error instanceof TasksFault ? error.message : "Tasks storage unavailable" } }, clientId);
        }
        return;
      }
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
      if (["attachment/stage", "attachment/remove", "attachment/uploadChunk", "attachment/uploadCancel"].includes(message.method)) {
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
      if (["thread/name/set", "thread/delete", "thread/archive"].includes(message.method)) this.threadTitles?.invalidate(string(params.threadId));
      if (typeof params.permissions === "string") {
        try {
          params = { ...params, ...await this.resolvePermissionSelection(params.permissions, params.cwd) };
          message = { ...message, params };
        } catch (error) {
          this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
          return;
        }
      }
      if ((message.method === "turn/start" || message.method === "turn/steer") && Array.isArray(params.input)) {
        try {
          if (string(params.clientUserMessageId).startsWith('actor-input:')) throw new Error('Actor input requires the managed queue');
          this.validateSubmissionContext(context);
        } catch (error) {
          this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
          return;
        }
      }
      if (message.method === "turn/steer" && this.options.kind !== "remote" &&
        string(params.clientUserMessageId) && Array.isArray(params.input) && !this.ephemeralThreads.has(string(params.threadId))) {
        try {
          const threadId=string(params.threadId), expected=string(params.expectedTurnId);
          if (!threadId || !expected) throw new OpenCraftQueueRpcError(-32602,"Steer requires a Thread and expected Turn");
          const row=this.hostState!.transaction(()=>{
            this.recordSender(params,context);
            return this.queueStore().add(threadId,string(params.clientUserMessageId),params.input as unknown[],snapshotExecutionSubmission(context));
          });
          this.emitQueueChanged(threadId);
          const result=await this.withThreadOperation(threadId,async()=>{
            const head=this.queueStore().firstAwaitingAdmission(threadId);
            if (head && head.id!==row.id && ['dispatching','unknown'].includes(head.state)) {
              this.scheduleQueueMaintenance(threadId);
              return {turnId:expected,disposition:'queued',delivery:this.queueStore().find(threadId,row.id)?.delivery};
            }
            try {
              return await this.dispatchQueuedSteer(threadId,row.id,expected,context,params.additionalContext,()=>this.initializedClients.has(clientId)&&this.clientEpoch(clientId)===requestClientEpoch);
            } catch(error) {
              // Exact native rejection is proof of non-dispatch. Preserve custody
              // for a fresh Turn instead of targeting another active Turn by guess.
              if (!this.definitiveSteerRejection(error)) throw error;
              this.scheduleQueueMaintenance(threadId);
              return {turnId:expected,disposition:'queued',delivery:this.queueStore().find(threadId,row.id)?.delivery};
            }
          });
          if (this.initializedClients.has(clientId)&&this.clientEpoch(clientId)===requestClientEpoch)
            this.emit({id,result:{...result,__opencraftSubmissionSender:{clientMessageId:row.clientUserMessageId,sender:this.messageSenders?.get(threadId,row.clientUserMessageId)??null}}},clientId);
        } catch(error) {
          this.emit({id,error:{code:error instanceof OpenCraftQueueRpcError?error.code:-32602,message:errorMessage(error)}},clientId);
        }
        return;
      }
      if (message.method === "turn/interrupt") this.diagnostic({
        event: "turn-interrupt", clientId, requestId: physicalId,
        threadId: string(params.threadId), turnId: string(params.turnId), pid: this.child?.pid ?? null,
      });
      if (typeof message.method === "string" && ["turn/start", "thread/delete", "thread/archive"].includes(message.method)) {
        this.providerRetry?.handled(string(params.threadId));
      }
      if (message.method === "thread/resume") this.diagnostic({
        event: "thread-resume-start", clientId, requestId: physicalId,
        threadId: string(params.threadId), pid: this.child?.pid ?? null,
      });
      const resumeStage = (stage: string, outcome: string) => {
        if (message.method === "thread/resume") this.diagnostic({
          event: "thread-resume-stage", clientId, requestId: physicalId,
          threadId: string(params.threadId), stage, outcome,
          elapsedMs: Math.round(performance.now() - receivedAt),
        });
      };
      const ownsRequest = () => this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch;
      const forward = async () => {
        let executionAuthorityAdmitted = false;
        if (message.method === "thread/resume") {
          // Execution activation joins its existing tool preparation. A view
          // must not race that owner by installing another configuration.
          const refresh = this.sessionMcpRefreshes.get(string(params.threadId));
          if (refresh) resumeStage("tool-refresh", "waiting");
          try {
            await refresh;
            if (refresh) resumeStage("tool-refresh", "ready");
          }
          catch (cause) {
            resumeStage("tool-refresh", "failed");
            if (this.initializedClients.has(clientId) && this.clientEpoch(clientId) === requestClientEpoch)
              this.emit({ id, error: this.sessionMcpFailure(cause) }, clientId);
            return;
          }
        }
        if (!ownsRequest()) { resumeStage("before-dispatch", "client-replaced"); return; }
        if (message.method === "thread/resume" && this.sessionMcpRetirements.has(string(params.threadId))) {
          try {
            resumeStage("tool-preparation", "waiting");
            if (this.sessionMcpRefreshes.has(string(params.threadId))) throw new SessionMcpRecoveryPending();
            await this.prepareSessionMcp(string(params.threadId));
            resumeStage("tool-preparation", "ready");
          }
          catch (cause) { resumeStage("tool-preparation", "failed"); this.emit({ id, error: this.sessionMcpFailure(cause) }, clientId); return; }
        }
        if (!ownsRequest()) { resumeStage("before-dispatch", "client-replaced"); return; }
        if (message.method === "thread/start" || message.method === "thread/fork") {
          try { this.validateSubmissionContext(context); }
          catch (error) { this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId); return; }
          const { sender: _sender, creator: _creator, ...nativeParams } = params;
          params = nativeParams; message = { ...message, params };
        }
        if ((message.method === "turn/start" || message.method === "turn/steer") && Array.isArray(params.input)) {
          try {
            // Admission occurs after thread serialization and attachment I/O.
            // A valid identity at click time cannot authorize a later write.
            if (string(params.clientUserMessageId).startsWith('actor-input:')) throw new Error('Actor input requires the managed queue');
            this.validateSubmissionContext(context);
            const prepared = await this.modelVisibleAttachmentInput(params.input, string(params.threadId), clientId, context);
            if (context.actorContext && this.options.collaboration?.prepare) {
              const referenceContext = await this.options.collaboration.prepare(context.actorContext, prepared.input);
              if (referenceContext) params = {...params, additionalContext:{...record(params.additionalContext), "opencraft.conversations":{kind:"untrusted",value:JSON.stringify(referenceContext)}}};
            }
            if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== requestClientEpoch) return;
            this.recordSender(params, context); // Rechecks validity after the final await.
            params = {...params,clientUserMessageId:string(params.clientUserMessageId)||`input:${randomUUID()}`};
            if (this.options.executionAuthority && context.actorContext) {
              this.options.executionAuthority.admit(context.actorContext, string(params.threadId), string(params.clientUserMessageId));
              executionAuthorityAdmitted = true;
            }
            if ((message.method === "turn/start" || message.method === "turn/steer") && context.actorContext && this.options.collaboration) {
              const inputId = string(params.clientUserMessageId) || `input:${randomUUID()}`;
              params = {...params, clientUserMessageId: inputId};
              context.resourceOwner?.assertCurrent();
              this.options.collaboration.authorize(context.actorContext, string(params.threadId), inputId, prepared.input);
            }
            if (prepared.attachments.length > 0) this.attachmentRecords().record(
              string(params.threadId), string(params.clientUserMessageId), prepared.attachments);
            params = { ...params, input: prepared.input };
            delete params.sender;
            this.executionLeases?.capture(string(params.threadId), string(params.clientUserMessageId), snapshotExecutionSubmission(context), "accepted", message.method === "turn/steer" ? "steer" : "start");
            message = { ...message, params };
          } catch (error) {
            this.emit({ id, error: { code: -32602, message: errorMessage(error) } }, clientId);
            return;
          }
        }
        if (message.method === "turn/steer") {
          try {
            await this.admitModelExecution("steer", params, context);
          } catch (cause) { this.emit({ id, error: this.sessionMcpFailure(cause) }, clientId); return; }
        }
        if (message.method === "turn/start") {
          try {
            const threadId = string(params.threadId), inputId = string(params.clientUserMessageId);
            await this.admitModelExecution("start", params, context);
            const executionId = await this.beginExecution(threadId, inputId);
            await this.prepareSessionMcp(threadId, inputId, executionId);
          } catch (cause) {
            this.retireGatewayAdmission(params);
            this.emit({ id, error: this.sessionMcpFailure(cause) }, clientId);
            return;
          }
          if (!this.initializedClients.has(clientId) || this.clientEpoch(clientId) !== requestClientEpoch) {this.retireGatewayAdmission(params);return;}
          try{this.validateSubmissionContext(context);}catch(cause){this.retireGatewayAdmission(params);throw cause;}
        }
        const pending: PendingRequest = { clientId, clientEpoch: requestClientEpoch, originalId: id, method: message.method as string, params,
          ...(["thread/start", "thread/fork"].includes(string(message.method)) ? { modelCreator: () => {
            this.validateSubmissionContext(context);
            context.resourceOwner?.assertCurrent();
            if (!context.actorContext || context.actorContext.expiresAt <= Date.now()) return null;
            const actor = (this.options.modelActor ?? this.options.tokenUsage?.actor)?.(context.actorContext);
            return actor?.kind === 'human' ? actor.id : null;
          } } : {}),
          ...(message.method === "model/list" ? { gatewayViewer: () => {
            if (this.options.filterGatewayModelCatalog) {
              this.validateSubmissionContext(context);
              context.resourceOwner?.assertCurrent();
            }
            const resolve = this.options.modelActor ?? this.options.tokenUsage?.actor;
            return context.actorContext ? resolve?.(context.actorContext)?.id ?? null : null;
          } } : {}),
          executionAuthorityAdmitted,
          ...(["thread/read", "thread/turns/list"].includes(string(message.method)) ? { historyTiming: { pairId: randomUUID(), started: receivedAt } } : {}),
          ...((message.method === "thread/start" || message.method === "thread/fork") ? { metadataSender: context.sender } : {}) };
        const admissionGeneration = this.sessionMcpGeneration;
        pending.nativeAdmission = Object.freeze({ method: pending.method, context: () => {
          if (this.pending.get(physicalId) !== pending || !this.validClientRequest(pending)
            || admissionGeneration !== this.sessionMcpGeneration || !this.physicalAvailable)
            throw new Error("Native request admission expired");
          this.validateSubmissionContext(context);
          context.resourceOwner?.assertCurrent();
          return context;
        } });
        const finalizeWorkspaceReceipt = message.method === 'thread/start' ? this.options.finalizeNativeCreation
          : message.method === 'thread/resume' ? this.options.finalizeNativeResume : undefined;
        if (finalizeWorkspaceReceipt) {
          const workspaceParams = structuredClone(params);
          pending.finalizeWorkspaceReceipt = async reply => {
            await finalizeWorkspaceReceipt({ context, requestId: physicalId, params: workspaceParams, ...reply });
            this.validateSubmissionContext(context);
            context.resourceOwner?.assertCurrent();
          };
        }
        if (message.method === "turn/start" || message.method === "turn/steer") {
          const inputId = string(params.clientUserMessageId);
          const usageRuntime=this.tokenUsage,physicalGeneration=this.sessionMcpGeneration;
          try {
            const mode=message.method === "turn/start" ? "start":"steer";
            pending.usageAttemptId=randomUUID();
            await usageRuntime?.attempt(pending.usageAttemptId,string(params.threadId),inputId,mode,this.usageIdentity(string(params.threadId),string(params.threadId),inputId,mode,context));
          } catch { this.diagnostic({event:"token-usage-partial",category:"submission"}); }
          if(!this.initializedClients.has(clientId)||this.clientEpoch(clientId)!==requestClientEpoch||this.statusValue.state!=="open"||physicalGeneration!==this.sessionMcpGeneration){
            if(pending.usageAttemptId)usageRuntime?.attemptOutcome(pending.usageAttemptId,"rejected");return;
          }
          try{this.validateSubmissionContext(context);}catch(error){if(pending.usageAttemptId)usageRuntime?.attemptOutcome(pending.usageAttemptId,"rejected");throw error;}
        }
        // Native fork has no fixed deadline in Workbench. Preserve that
        // contract; its ledger is still bounded by the admission limit and
        // retired with the physical generation, rather than timed out here.
        if (this.options.kind === "remote" && message.method !== "thread/fork") {
          pending.timer = setTimeout(() => {
            if (this.pending.get(physicalId) !== pending) return;
            this.pending.delete(physicalId);
            resumeStage("native-reply", "timed-out");
            if(pending.usageAttemptId)this.tokenUsage?.attemptOutcome(pending.usageAttemptId,"unknown");
            if (this.validClientRequest(pending)) this.emit({ id, error: { code: -32000, message: "Remote request timed out; delivery outcome is unknown" } }, clientId);
          }, 30_000);
          pending.timer.unref();
        }
        if ((message.method === "thread/start" || message.method === "thread/fork") && this.options.executionEnvironment) {
          const runtime = this.options.executionEnvironment;
          const creationParams = message.method === "thread/fork" ? { projectId: runtime.project('local-codex', string(params.threadId)) } : params;
          const scope = runtime.scope(context, 'local-codex', creationParams);
          const environment = runtime.snapshot(scope, { creation: true });
          await environment.ready();
          environment.apply(process.env);
          if (environment.toJSON().configured && !await this.canInjectEnvironment(message.method === "thread/fork" ? string(params.threadId) : undefined)) throw new Error("Environment variables require a Codex owner handoff");
          pending.environmentCreationScope = scope;
          this.environmentCreations.set(physicalId, environment);
        }
        this.pending.set(physicalId, pending);
        if (message.method === "thread/resume") {
          const threadId = string(params.threadId);
          this.cancelNativeRelease(threadId);
        }
        if (pending.historyTiming) pending.historyTiming.nativeStarted = performance.now();
        try{await this.writePhysical({ ...message, id: physicalId }, () => {
          this.validateSubmissionContext(context);
          if (message.method === "thread/name/set" && context.orchestrationOperationId && context.orchestrationCanAdmit?.() !== true) {
            throw new OrchestrationControlError(403, "Orchestration delegation was revoked");
          }
          const owned = ownsRequest();
          resumeStage("native-dispatch", owned ? "attempted" : "client-replaced");
          return owned;
        }); resumeStage("native-dispatch", "written");}
        catch(error){resumeStage("native-dispatch", "failed");if(pending.usageAttemptId)this.tokenUsage?.attemptOutcome(pending.usageAttemptId,"unknown");throw error;}
      };
      if (message.method === "thread/resume") {
        const threadId = string(params.threadId);
        const release = this.nativeReleases.get(threadId);
        if (release) resumeStage("native-release", "waiting");
        try {
          await release;
          if (release) resumeStage("native-release", "ready");
        } catch (error) { resumeStage("native-release", "failed"); throw error; }
        await forward();
      } else if (["turn/start", "turn/steer", "thread/name/set", "thread/delete", "thread/archive"].includes(string(message.method)) && string(params.threadId)) {
        await this.withThreadOperation(string(params.threadId), forward);
      } else await forward();
      return;
    }
    // No allowlisted request may bypass initialization/ID mapping by being
    // disguised as a notification. Native initialized is consumed above.
    if (this.options.kind !== "remote") await this.writePhysical(message);
  }

  private async serveCachedHistory(clientId: string, id: string | number, method: string, historyParams: RpcRecord, cachedRead: boolean): Promise<void> {
    const epoch = this.clientEpoch(clientId);
    // Only identical concurrent reads in the same logical owner/epoch share a
    // native cut. Completed reads are never retained, and page shape/watch/
    // checkpoint parameters remain part of the identity.
    const { historyReadId, ...readParams } = historyParams;
    const key = JSON.stringify([clientId, epoch, this.transcriptCache!.readRevision(string(readParams.threadId)), method, readParams], (_key, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    if (this.cachedHistoryWaiters >= 64) {
      this.emit({ id, error: { code: -32073, message: "History reader is busy; retry the read",
        data: { code: "HISTORY_READ_UNAVAILABLE", retryable: true } } }, clientId);
      return;
    }
    let flight = this.cachedHistoryFlights.get(key);
    if (!flight) {
      if (this.cachedHistoryInFlight >= 64) {
        this.emit({ id, error: { code: -32073, message: "History reader is busy; retry the read",
          data: { code: "HISTORY_READ_UNAVAILABLE", retryable: true } } }, clientId);
        return;
      }
      const controller = new AbortController();
      flight = { promise: this.readCachedHistory(clientId, method, readParams, cachedRead, controller), controller, readers: new Set() };
      this.cachedHistoryFlights.set(key, flight);
      const retire = () => { if (this.cachedHistoryFlights.get(key) === flight) this.cachedHistoryFlights.delete(key); };
      controller.signal.addEventListener("abort", retire, { once: true });
      void flight.promise.finally(() => { retire(); controller.signal.removeEventListener("abort", retire); }).catch(() => {});
    } else this.historyDiagnostic({ event: "history-read-coalesced", method });
    const reader = {};
    this.cachedHistoryWaiters++;
    flight.readers.add(reader);
    let cancelled = false;
    const cancellationKey = typeof historyReadId === "string" ? JSON.stringify([clientId, epoch, historyReadId]) : null;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true; this.cachedHistoryWaiters--; flight!.readers.delete(reader);
      // Settle this RPC through every router now; leaving it unanswered would
      // retain their translated pending IDs until timeout even with a live peer.
      if (epoch === this.clientEpoch(clientId) && this.initializedClients.has(clientId)) this.emit({ id,
        error: { code: -32073, message: "History reader cancelled", data: { code: "HISTORY_READ_UNAVAILABLE", retryable: true } } }, clientId);
      if (flight!.readers.size === 0) flight!.controller.abort(new Error("History reader cancelled"));
    };
    const cancellation = { threadId: string(readParams.threadId), cancel };
    if (cancellationKey) this.cachedHistoryCancellations.set(cancellationKey, cancellation);
    try {
      const reply = await flight.promise;
      if (!cancelled && epoch === this.clientEpoch(clientId) && this.initializedClients.has(clientId)) this.emit({ id, ...reply }, clientId, method);
    } finally {
      if (!cancelled) this.cachedHistoryWaiters--;
      flight.readers.delete(reader);
      if (cancellationKey && this.cachedHistoryCancellations.get(cancellationKey) === cancellation) this.cachedHistoryCancellations.delete(cancellationKey);
    }
  }

  private async readCachedHistory(clientId: string, method: string, historyParams: RpcRecord, cachedRead: boolean, controller: AbortController): Promise<RpcRecord> {
    this.cachedHistoryInFlight++;
    const started = performance.now(), pairId = randomUUID();
    const trace: { pairId: string; nativeRpcMs: number; nativeRpcCount: number; itemHydrationPath: string; turnCountBucket: string; lengthBucket: string; itemQueueMs?: number } =
      { pairId, nativeRpcMs: 0, nativeRpcCount: 0, itemHydrationPath: "none", turnCountBucket: "unknown", lengthBucket: "unknown" };
    const phases: Record<string, number> = {};
    const activePhases = new Map<string, number[]>();
    let terminalSnapshotCreated = false;
    const measured = (phase: string, ms: number, context?: HistoryReadContext) => {
      if (terminalSnapshotCreated) return;
      if (phase === "start") {
        const activePhase = context?.activePhase;
        if (activePhase) { const starts = activePhases.get(activePhase) ?? []; starts.push(performance.now()); activePhases.set(activePhase, starts); }
        return;
      }
      if (phase !== "context") {
        phases[phase + "Ms"] = (phases[phase + "Ms"] ?? 0) + ms;
        const starts = activePhases.get(phase); starts?.pop();
        if (starts && starts.length === 0) activePhases.delete(phase);
      }
      if (context) {
        if (typeof context.itemQueueMs === "number") trace.itemQueueMs = Math.max(Number(trace.itemQueueMs ?? 0), context.itemQueueMs);
        const { itemQueueMs: _itemQueueMs, ...safeContext } = context;
        Object.assign(trace, safeContext);
      }
    };
    let outcome = "aborted";
    const epoch = this.clientEpoch(clientId), threadId = string(historyParams.threadId);
    this.historyReadTraces.set(controller.signal, trace);
    let reads = this.cachedHistoryReads.get(clientId);
    if (!reads) { reads = new Map(); this.cachedHistoryReads.set(clientId, reads); }
    reads.set(controller, threadId);
    const configuredTimeout = this.options.kind === "local" ? this.options.historyReadTimeoutMs : undefined;
    const timeoutMs = Math.max(1_000, Math.min(MAX_HISTORY_READ_TIMEOUT_MS, configuredTimeout ?? DEFAULT_HISTORY_READ_TIMEOUT_MS));
    const timer = setTimeout(() => controller.abort(new Error("History read timed out; retry the read")), timeoutMs);
    timer.unref?.();
    try {
      const limit = cachedRead ? record(historyParams.initialTurnsPage).limit : historyParams.limit;
      const result = cachedRead ? await this.transcriptCache!.read(threadId, typeof limit === "number" ? limit : 10, () => {
        if (historyParams.watch === true && epoch === this.clientEpoch(clientId) && this.initializedClients.has(clientId))
          this.watchHistory(threadId, clientId);
      }, record(historyParams.initialTurnsPage).itemsView === "notLoaded" ? "notLoaded" : record(historyParams.initialTurnsPage).itemsView === "presentation" ? "presentation" : "full", controller.signal, measured, record(historyParams.initialTurnsPage).imageResources === true)
        : await this.transcriptCache!.page(threadId, historyParams.cursor == null ? null : string(historyParams.cursor), typeof limit === "number" ? limit : 10, undefined, historyParams.itemsView === "notLoaded" ? "notLoaded" : historyParams.itemsView === "presentation" ? "presentation" : "full",
          historyParams.sortDirection === "asc" ? "asc" : "desc", controller.signal, measured, typeof historyParams.detailItemId === "string" ? historyParams.detailItemId : undefined, historyParams.imageResources === true);
      const resultThread = record(record(result).thread);
      const turnCount = Number(resultThread.historyTurnCount);
      if (Number.isSafeInteger(turnCount) && turnCount >= 0) trace.turnCountBucket = historyTurnCountBucket(turnCount);
      const rolloutPath = string(resultThread.path);
      if (rolloutPath) {
        try { trace.lengthBucket = historyLengthBucket((await stat(rolloutPath)).size); }
        catch { /* A missing/unavailable rollout size stays unknown. */ }
      }
      if (epoch !== this.clientEpoch(clientId) || !this.initializedClients.has(clientId) || controller.signal.aborted) throw new Error("History reader retired");
      if (historyParams.watch === true) this.watchHistory(threadId, clientId);
      const projectionStarted = performance.now();
      measured("start", 0, { activePhase: "projection" });
      let reply: unknown;
      try {
        const restoredThread=record(record(result).thread);
        const restoredTurns = [restoredThread.turns, record(record(result).initialTurnsPage).data, record(result).data]
          .flatMap(turns => Array.isArray(turns) ? turns : []);
        for (const turn of Array.isArray(restoredTurns) ? restoredTurns : []) {
          const restoredItems=record(turn).items;
          for (const item of Array.isArray(restoredItems)?restoredItems:[])
            this.captureArtifactOutput(string(restoredThread.id)||string(historyParams.threadId),record(item),string(record(turn).id));
        }
        const projected = projectThreadMessageResult(this.projectSender, method, historyParams, result, { trustedSubmissionSender: !!this.messageSenders });
        reply = this.messageAttachments ? projectThreadAttachmentResult(this.messageAttachments, method, historyParams, projected) : projected;
      } finally { measured("projection", performance.now() - projectionStarted); }
      outcome = "ok";
      return { result: { ...record(reply), __opencraftHistoryTiming: { ...phases, ...trace, coreMs: performance.now() - started } } };
    } catch (error) {
      outcome = controller.signal.aborted ? "aborted" : "failed";
      return { error: { code: -32073, message: errorMessage(error), data: { code: "HISTORY_READ_UNAVAILABLE", retryable: true } } };
    } finally {
      const finishedAt = performance.now();
      for (const [phase, starts] of activePhases) phases[phase + "Ms"] = (phases[phase + "Ms"] ?? 0)
        + starts.reduce((total, phaseStarted) => total + Math.max(0, finishedAt - phaseStarted), 0);
      activePhases.clear();
      const terminalPhases = { ...phases };
      const terminalTrace = { ...trace };
      terminalSnapshotCreated = true;
      const coreMs = finishedAt - started;
      const resources = coreMs > 5_000 ? await (this.options.historyResourceMetadata ?? readHistoryResourceMetadata)() : undefined;
      this.historyDiagnostic({ event: "history-read-stages", pairId, method, outcome,
        turnCountBucket: terminalTrace.turnCountBucket, lengthBucket: terminalTrace.lengthBucket, itemHydrationPath: terminalTrace.itemHydrationPath,
        ...terminalPhases, itemQueueMs: terminalTrace.itemQueueMs, nativeRpcMs: terminalTrace.nativeRpcMs, nativeRpcCount: terminalTrace.nativeRpcCount, coreMs,
        ...(resources ? { resources } : {}) });
      this.historyReadTraces.delete(controller.signal);
      clearTimeout(timer); this.cachedHistoryInFlight--; reads.delete(controller);
      if (reads.size === 0 && this.cachedHistoryReads.get(clientId) === reads) this.cachedHistoryReads.delete(clientId);
    }
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    if (this.coreBridge) return this.coreBridge.subscribeMessage(listener);
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    if (this.coreBridge) return this.coreBridge.subscribeStatus(listener);
    this.statusListeners.add(listener); return () => this.statusListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.coreBridge) return this.coreBridge.close();
    if (this.closeOperation !== null) return this.closeOperation;
    for (const reads of this.cachedHistoryReads.values()) for (const read of reads.keys()) read.abort(new Error("Codex AppServer closed"));
    this.cachedHistoryReads.clear();
    clearInterval(this.generationUsageTimer);
    for (const timer of this.queuePreparationRetries.values()) clearTimeout(timer);
    this.queuePreparationRetries.clear();
    for (const timer of this.generationReconciling.values()) if (timer) clearTimeout(timer);
    this.generationReconciling.clear();
    this.threadTitles?.close();
    if(!this.options.tokenUsage?.derivedQueries)this.tokenUsageQueries?.close();
    this.tokenUsageQueries=null;
    for(const request of [...this.pending.values(),...this.internalRequests.values()])if(request.usageAttemptId)this.tokenUsage?.attemptOutcome(request.usageAttemptId,"unknown");
    // Outcomes above are posted before close; the worker drains them in order.
    const usage=this.tokenUsage;this.tokenUsage=null;
    if(usage instanceof TokenUsageCollector)this.tokenUsageClosing=usage.close().catch(()=>{});else usage?.close();
    this.artifactLifetime.abort();
    this.publishStatus({ state: "closing" });
    if (this.coreReconnectTimer) clearTimeout(this.coreReconnectTimer);
    this.rejectInternalRequests(new Error("Codex AppServer closed"));
    this.physicalInitialized = false;
    this.remoteGoalCapability = null;
    this.revokeDesktopOwners();
    this.closeOperation = (async () => {
      await this.executionGit?.close(); this.executionGit = undefined;
      await this.transcriptCache?.close(); this.transcriptCache = null;
      this.provisionalThreads?.close(); this.provisionalThreads = null;
      this.catalogChanges.clear();
      this.durableCatalog?.close(); this.durableCatalog = null;
      for (const timer of this.executionFaultRetries.values()) clearTimeout(timer);
      this.executionFaultRetries.clear();
      await Promise.all([...this.executionFaultCommits.values()].map(commit => commit.operation));
      await this.executionFaultWriter?.close(); this.executionFaultWriter = null;
      await this.providerRetry?.close(); this.providerRetry = null;
      await this.recovery?.close(); this.recovery = null;
      await this.schedules?.close(); this.schedules = null;
      for (const dispose of this.remoteDisposers.splice(0)) dispose();
      await this.nativeTransport?.close();
      this.rejectInternalRequests(new Error("Codex AppServer closed"));
      this.artifactLifetime.abort();
      await Promise.allSettled([...this.artifactOutputs]);
      await this.attachmentStaging?.close();
      if (this.options.kind === "remote") await this.options.transport.close();
      const child = this.child;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.rejectInternalRequests(new Error("Codex AppServer closed"));
      await this.login?.dispose().catch(() => undefined);
      this.login = null;
      await this.resetCreditService?.dispose();
      await this.subscriptions?.dispose();
      this.subscriptions = null;
      this.resetCreditService = null;
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
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
      this.identity?.close();
      this.identity = null;
      await this.tokenUsageClosing;this.tokenUsageClosing=null;
      await this.tokenUsageAttemptWriter?.close();this.tokenUsageAttemptWriter=null;
      this.tokenUsageState?.close();this.tokenUsageState=null;this.tokenUsageStorageUnavailable=false;
      this.hostState?.close();
      this.hostState = null;
      this.messageAttachments?.close();
      this.messageAttachments = null;
      this.tasks?.close();
      this.releaseWriter?.();
      this.releaseWriter = null;
      this.releaseOverlays?.(); this.releaseOverlays = null;
      for (const request of this.pending.values()) if (request.timer) clearTimeout(request.timer);
      this.pending.clear();
      this.initializeWaiters.length = 0;
      this.initializedClients.clear();
      this.clientEpochs.clear();
      this.threadClients.clear();
      this.historyWatchers.clear();
      for (const timer of this.nativeReleaseTimers.values()) clearTimeout(timer);
      this.nativeReleaseTimers.clear();
      this.nativeSubscribedThreads.clear();
      this.ephemeralThreads.clear();
      this.nativeReleases.clear();
      this.threadInteractionOwners.clear();
      this.collaborationCalls.clear();
      for (const call of this.nativeToolCalls.values()) call.abort.abort();
      this.nativeToolCalls.clear();
      this.serverRequests.clear();
      this.humanInteractions.clear();
      this.sharedInteractionClients.clear();
      this.removeHumanInteractionListener();
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
    if (record(record(pending.params.capabilities).extensions)[SHARED_INTERACTIONS_EXTENSION]) this.sharedInteractionClients.add(clientId);
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
      if (this.poolAuth !== null) {
        await this.requestPhysical("account/login/start", this.poolAuth);
        if (this.statusValue.state !== "open") return;
      }
      void this.reconcileExecutionLeases();
      this.durableCatalog?.start();
      try { this.tokenUsage?.initialize(message.result); } catch { this.diagnostic({event:"token-usage-partial",category:"initialize"}); }
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
              [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods: [...methods, "attachment/stage", "attachment/remove", "attachment/uploadChunk", "attachment/uploadCancel"] },
            } } };
          } else this.initializeResult = shared;
        } else this.initializeResult = shared;
      } else {
        this.initializeResult = this.attachmentStaging
          ? withCodexHostCapabilities(message.result, this.attachmentStaging.capability, this.desktopService?.capability(), (this.options.collaboration?.capabilities ?? (this.options.collaboration ? COLLABORATION_CAPABILITIES : undefined)))
          : projectSharedNativeCodexInitialize(message.result);
      }
      if (this.threadMetadata) {
        const value = record(this.initializeResult), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
        const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult = { ...value, capabilities: { ...capabilities, extensions: { ...extensions, ...this.threadMetadata.capabilities,
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, ...this.threadMetadata.methods])] } } : {}),
        } } };
      }
      if (this.options.collaboration?.topology) {
        const value=record(this.initializeResult),capabilities=record(value.capabilities),extensions=record(capabilities.extensions);
        this.initializeResult={...value,capabilities:{...capabilities,extensions:{...extensions,"opencraft/thread-orchestration-view":{version:1}}}};
      }
      if (this.options.collaboration) {
        const value=record(this.initializeResult),capabilities=record(value.capabilities),extensions=record(capabilities.extensions),access=record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        if(Array.isArray(access.methods)) this.initializeResult={...value,capabilities:{...capabilities,extensions:{...extensions,[OPENCRAFT_METHOD_ACCESS_EXTENSION]:{...access,methods:[...new Set([...access.methods,COLLABORATION_METHOD])]}}}};
      }
      if (this.tokenUsageQueries) {
        const value=record(this.initializeResult),capabilities=record(value.capabilities),extensions=record(capabilities.extensions),access=record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult={...value,capabilities:{...capabilities,extensions:{...extensions,
          "opencraft/token-usage":{version:1,query:true,configure:true,policyVersion:"equal-turn-v1",timezone:"Asia/Shanghai"},
          ...(Array.isArray(access.methods)?{[OPENCRAFT_METHOD_ACCESS_EXTENSION]:{...access,methods:[...new Set([...access.methods,"opencraft/token-usage/query","opencraft/token-usage/configure"])]}}:{}),
        }}};
      }
      if (this.schedules) {
        const value = record(this.initializeResult), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
        const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult = { ...value, capabilities: { ...capabilities, extensions: { ...extensions,
          [CONVERSATION_SCHEDULES_EXTENSION]: { version: 1, target: "existing-thread", repeat: "fixed-interval", summary: true, calendar: true },
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, ...Object.values(CONVERSATION_SCHEDULES)])] } } : {}),
        } } };
      }
      if (this.recovery) {
        const value = record(this.initializeResult), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
        const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult = { ...value, capabilities: { ...capabilities, extensions: { ...extensions,
          [TURN_RECOVERY_EXTENSION]: { version: 1 },
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...access.methods, "opencraft/turn-recovery/read"] } } : {}),
        } } };
      }
      if (this.options.kind !== "remote") {
        const value = record(this.initializeResult), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
        const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
        this.initializeResult = { ...value, capabilities: { ...capabilities, extensions: { ...extensions,
          "opencraft/read-history": { version: 1, cancellation: true, itemDetails: true, imageResources: this.historyImageResourcesEnabled },
          "opencraft/execution-engines": { version: 1, defaultEngine: "codex", providers: [] },
          [CODEX_MAINTENANCE_EXTENSION]: CODEX_MAINTENANCE_CAPABILITY,
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, CODEX_MAINTENANCE_READ])] } } : {}),
        } } };
      }
      const sharedValue = record(this.initializeResult), sharedCaps = record(sharedValue.capabilities);
      const sharedExtensions = record(sharedCaps.extensions), sharedAccess = record(sharedExtensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
      this.initializeResult = { ...sharedValue, capabilities: { ...sharedCaps, extensions: { ...sharedExtensions,
        [SHARED_INTERACTIONS_EXTENSION]: { version: 1 },
        [SERVER_REQUEST_CANCELLATION_EXTENSION]: { version: 1 },
        ...(Array.isArray(sharedAccess.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...sharedAccess,
          methods: [...new Set([...sharedAccess.methods, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND])] } } : {}),
      } } };
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
    // A rejected handshake may already have consumed the router's one-shot
    // initialize slot. Retire that socket; only reconnect may initialize again.
    if ("error" in message) this.nativeCore?.resetConnection();
    if ("result" in message) {
      this.recovery?.wake(); this.providerRetry?.wake();
      this.schedules?.start();
      for (const threadId of this.queue?.pendingThreads() ?? []) this.scheduleQueueMaintenance(threadId);
      if (this.options.kind !== "remote") void this.discoverActiveGoals()
        .catch(error => this.diagnostic({ event: "goal-discovery-failed", reason: errorMessage(error) }));
    }
  }

  private readonly receivePhysicalLine = (line: string): void => {
    let message: RpcRecord;
    try { message = record(JSON.parse(line)); } catch { return; }
    const generation = record(message.__opencraftGeneration), fences = record(generation.fences);
    delete message.__opencraftGeneration;
    const executionIncarnation = typeof generation.generationId === "string" && Number.isSafeInteger(generation.incarnation)
      ? JSON.stringify([generation.generationId, generation.incarnation]) : this.nativeCore?.executionIncarnation;
    if (typeof generation.routingEpoch === "string" && fences.routingEpoch === generation.routingEpoch) this.applyGenerationFences(fences as unknown as import("@opencraft/account-pool-host").CodexGenerationFenceState);
    if (generation.routingEpoch === this.generationRoutingEpoch && typeof generation.threadId === "string" && typeof generation.generationId === "string") this.generationRoutes.set(generation.threadId, generation.generationId);
    if (generation.routingEpoch === this.generationRoutingEpoch && typeof generation.generationId === "string" && Number.isSafeInteger(generation.incarnation)) {
      const known = this.generationIncarnations.get(generation.generationId) ?? 0;
      if (Number(generation.incarnation) < known) return;
      this.generationIncarnations.set(generation.generationId, Number(generation.incarnation));
    }
    if (message.method === "turn/completed") {
      const threadId = string(record(message.params).threadId);
      const initial = this.sessionMcpInitial.get(threadId);
      if (initial?.inputId) { initial.reservation.cancel(); this.sessionMcpInitial.delete(threadId); }
    }
    if (message.method === "opencraft/codex/generation/lost") {
      const params = record(message.params), key = JSON.stringify([generation.routingEpoch, params.generationId, params.incarnation, params.connectionEpoch, params.reason, params.recoveryId]);
      if (generation.routingEpoch !== this.generationRoutingEpoch || this.generationLosses.has(key)) return;
      this.generationLosses.add(key);
      const candidates = new Set(Array.isArray(params.threadIds) ? params.threadIds.filter((id): id is string => typeof id === "string") : []);
      for (const call of this.nativeToolCalls.values()) if (candidates.has(call.threadId) || this.generationRoutes.get(call.threadId) === params.generationId) call.abort.abort();
      if (params.reason === "execution-environment-failed" || params.reason === "execution-environment-recovered") {
        this.observeExecutionFault({id: String(params.recoveryId ?? ""), generationId: String(params.generationId), incarnation: Number(params.incarnation),
          state: params.reason === "execution-environment-failed" ? "recovering" : "recovered"}, [...candidates]);
        return;
      }
      for (const id of candidates) this.humanInteractions.markSourceUnavailable(id);
      const affected = new Set([...this.activeTurns.keys(), ...this.nativeSubscribedThreads, ...this.activeGoalThreads,
        ...(this.queue?.pendingThreads() ?? []), ...(this.recovery?.pendingThreadIds() ?? [])]);
      for (const id of affected) if (candidates.has(id) || this.generationRoutes.get(id) === params.generationId) {
        if (this.executionBlocked(id) || this.recovery?.snapshot(id)?.handledReason === "execution_fault") continue;
        this.humanInteractions.markSourceUnavailable(id);
        this.durableCatalog?.observe("thread/unloaded", { threadId: id });
        this.executionLeases?.suspend(id);
        this.recovery?.lost(id); this.activeTurns.delete(id); this.nativeSubscribedThreads.delete(id); this.reconcileGenerationThread(id);
      }
      this.recovery?.wake(); this.providerRetry?.wake(); return;
    }
    if (message.error && this.options.executionEnvironment) message.error = this.options.executionEnvironment.redact(message.error);
    const id = responseId(message.id);
    if (id !== null) {
      const publications = this.pending.has(String(id)) ? this.pending : this.internalRequests;
      const publication = publications.get(String(id));
      if (publication && typeof message.method !== "string") {
        // Keep the original PendingRequest until the durable owner acknowledges.
        // Notifications have no subscribed client yet. Duplicate replies cannot
        // jump around the asynchronous confirmation or run it twice.
        if (publication.workspaceFinalizing) return;
        const finalize = publication.finalizeWorkspaceReceipt;
        if (finalize && ("result" in message || "error" in message)) {
          delete publication.finalizeWorkspaceReceipt;
          publication.workspaceFinalizing = true;
          const incarnation = this.sessionMcpGeneration;
          const deliver = (frame: string) => {
            if (publications.get(String(id)) !== publication || incarnation !== this.sessionMcpGeneration) return;
            publication.workspaceFinalizing = false;
            this.receivePhysicalLine(frame);
          };
          void Promise.resolve().then(() => finalize(structuredClone("error" in message ? { error: message.error } : { result: message.result }))).then(() => deliver(line), () => {
            deliver(JSON.stringify({ ...message, __opencraftGeneration: generation, result: undefined, error: { code: -32000,
              message: "error" in message ? "Workspace cleanup could not be confirmed" : publication.method === "thread/resume" ? "Conversation resumed, but workspace binding could not be confirmed" : "Conversation created, but workspace binding could not be confirmed",
              data: { resultUnknown: true, ...("error" in message ? {} : { threadId: string(record(record(message.result).thread).id) }) } } }));
          });
          return;
        }
      }
      const environment = this.environmentCreations.get(String(id));
      if (environment && typeof message.method !== "string") {
        this.environmentCreations.delete(String(id));
        const threadId = string(record(record(message.result).thread).id);
        if (threadId && !("error" in message)) {
          const scope = this.pending.get(String(id))?.environmentCreationScope ?? this.internalRequests.get(String(id))?.environmentCreationScope;
          try {
            if (scope) {
              this.options.executionEnvironment!.bindCreator(scope, threadId);
              environment.bindGitThread(threadId);
              if(this.internalRequests.has(String(id)))this.options.executionEnvironment!.bind('local-codex',threadId,scope.projectId);
            }
            this.executionEnvironments.set(threadId, environment); this.initialEnvironmentThreads.add(threadId);
          } catch {
            delete message.result;
            message.error = { code: -32000, message: 'Unable to bind task credentials' };
          }
        }
      }
      const creation = this.sessionMcpCreations.get(String(id));
      if (creation && typeof message.method !== "string") {
        this.sessionMcpCreations.delete(String(id));
        const threadId = string(record(record(message.result).thread).id);
        if (threadId && !("error" in message)) {
          // A replayed native allocation already has a durable credential binding.
          // Restore that exact binding; inserting a new one would both collide with
          // custody and install tools that the replayed native request never used.
          const operation = string(record(this.internalRequests.get(String(id))?.params ?? this.pending.get(String(id))?.params).__opencraftOrchestrationOperation);
          const generation = this.sessionMcpGeneration;
          void this.adoptCreationMcp(threadId, creation, !!operation).then(() => {
            if (generation !== this.sessionMcpGeneration) throw new Error("Creation capability belongs to an expired connection");
            this.receivePhysicalLine(line);
          }).catch(() => {
            // A positive native allocation is not undone by a local binding error.
            // Contain the callback failure instead of crashing the entire Gateway.
            this.receivePhysicalLine(JSON.stringify({ ...message, result: undefined,
              error: { code: -32000, message: "Creation capability outcome is unconfirmed", data: { resultUnknown: true } } }));
          });
          return;
        }
        else creation.cancel();
      }
      const internal = this.internalRequests.get(String(id));
      if (internal && typeof message.method !== "string") {
        this.internalRequests.delete(String(id));
        clearTimeout(internal.timer);
        if (internal.method === "thread/unsubscribe") {
          const status = string(record(message.result).status);
          this.nativeUnloadDiagnostic(internal.threadId, "unsubscribe-reply", {
            requestId: String(id),
            status: "error" in message ? "rpc-error"
              : ["unsubscribed", "notSubscribed", "notLoaded"].includes(status) ? status : "unknown",
          });
        }
        this.observeExecutionReply(internal.method, internal.params, message, executionIncarnation);
        this.observeUsageAttempt(internal.usageAttemptId,internal.method,internal.params,message);
        if(internal.method==="turn/start" && "error" in message && [-32600,-32601,-32602].includes(Number(record(message.error).code)))this.retireGatewayAdmission(internal.params,true);
        if ("error" in message) {
          const error = this.rpcError(record(message.error));
          internal.reject(internal.recoveryAdmission || record(record(message.error).data).notSubmitted === true
            ? new RecoveryNotSubmitted(errorMessage(error), {cause: error}) : error);
        }
        else {
          if (internal.threadId && !this.threadTitles?.owns(internal.threadId) && (internal.method === "thread/resume" || internal.method === "turn/start")) {
            this.nativeSubscribedThreads.add(internal.threadId);
            this.cancelNativeRelease(internal.threadId);
          }
          if (internal.method === "turn/start" || internal.method === "turn/steer") this.options.collaboration?.started(string(internal.params.threadId),string(internal.params.clientUserMessageId),string(record(record(message.result).turn).id)||string(record(message.result).turnId));
          this.observeUsageAcceptance(internal.method,internal.params,message.result);
          this.observeMetadataResult(internal.method, internal.params, message.result);
          if (internal.method === "thread/start")
            void this.materializeCreation(message.result, internal.params).then(() => internal.resolve(message.result), internal.reject);
          else internal.resolve(message.result);
        }
        // Metering metadata reads may have held the Host demand guard when a
        // turn completed. Re-evaluate release after the last internal RPC ends.
        this.scheduleNativeRelease(internal.threadId);
        return;
      }
      const pending = this.pending.get(String(id));
      if (pending !== undefined && typeof message.method !== "string") {
        if (isThreadGoalPauseRequest(pending.method, pending.params)) this.diagnostic({
          event: "goal-pause-native-reply", threadId: string(pending.params.threadId), requestId: String(id),
          outcome: "error" in message ? "rpc-error" : "acknowledged",
          ...("error" in message ? { rpcCode: record(message.error).code } : { status: record(record(message.result).goal).status }),
        });
        const gatewayPath=configuredModelGatewayPath();
        if(pending.method==="model/list" && gatewayPath && Array.isArray(record(message.result).data)) {
          const filter = this.options.filterGatewayModelCatalog;
          if (filter) {
            const generation = this.sessionMcpGeneration, routing = this.generationRoutingEpoch;
            const result = record(message.result);
            this.pending.delete(String(id));
            if (pending.timer) clearTimeout(pending.timer);
            const failure = () => {
              if (this.validClientRequest(pending)) this.emit({ id: pending.originalId,
                error: { code: -32043, message: "Model catalog is unavailable" } }, pending.clientId);
            };
            let actor: string | null;
            try { actor = pending.gatewayViewer?.() ?? null; }
            catch { failure(); return; }
            void filter(gatewayPath, actor, result.data as unknown[]).then(data => {
              if (!this.validClientRequest(pending)) return;
              if (generation !== this.sessionMcpGeneration || routing !== this.generationRoutingEpoch
                || (pending.gatewayViewer?.() ?? null) !== actor) { failure(); return; }
              this.emit({ ...message, id: pending.originalId, result: { ...result, data } }, pending.clientId, pending.method);
            }).catch(failure);
            return;
          }
          const ledger=new ModelGatewayStore(gatewayPath);
          try { const actor=pending.gatewayViewer?.()??null;
            message={...message,result:{...record(message.result),data:(record(message.result).data as unknown[]).filter(item=>{
              const id=string(record(item).model)||string(record(item).id);
              if(!id.startsWith("configured/"))return true;
              try{return ledger.canUse(decodeURIComponent(id.slice("configured/".length).split("/")[0]!),actor);}catch{return false;}
            })}};
          }finally{ledger.close();}
        }
        if (gatewayPath && pending.modelCreator && 'result' in message && !('error' in message)) {
          const createdThread = record(record(message.result).thread), createdId = string(createdThread.id);
          const model = string(record(message.result).model) || string(createdThread.model) || string(pending.params.model);
          if (createdId && requiresModelGateway(model, gatewayPath)) {
            try {
              const creator = pending.modelCreator();
              if (creator) {
                const ledger = new ModelGatewayStore(gatewayPath);
                try { ledger.bindConversationModel(createdId, creator, model); } finally { ledger.close(); }
              }
            } catch {
              // Native allocation already succeeded. Do not label this safe to
              // resend, lose its identity, or grant credentials to a later reader.
              this.diagnostic({ event: 'conversation-model-binding-failed', threadId: createdId });
              message = { id: message.id, error: { code: -32000,
                message: 'Conversation created, but model authorization could not be confirmed',
                data: { resultUnknown: true, threadId: createdId } } };
            }
          }
        }
        const receivedAt = performance.now();
        this.pending.delete(String(id));
        if (pending.timer) clearTimeout(pending.timer);
        this.observeExecutionReply(pending.method, pending.params, message, executionIncarnation);
        this.observeUsageAttempt(pending.usageAttemptId,pending.method,pending.params,message);
        if(pending.method==="turn/start" && "error" in message && [-32600,-32601,-32602].includes(Number(record(message.error).code)))this.retireGatewayAdmission(pending.params,true);
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
            this.nativeCore?.resetConnection();
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
        if ('error' in message && pending.executionAuthorityAdmitted) this.options.executionAuthority?.rejected(string(pending.params.threadId), string(pending.params.clientUserMessageId));
        if ("result" in message) {
          if (pending.method === "turn/start" || pending.method === "turn/steer") this.options.collaboration?.started(string(pending.params.threadId),string(pending.params.clientUserMessageId),string(record(record(message.result).turn).id)||string(record(message.result).turnId));
          if (pending.executionAuthorityAdmitted) this.options.executionAuthority?.started(string(pending.params.threadId), string(pending.params.clientUserMessageId), string(record(record(message.result).turn).id) || string(record(message.result).turnId));
          this.observeUsageAcceptance(pending.method,pending.params,message.result);
          if (pending.method === "thread/goal/get" || pending.method === "thread/goal/set") {
            this.noteGoal(string(pending.params.threadId), record(message.result).goal);
          } else if (pending.method === "thread/goal/clear" && record(message.result).cleared === true) {
            this.noteGoal(string(pending.params.threadId), null);
          }
          if (pending.method === "thread/fork") {
            const source=string(pending.params.threadId),target=string(record(record(message.result).thread).id);
            this.messageAttachments?.cloneThread(source,target);
            if (source && target && this.attachmentStaging instanceof LocalAttachmentStagingService)
              this.attachmentStaging.catalog.cloneReferences(JSON.stringify(['thread',source]),JSON.stringify(['thread',target]));
          }
          this.noteNativeSubscription(pending, message.result);
          this.commitThreadSubscription(pending, message.result);
          if (pending.method === "thread/archive" || pending.method === "thread/delete") this.schedules?.suspend(string(pending.params.threadId));
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
          requestId: String(id),
          threadId: string(pending.params.threadId),
          outcome: "result" in message ? "succeeded" : "failed", pid: this.child?.pid ?? null,
        });
        if ("result" in message) this.observeMetadataResult(pending.method, pending.params, message.result, pending.metadataSender);
        if (pending.method === "thread/list" && "result" in message) message.result = this.catalogChanges.projectList(pending.params, message.result);
        if ("result" in message) message = { ...message, result: projectThreadMessageResult(
          this.projectSender, pending.method, pending.params, message.result, { trustedSubmissionSender: !!this.messageSenders }) };
        if (pending.historyTiming) {
          const trace = pending.historyTiming, nativeRpcMs = receivedAt - (trace.nativeStarted ?? trace.started);
          const timing = { pairId: trace.pairId, coreMs: performance.now() - trace.started,
            nativeRpcMs, nativeRpcCount: 1, projectionMs: performance.now() - receivedAt,
            ...(pending.method === "thread/read" ? { metadataMs: nativeRpcMs } : {}) };
          this.historyDiagnostic({ event: "history-native-rpc", pairId: trace.pairId, requestId: String(id), method: pending.method, nativeRpcMs,
            ...(typeof pending.params.limit === "number" ? { limit: pending.params.limit } : {}) });
          this.historyDiagnostic({ event: "history-read-stages", method: pending.method, outcome: "result" in message ? "ok" : "failed", ...timing });
          if ("result" in message) message = { ...message, result: { ...record(message.result), __opencraftHistoryTiming: timing } };
        }
        const emitReply = () => { if (this.validClientRequest(pending)) this.emit({
          ...message,
          ...(this.messageAttachments && "result" in message ? {
            result: projectThreadAttachmentResult(this.messageAttachments, pending.method, pending.params, message.result),
          } : {}),
          id: pending.originalId,
        }, pending.clientId, pending.method); };
        if ("result" in message && ["thread/archive", "thread/delete"].includes(pending.method) && this.transcriptCache)
          void this.transcriptCache.invalidate(string(pending.params.threadId)).then(emitReply, () => {
            if (this.validClientRequest(pending)) this.emit({ id: pending.originalId, error: { code: -32000, message: "Transcript cleanup failed" } }, pending.clientId);
          });
        else if ("result" in message && pending.method === "thread/start")
          void this.materializeCreation(message.result, pending.params).then(emitReply, () => {
            if (this.validClientRequest(pending)) this.emit({ id: pending.originalId,
              error: { code: -32000, message: "Could not create this conversation" } }, pending.clientId);
          });
        else emitReply();
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
    nodeObserver(this.options.observationComponent ?? 'gateway').execution('codex', String(message.method), message.params);
    const threadId = string(record(message.params).threadId) || string(record(record(message.params).thread).id);
    try { this.tokenUsage?.notification(string(message.method),record(message.params)); } catch { this.diagnostic({event:"token-usage-partial",category:"notification"}); }
    if (["item/started", "item/completed"].includes(string(message.method))) {
      const p = record(message.params), item = record(p.item);
      if (message.method === "item/completed") this.captureArtifactOutput(threadId,item,string(p.turnId));
      if (item.type === "userMessage" && item.__opencraftMessageKind !== "steering") {
        const inputId = string(item.clientId) || string(item.clientUserMessageId) || string(item.client_id);
        if (inputId) {
          this.executionLeases?.observedInput(threadId, string(p.turnId), inputId);
          if (this.queue?.findByClientId(threadId,inputId)) this.queue.deliveries.recorded(threadId,inputId);
        }
      }
    }
    if (this.threadTitles?.notification(string(message.method), record(message.params))) return;
    this.catalogChanges.observeNotification(string(message.method), message.params);
    this.durableCatalog?.observe(string(message.method), message.params);
    if (message.method === "thread/archived" || message.method === "thread/deleted") {
      this.schedules?.suspend(threadId);
      void this.transcriptCache?.invalidate(threadId).catch(() => this.diagnostic({ event: "thread-cache-cleanup-failed" }));
    }
    if (message.method === "turn/started" && threadId) {
      this.initialEnvironmentThreads.delete(threadId);
      const turnId = string(record(record(message.params).turn).id);
      if (turnId) this.executionLeases?.observedStart(threadId, turnId, executionIncarnation);
      if (turnId) this.activeTurns.set(threadId, turnId);
      const gatewayPath=configuredModelGatewayPath();
      if(gatewayPath && turnId){const ledger=new ModelGatewayStore(gatewayPath);try{if(ledger.execution(threadId)?.state==='active')ledger.startedExecution(threadId,turnId);}finally{ledger.close();}}
      if (!this.ephemeralThreads.has(threadId) && !this.threadTitles?.owns(threadId)) this.recovery?.started(threadId, turnId);
      if (turnId) this.options.collaboration?.orchestration?.observed({threadId,turnId,rootTurnId:this.recovery?.snapshot(threadId)?.rootTurnId??turnId,state:"active"});
      this.providerRetry?.started(threadId, turnId);
    }
    if (message.method === "turn/completed" && threadId) {
      const turn = record(record(message.params).turn);
      const endedId = string(turn.id);
      if (this.activeTurns.get(threadId) === endedId) this.activeTurns.delete(threadId);
      if (this.queue?.deliveries.finish(threadId,endedId,string(turn.status))) this.emitQueueChanged(threadId);
      const gatewayPath=configuredModelGatewayPath();
      if(gatewayPath) {const ledger=new ModelGatewayStore(gatewayPath);try {if(string(turn.id))ledger.finishedExecution(threadId,string(turn.id));}finally{ledger.close();}}
      if (['completed', 'failed', 'interrupted'].includes(string(turn.status))) this.cancelTurnTools(threadId, string(turn.id));
      this.humanInteractions.resolveTurn(threadId, string(turn.id));
      this.executionLeases?.finished(threadId, string(turn.id));
      this.options.executionAuthority?.ended(threadId, string(turn.id));
      this.recovery?.finished(threadId, string(turn.id));
      const recovery = this.recovery?.snapshot(threadId);
      if ((!recovery || recovery.turnId===string(turn.id)) && (!recovery || !["interrupted", "preparing", "dispatching"].includes(recovery.state))) this.options.collaboration?.orchestration?.observed({
        threadId, turnId: string(turn.id) || null, rootTurnId: recovery?.rootTurnId ?? (string(turn.id) || null),
        state: turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : recovery?.handledReason === "user_stop" ? "interrupted_by_user" : "unconfirmed",
        summary: (Array.isArray(turn.items) ? turn.items : []).map(record).filter(item => item.type === "agentMessage").map(item => string(item.text)).join("\n").slice(-4096),
      });
      if (["completed", "failed", "interrupted"].includes(string(turn.status))) for (const listener of this.scheduleObservers) listener({
        threadId, turnId: string(turn.id), state: turn.status === "completed" && !turn.error ? "completed" : "failed",
      });
      if (turn.status === "failed") void this.scheduleProviderFailure(threadId, string(turn.id), turn.error);
      else this.providerRetry?.finished(threadId, string(turn.id));
      this.scheduleQueueMaintenance(threadId);
      if (!record(record(message.params).turn).error) this.scheduleGoalContinuation(threadId);
      this.scheduleNativeRelease(threadId);
    }
    if (message.method === "thread/status/changed" && threadId && record(record(message.params).status).type === "idle") {
      this.activeTurns.delete(threadId);
      this.scheduleQueueMaintenance(threadId);
      this.scheduleNativeRelease(threadId);
    }
    if (threadId && (message.method === "thread/unloaded" || message.method === "thread/closed"
      || message.method === "thread/status/changed" && record(record(message.params).status).type === "notLoaded")) {
      this.nativeUnloadDiagnostic(threadId, "notification", { method: message.method });
    }
    if ((message.method === "thread/archived" || message.method === "thread/deleted") && threadId) this.providerRetry?.handled(threadId);
    if (message.method === "serverRequest/resolved") {
      const rawId = responseId(record(message.params).requestId);
      if (rawId !== null) this.humanInteractions.resolveNative(rawId, threadId);
      const requestId = responseId(record(message.params).requestId);
      if (requestId !== null) {
        const key = JSON.stringify(requestId);
        const nativeCall = this.nativeToolCalls.get(key);
        if (nativeCall?.threadId === threadId) nativeCall.abort.abort();
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
    if (this.messageSenders) message = projectThreadMessageNotification(this.projectSender, message);
    if (this.messageAttachments) message = projectThreadAttachmentNotification(this.messageAttachments, message);
    const targets = threadId ? this.threadTargets(threadId) : [];
    if (threadId && targets.length === 0) return;
    if (targets.length === 0) this.emit(message);
    else for (const target of targets) this.emit(message, target);
  };

  private observeUsageAttempt(attemptId:string|undefined,method:string,params:RpcRecord,message:RpcRecord):void {
    if(!attemptId)return;
    if("error" in message){
      const error=this.rpcError(record(message.error));
      const rejected=method==="turn/steer"?this.definitiveSteerRejection(error):[-32600,-32601,-32602].includes(error.code);
      this.tokenUsage?.attemptOutcome(attemptId,rejected?"rejected":"unknown");
      return;
    }
    const result=record(message.result),turnId=method==="turn/start"?string(record(result.turn).id):string(result.turnId)||string(record(result.turn).id);
    const accepted=turnId&&(method!=="turn/steer"||turnId===string(params.expectedTurnId));
    this.tokenUsage?.attemptOutcome(attemptId,accepted?"accepted":"unknown",accepted?turnId:null);
  }
  private observeUsageAcceptance(method: string, params: RpcRecord, result: unknown): void {
    if (method !== "turn/start" && method !== "turn/steer") return;
    const turnId=method === "turn/start" ? string(record(record(result).turn).id) : string(record(result).turnId)||string(record(record(result).turn).id);
    if (!turnId || (method === "turn/steer" && turnId !== string(params.expectedTurnId))) return;
    try { this.tokenUsage?.admission({threadId:string(params.threadId),turnId},string(params.clientUserMessageId)); }
    catch { this.diagnostic({event:"token-usage-partial",category:"acceptance"}); }
  }

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
    } else if (pending.method === "thread/read" && pending.params.watch === true) {
      // Reading may observe an already-running stream, but never owns its
      // execution or pending interactions and never loads a native engine.
      this.watchHistory(string(pending.params.threadId), pending.clientId);
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
    if(pending.method==="thread/resume")this.tokenUsage?.threadLoaded(string(record(record(result).thread).id));
    if(pending.method==="thread/start")try{this.tokenUsage?.threadStarted(result);}catch{this.diagnostic({event:"token-usage-partial",category:"ephemeral-baseline"});}
    this.cancelNativeRelease(threadId);
  }

  private receiveServerRequest(id: string | number, message: RpcRecord): void {
    nodeObserver(this.options.observationComponent??'gateway').execution('codex',String(message.method),message.params);
    if (message.method === "account/chatgptAuthTokens/refresh" && this.poolAuth !== null) {
      const { type: _type, ...result } = this.poolAuth;
      void this.writePhysical({ id, result })?.catch(() => undefined);
      return;
    }
    if (this.threadTitles?.owns(string(record(message.params).threadId))) {
      void this.writePhysical({ id, error: { code: -32601, message: "Title generation does not support tools or user interaction" } })?.catch(() => undefined);
      return;
    }
    const params = record(message.params);
    if (message.method === 'item/tool/call' && this.options.nativeTool) {
      const key = JSON.stringify(id);
      if (this.nativeToolCalls.has(key)) return;
      if (this.nativeToolCalls.size >= MAX_PENDING_SERVER_REQUESTS) {
        void this.writePhysical({ id, error: { code: -32000, message: 'Too many pending native tools' } }).catch(() => {}); return;
      }
      const context = { threadId: string(params.threadId), turnId: string(params.turnId), callId: string(params.callId) };
      const abort = new AbortController();
      let operation: Promise<unknown> | null;
      try { operation = this.options.nativeTool(context, { namespace: typeof params.namespace === 'string' ? params.namespace : null, name: string(params.tool) }, params.arguments, abort.signal); }
      catch (error) { operation = Promise.reject(error); }
      if (operation !== null) {
        const custody = { ...context, abort }; this.nativeToolCalls.set(key, custody);
        const respond = (result: unknown) => {
          if (this.nativeToolCalls.get(key) !== custody || abort.signal.aborted || this.statusValue.state !== 'open') return;
          return this.writePhysical({ id, ...(message.__opencraftCallbackIncarnation ? {
            __opencraftCallbackIncarnation: message.__opencraftCallbackIncarnation,
            __opencraftToolCallKey: message.__opencraftToolCallKey,
          } : {}), result });
        };
        void operation.then(respond, () => respond({ success: false, contentItems: [{ type: 'inputText', text: 'Tool execution unavailable or unauthorized. Inspect the existing result before retrying.' }] }))
          .catch(() => {}).finally(() => {
            if (this.nativeToolCalls.get(key) === custody) {
              this.nativeToolCalls.delete(key); this.scheduleNativeRelease(context.threadId);
            }
          });
        return;
      }
    }
    if (message.method === "item/tool/call" && [...CONVERSATION_TOOLS, ...THREAD_ORCHESTRATION_TOOLS].some(t=>t.name===params.tool) && (params.namespace === undefined || params.namespace === null || params.namespace === "")) {
      const key=String(id),token=Symbol(key);
      if(this.collaborationCalls.has(key)) return;
      if(this.collaborationCalls.size>=16) {void this.writePhysical({id,...(message.__opencraftCallbackIncarnation?{__opencraftCallbackIncarnation:message.__opencraftCallbackIncarnation,__opencraftToolCallKey:message.__opencraftToolCallKey}:{}),result:{success:false,contentItems:[{type:"inputText",text:"Conversation tool limit exceeded"}]}})?.catch(()=>{});return;}
      this.collaborationCalls.set(key,token);
      const respond = (success: boolean, value: unknown) => {
        if(this.collaborationCalls.get(key)!==token || this.statusValue.state!=="open" || this.options.collaboration?.orchestration?.available?.()===false)return;
        return this.writePhysical({id,...(message.__opencraftCallbackIncarnation ? {__opencraftCallbackIncarnation:message.__opencraftCallbackIncarnation,__opencraftToolCallKey:message.__opencraftToolCallKey} : {}),result:{success,contentItems:[{type:"inputText",text:JSON.stringify(value)}]}});
      };
      void Promise.resolve().then(()=>{
        if (!this.options.collaboration) throw new Error("Conversation tools unavailable");
        if (THREAD_ORCHESTRATION_TOOLS.some(tool=>tool.name===params.tool) || message.__opencraftToolCallKey && this.options.collaboration.orchestration) {
          if (!this.nativeCore || !this.options.collaboration.orchestration || !message.__opencraftToolCallKey || !message.__opencraftCallbackIncarnation) throw new OrchestrationControlError(503,"Thread orchestration requires an independent callback-capable Engine Host");
          if (!message.__opencraftDelegationId) throw new OrchestrationControlError(403,"A bounded user delegation is required");
          return this.options.collaboration.orchestration.tool(string(params.threadId),string(params.turnId),string(message.__opencraftToolCallKey),string(params.tool),record(params.arguments),string(message.__opencraftDelegationId)||undefined,string(message.__opencraftCallbackIncarnation)||undefined);
        }
        return this.options.collaboration.tool(string(params.threadId),string(params.turnId),string(params.tool),record(params.arguments));
      }).then(value=>respond(true,value),(error:unknown)=>{
        const status=typeof record(error).status==="number"?record(error).status:error instanceof OrchestrationControlError?error.code:503;
        if (record(error).code === "thread_title_required") {
          return respond(false,{error:"A nonblank, single-line title of at most 256 characters is required.",status});
        }
        const historyTooLarge = record(error).code === "HISTORY_RESPONSE_TOO_LARGE";
        if (historyTooLarge) {
          this.diagnostic({event:"thread-orchestration-tool-failed",threadId:string(params.threadId),turnId:string(params.turnId),tool:string(params.tool),status:413,code:"HISTORY_RESPONSE_TOO_LARGE"});
          return respond(false,{error:"A history item exceeds the bounded read size limit.",status:413,code:"HISTORY_RESPONSE_TOO_LARGE",retryable:false});
        }
        const conflict = record(error).code === "idempotency_key_reused";
        this.diagnostic({event:"thread-orchestration-tool-failed",threadId:string(params.threadId),turnId:string(params.turnId),tool:string(params.tool),status,...(conflict ? {code:"idempotency_key_reused"} : {})});
        return respond(false,{error:conflict ? "Idempotency key was reused with different input. Inspect the original receipt; a retry must preserve the exact original payload." : "Conversation operation unavailable or unauthorized. Inspect the original receipt before retrying.",status,...(conflict ? {code:"idempotency_key_reused"} : {})});
      }).catch(()=>{}).finally(()=>{if(this.collaborationCalls.get(key)===token)this.collaborationCalls.delete(key);});
      return;
    }
    if (isHumanInteraction(message.method, message.params)) {
      const threadId = string(record(message.params).threadId);
      if (!threadId) return;
      try { this.humanInteractions.capture(message as unknown as InteractionSourceRequest); }
      catch { void this.writePhysical({ id, error: { code: -32083, message: "Interaction source could not be admitted" } }).catch(() => {}); return; }
      for (const viewer of this.threadClients.get(threadId) ?? []) if (!this.sharedInteractionClients.has(viewer))
        this.humanInteractions.offerLegacy(threadId, viewer, source => this.emit(source as unknown as RpcRecord, viewer));
      return;
    }
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
    this.publishHumanInteractions(threadId, clientId);
    if (!this.sharedInteractionClients.has(clientId)) this.humanInteractions.offerLegacy(threadId, clientId, source => this.emit(source as unknown as RpcRecord, clientId));
    const current = this.threadInteractionOwners.get(threadId);
    if (current && current !== clientId && this.initializedClients.has(current)) return;
    this.threadInteractionOwners.set(threadId, clientId);
    for (const request of this.serverRequests.values()) {
      if (request.cancelled || request.threadId !== threadId || request.ownerClientId !== null) continue;
      request.ownerClientId = clientId;
      this.emit(request.message, clientId);
    }
  }

  private cancelTurnTools(threadId: string, turnId: string): void {
    if (!threadId || !turnId) return;
    for (const call of this.nativeToolCalls.values()) if (call.threadId === threadId && call.turnId === turnId) call.abort.abort();
    for (const request of this.serverRequests.values()) {
      const params = record(request.message.params);
      if (request.cancelled || request.message.method !== 'item/tool/call' || request.threadId !== threadId || params.turnId !== turnId) continue;
      request.cancelled = true;
      // Keep ownership/correlation until the handler physically settles. A
      // cancelled callback must never be offered to a successor renderer.
      if (request.ownerClientId !== null && this.initializedClients.has(request.ownerClientId))
        this.emit({ method: SERVER_REQUEST_CANCEL, params: { requestId: request.message.id, threadId } }, request.ownerClientId);
    }
  }

  private releaseServerRequests(clientId: string, threadId?: string): void {
    this.humanInteractions.forgetClient(clientId, threadId);
    for (const request of this.serverRequests.values()) {
      if (request.ownerClientId === clientId && (threadId === undefined || request.threadId === threadId)) {
        if (request.message.method === 'item/tool/call') {
          // A view subscription is not provider custody. While its original
          // client is live, let that handler finish even after the view leaves.
          // On transport loss there is no proof it did not execute: retain an
          // uncertain, non-transferable correlation until native resolves it.
          if (!this.initializedClients.has(clientId)) {
            request.cancelled = true;
            request.ownerClientId = null;
          }
          continue;
        }
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
    for (const id of this.historyWatchers.get(threadId) ?? []) targets.add(id);
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
    for (const [read, readingThread] of this.cachedHistoryReads.get(clientId) ?? []) {
      if (readingThread === threadId) read.abort(new Error("History reader unsubscribed"));
    }
    const clients = this.threadClients.get(threadId);
    const watchers = this.historyWatchers.get(threadId);
    watchers?.delete(clientId);
    if (watchers?.size === 0) this.historyWatchers.delete(threadId);
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
    if (this.providerRetry?.pendingThreadIds().includes(threadId)) return true;
    if (this.activeTurns.has(threadId) || this.queue?.firstUnsettled(threadId) != null) return true;
    if (this.humanInteractions.hasThread(threadId) || [...this.serverRequests.values()].some(request => request.threadId === threadId)) return true;
    if ([...this.nativeToolCalls.values()].some(call => call.threadId === threadId)) return true;
    if ([...this.pending.values()].some(request => request.params.threadId === threadId
      && (request.method === "turn/start" || request.method === "turn/steer"))) return true;
    return [...this.internalRequests.values()].some(request => request.threadId === threadId);
  }

  private canReleaseNativeSubscription(threadId: string): boolean {
    return this.statusValue.state === "open" && this.nativeSubscribedThreads.has(threadId)
      && (this.threadClients.get(threadId)?.size ?? 0) === 0
      && ![...this.pending.values()].some(request => request.params.threadId === threadId
        && (request.method === "thread/resume" || request.method === "turn/start") && this.validClientRequest(request))
      && !this.hasHostThreadDemand(threadId)
      && !["created", "attempted"].includes(this.provisionalThreads?.get(threadId)?.phase ?? "");
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

  private watchHistory(threadId: string, clientId: string): void {
    if (!threadId) return;
    let clients = this.historyWatchers.get(threadId);
    if (!clients) { clients = new Set(); this.historyWatchers.set(threadId, clients); }
    clients.add(clientId);
    this.publishHumanInteractions(threadId, clientId);
  }

  private subscribeThread(threadId: string, clientId: string): void {
    if (!threadId) return;
    this.cancelNativeRelease(threadId);
    let clients = this.threadClients.get(threadId);
    if (clients === undefined) { clients = new Set(); this.threadClients.set(threadId, clients); }
    clients.add(clientId);
  }

  private disconnectClient(clientId: string): void {
    for(const [controller,owner] of this.artifactReaders)if(owner===clientId)controller.abort();
    for (const read of this.cachedHistoryReads.get(clientId)?.keys() ?? []) read.abort(new Error("History reader disconnected"));
    this.cachedHistoryReads.delete(clientId);
    for (const [threadId, clients] of this.historyWatchers) {
      clients.delete(clientId);
      if (clients.size === 0) this.historyWatchers.delete(threadId);
    }
    this.desktopService?.revoke(this.desktopOwnerKey(clientId, this.clientEpoch(clientId)));
    this.clientEpochs.delete(clientId);
    this.initializedClients.delete(clientId);
    this.sharedInteractionClients.delete(clientId);
    const affected = new Set<string>();
    for (const [threadId, clients] of this.threadClients) {
      if (clients.delete(clientId)) affected.add(threadId);
      if (clients.size === 0) this.threadClients.delete(threadId);
    }
    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== clientId || (pending.method !== "thread/resume" && pending.method !== "turn/start")) continue;
      pending.invalidated = true;
      if (pending.method === "thread/resume") this.diagnostic({
        event: "thread-resume-stage", clientId, requestId, threadId: string(pending.params.threadId),
        stage: "native-reply", outcome: "client-disconnected",
      });
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
          // A bridge Thread is read by its native session; the binding keeps its public identity.
          const nativeId = this.externalThreadIdentities?.toNative(threadId) ?? threadId;
          const response = record(await this.requestPhysical("thread/read", { threadId: nativeId, includeTurns: false }, 5_000));
          const thread = record(response.thread);
          if (thread.id !== nativeId || typeof thread.path !== "string" || typeof thread.createdAt !== "number") throw new Error();
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
    const epoch = this.clientEpoch(clientId);
    try {
      if (String(message.method).startsWith("opencraft/codex/accounts/personal/")) throw Error("Personal subscriptions require the authenticated settings endpoint");
      if (this.nativeCore) {
        const result = await this.nativeCore.control.accountRequest(string(message.method), record(message.params));
        if (this.statusValue.state === "open" && epoch === this.clientEpoch(clientId)) this.emit({ id, result }, clientId);
        return;
      }
      const store = this.poolStore;
      const login = this.login;
      const refresh = this.refresh;
      const subscriptions = this.subscriptions;
      if (store === null || login === null || refresh === null || subscriptions === null) throw new Error("Codex account service is unavailable");
      const params = record(message.params);
      let result: unknown;
      switch (message.method) {
        case "opencraft/codex/accounts/resetCredits/list":
          if (!this.resetCreditService) throw new Error("Reset credits are unavailable");
          result = await this.resetCreditService.list(string(params.accountId)); break;
        case "opencraft/codex/accounts/resetCredits/consume": {
          if (!this.resetCreditService) throw new Error("Reset credits are unavailable");
          const consumed = await this.resetCreditService.consume({ accountId: string(params.accountId), creditId: string(params.creditId),
            idempotencyKey: string(params.idempotencyKey), confirmed: params.confirmed });
          result = { ...consumed, accounts: this.accountViews(store) }; break;
        }
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
      const failure = error instanceof CodexAccountOperationError ? error : classifyAccountFailure(error, "operation");
      logAccountFailure(failure, { operation: string(message.method) });
      if (this.statusValue.state === "open" && epoch === this.clientEpoch(clientId)) {
        this.emit({ id, error: { code: -32020, message: failure.message, data: { codexAccountFailure: failure.diagnostic } } }, clientId);
      }
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
        credentialSource: account.credentialSource,
        email: state.email,
        subscriptionType: state.subscriptionType,
        rateLimitTier: state.rateLimitTier,
        resetCredits: state.resetCredits,
        resetCreditActions: true,
        credits: accountCreditStatus(state.limitWindows),
        status: state.status,
        maintenance: store.accountMaintenance(account.id),
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

  private rpcError(error: RpcRecord): OpenCraftQueueRpcError {
    return new OpenCraftQueueRpcError(typeof error.code === "number" ? error.code : -32000,
      string(error.message) || "Codex AppServer request failed", error.data);
  }

  private async resolvePermissionSelection(selection: string, cwd: unknown): Promise<RpcRecord> {
    const mode = parsePermissionModeProfileId(selection);
    if (mode === null) return { permissions: selection };
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
        // Native profiles select sandbox permissions independently of approvals.
        // Product modes bind both controls, including when leaving Full access.
        return { permissions: string(profile.id), approvalPolicy: mode === "full" ? "never" : "on-request" };
      }
      if (result.nextCursor == null) break;
      if (typeof result.nextCursor !== "string" || result.nextCursor === cursor) throw new Error("Codex permission catalog did not advance");
      cursor = result.nextCursor;
    }
    throw new Error(`Permission mode is unavailable on this Codex Host: ${mode}`);
  }

  private async admitModelExecution(mode: "start" | "steer", params: RpcRecord, context?: TransportSubmissionContext) {
    const path=configuredModelGatewayPath();if(!path)return;
    const threadId=string(params.threadId),inputId=string(params.clientUserMessageId);
    const resolveAuthority=():{authorizer:string;executor:string|null;expiresAt:number;authorityId?:string;parentAuthorityId?:string}=> {
      context?.resourceOwner?.assertCurrent();
      if(this.options.collaboration?.modelExecutionAuthority) return this.options.collaboration.modelExecutionAuthority(threadId,inputId);
      const actor=context?.actorContext ? (this.options.modelActor ?? this.options.tokenUsage?.actor)?.(context.actorContext):null;
      if(actor?.kind!=="human" || !context?.actorContext || context.actorContext.expiresAt<=Date.now())throw new ModelGatewayError("gateway_execution_required",403);
      return {authorizer:actor.id,executor:null,expiresAt:Math.min(context.actorContext.expiresAt,Date.now()+86_400_000)};
    };
    const thread=mode==="start" ? record(record(await this.requestPhysical("thread/read",{threadId,includeTurns:false})).thread):{};
    const store=new ModelGatewayStore(path);
    try {
      const model=string(record(record(params.collaborationMode).settings).model)||string(params.model)||string(thread.model);
      if(mode==='start'&&!requiresModelGateway(model,path)&&store.execution(threadId)?.state==='active')throw new ModelGatewayError('gateway_execution_busy',409);
      if(mode==="start"&&!requiresModelGateway(model,path) || mode==="steer"&&store.execution(threadId)?.state!=='active') {
        this.gatewayChecks.set(JSON.stringify([threadId,inputId]),()=>{});return;
      }
      const authority=resolveAuthority();
      if (mode === "steer") {
        const sharedInput = this.options.sharedTurnInput === true;
        const execution = store.execution(threadId)!;
        if (sharedInput) store.steerSharedExecution(threadId, execution.id);
        else store.steerExecution(threadId, authority.authorizer);
        this.gatewayChecks.set(JSON.stringify([threadId,inputId]), () => {
          if (resolveAuthority().authorizer !== authority.authorizer)
            throw new ModelGatewayError("gateway_execution_changed", 403);
          const current = new ModelGatewayStore(path);
          try {
            if (sharedInput) current.steerSharedExecution(threadId, execution.id);
            else current.steerExecution(threadId, authority.authorizer);
          } finally { current.close(); }
        });
        return;
      }
      if(!model)throw new ModelGatewayError("gateway_execution_model_required",403);
      // Never derive spending permission from a parent Thread or analytics record.
      const id=JSON.stringify([threadId,inputId]);
      if(this.activeTurns.has(threadId))throw new ModelGatewayError("gateway_execution_busy",409);
      const parent=authority.parentAuthorityId?store.executionForAuthority(authority.parentAuthorityId):null;
      if(authority.parentAuthorityId&&!parent)throw new ModelGatewayError("gateway_parent_authority_required",403);
      store.beginExecution(threadId,{id,...authority,model,parent});
      this.gatewayChecks.set(id,()=>{const current=resolveAuthority();if(current.authorizer!==authority.authorizer || current.executor!==authority.executor)throw new ModelGatewayError("gateway_execution_changed",403);});
    } finally {store.close();}
  }

  private readonly gatewayChecks = new Map<string,()=>void>();
  private retireGatewayAdmission(params: RpcRecord, submitted = false) {
    const path=configuredModelGatewayPath();if(!path)return;
    const threadId=string(params.threadId),id=JSON.stringify([threadId,string(params.clientUserMessageId)]);
    if(!submitted && !this.gatewayChecks.has(id))return;
    this.gatewayChecks.delete(id);
    const ledger=new ModelGatewayStore(path);try{ledger.endExecution(threadId,id);}finally{ledger.close();}
  }

  private async checkModelPolicy(method: unknown, params: RpcRecord): Promise<void> {
    if (!(method === "turn/start" || method === "thread/goal/set" && params.status !== "paused" && params.status !== "complete" && params.status !== "blocked") || this.options.kind === "remote" || !this.options.modelPolicyPath || !readPolicy(this.options.modelPolicyPath).rules.some(r=>r.engine==="codex")) return;
      const thread = record(record(await this.requestPhysical("thread/read", {threadId: params.threadId, includeTurns:false})).thread);
      const catalog = record(await this.requestPhysical("model/list", {})).data;
      const models = Array.isArray(catalog) ? catalog : [];
      const {model,effort}=resolvePolicySelection("codex",params,thread,models);
      assertModelPolicy(this.options.modelPolicyPath, "codex", model, effort, models);
  }

  private nativeUnloadDiagnostic(threadId: string, phase: string, fields: RpcRecord = {}): void {
    this.diagnostic({
      event: "native-thread-unload", threadId, phase,
      owner: this.nativeUnloadDiagnosticOwner, generation: this.sessionMcpGeneration,
      executionIncarnation: this.nativeCore?.executionIncarnation ?? null,
      ...fields,
    });
  }

  private async requestPhysical(method: string, params: RpcRecord, timeoutMs = 30_000, signal?: AbortSignal, usageIdentity?:UsageSubmission, admit?: () => boolean, context?:TransportSubmissionContext): Promise<unknown> {
    if ((method === "turn/start" || method === "turn/steer") && this.executionBlocked(string(params.threadId))) throw new RecoveryNotSubmitted("Execution is recovering before submission");
    if (this.statusValue.state !== "open" || !this.physicalAvailable || !this.physicalInitialized && method !== "initialize") {
      return Promise.reject(method === "turn/start" || method === "turn/steer" ? new RecoveryNotSubmitted("Codex AppServer is not initialized") : new Error("Codex AppServer is not initialized"));
    }
    if (signal?.aborted) return Promise.reject(new Error("Codex request cancelled"));
    await this.checkModelPolicy(method, params);
    if (method === "turn/steer") {
      await this.admitModelExecution("steer", params, context);
    }
    // Tool retirement is pre-submission work. Start the physical delivery timer
    // only after it settles; a timed-out preparation must never send later.
    if (method === "turn/start") {
      const threadId = string(params.threadId), inputId = string(params.clientUserMessageId) || `internal-input:${randomUUID()}`;
      params = { ...params, clientUserMessageId: inputId };
      await this.admitModelExecution("start", params, context);
      const executionId = await this.beginExecution(threadId, inputId);
      try { await this.prepareSessionMcp(threadId, inputId, executionId); }
      catch (cause) { this.retireGatewayAdmission(params);throw new RecoveryNotSubmitted(string(this.sessionMcpFailure(cause).message), { cause }); }
    }
    if (signal?.aborted) {if(method==="turn/start")this.retireGatewayAdmission(params);throw new RecoveryNotSubmitted("Codex preparation was cancelled before submission");}
    // Internal creation has no browser principal. Bind its explicit unowned
    // environment just like an anonymous normal start; never borrow parent secrets.
    const runtime=this.options.executionEnvironment;
    const environmentCreationScope=method==='thread/start'&&runtime?runtime.scope({sender:null},'local-codex',params):undefined;
    const environment=environmentCreationScope?runtime!.snapshot(environmentCreationScope):undefined;
    environment?.apply(process.env);
    const id = `opencraft:host:${++this.sequence}`;
    const usageAttemptId=method==="turn/start"||method==="turn/steer"?randomUUID():undefined;
    const usageRuntime=this.tokenUsage,physicalGeneration=this.sessionMcpGeneration;
    if(usageAttemptId)await usageRuntime?.attempt(usageAttemptId,string(params.threadId),string(params.clientUserMessageId),method==="turn/start"?"start":"steer",usageIdentity);
    if(signal?.aborted||this.statusValue.state!=="open"||!this.physicalAvailable||physicalGeneration!==this.sessionMcpGeneration
      || (method === "turn/start" || method === "turn/steer") && this.executionBlocked(string(params.threadId))){
      if(usageAttemptId)usageRuntime?.attemptOutcome(usageAttemptId,"rejected");
      throw new RecoveryNotSubmitted("Codex request retired before native submission");
    }
    const unknown=()=>{if(usageAttemptId)usageRuntime?.attemptOutcome(usageAttemptId,"unknown");};
    const trace = signal ? this.historyReadTraces.get(signal) : undefined;
    const started = performance.now();
    const operation = new Promise((resolve, reject) => {
      const cleanup = () => {signal?.removeEventListener("abort", cancel);this.environmentCreations.delete(id);};
      const cancel = () => {
        this.internalRequests.delete(id); clearTimeout(timer); cleanup();
        unknown();reject(new Error("Codex request cancelled"));
      };
      const timer = setTimeout(() => {
        this.internalRequests.delete(id); cleanup();
        if (method === "thread/unsubscribe") this.nativeUnloadDiagnostic(string(params.threadId), "unsubscribe-timeout", { requestId: id });
        unknown();reject(new Error(`Codex ${method} delivery outcome is unknown after timeout`));
      }, timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      this.internalRequests.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer, threadId: string(params.threadId), method, params,usageAttemptId, recoveryAdmission: method === "turn/start" && admit !== undefined,environmentCreationScope });
      const internal = this.internalRequests.get(id)!;
      // Internal local work remains explicitly unowned; a remote workspace hook
      // rejects it unless the real queued/client context was supplied.
      const submissionContext: TransportSubmissionContext = context ?? Object.freeze({sender:null});
      internal.nativeAdmission = Object.freeze({method,context:()=>{
        if (this.internalRequests.get(id) !== internal || physicalGeneration !== this.sessionMcpGeneration
          || !this.physicalAvailable || signal?.aborted || admit?.() === false)
          throw new RecoveryNotSubmitted('Internal workspace admission retired');
        this.validateSubmissionContext(submissionContext);
        submissionContext.resourceOwner?.assertCurrent();
        return submissionContext;
      }});
      const finalize = method === 'thread/start' ? this.options.finalizeNativeCreation
        : method === 'thread/resume' ? this.options.finalizeNativeResume : undefined;
      if (finalize) {
        const workspaceParams = structuredClone(params);
        internal.finalizeWorkspaceReceipt = async reply => {
          await finalize({context: submissionContext, requestId: id, params: workspaceParams, ...reply});
          this.validateSubmissionContext(submissionContext);
          submissionContext.resourceOwner?.assertCurrent();
        };
      }
      if(environment)this.environmentCreations.set(id,environment);
      try {
        if (method === "thread/unsubscribe") this.nativeUnloadDiagnostic(string(params.threadId), "unsubscribe-request", { requestId: id });
        const write = this.writePhysical({ id, method, params }, admit);
        void write?.catch(error => {
          if (!this.internalRequests.delete(id)) return;
          clearTimeout(timer); cleanup();
          if (usageAttemptId && error instanceof RecoveryNotSubmitted) this.tokenUsage?.attemptOutcome(usageAttemptId, "rejected"); else unknown();
          reject(error);
        });
      }
      catch (error) {
        clearTimeout(timer); cleanup();
        this.internalRequests.delete(id);
        unknown();reject(error);
      }
    });
    if (!trace) return operation;
    try { return await operation; }
    finally {
      const nativeRpcMs = performance.now() - started;
      trace.nativeRpcMs += nativeRpcMs; trace.nativeRpcCount++;
      this.historyDiagnostic({ event: "history-native-rpc", pairId: trace.pairId, requestId: id, method, nativeRpcMs,
        ...(typeof params.limit === "number" ? { limit: params.limit } : {}) });
    }
  }

  private rejectInternalRequests(error: Error): void {
    for (const request of this.internalRequests.values()) {
      clearTimeout(request.timer);
      if(request.usageAttemptId)this.tokenUsage?.attemptOutcome(request.usageAttemptId,"unknown");
      request.reject(error);
    }
    this.internalRequests.clear();
  }

  private queueStore(): OpenCraftHostQueue {
    if (!this.queue) throw new Error("Host queue is unavailable");
    return this.queue;
  }

  /**
   * Stage attachments for a Thread this Host does not execute (a bridge Thread):
   * the same model-readable locator as local Threads, recorded for display.
   */
  private async prepareExternalInput(threadId: string, clientId: string | undefined, input: readonly unknown[], context?: TransportSubmissionContext): Promise<unknown[]> {
    // Attribution is recorded before anything is staged, exactly as for this Host's own Threads.
    if (context && (clientId || context.sender)) {
      if (!this.identity) {
        if (context.sender) throw new Error("Message sender storage is unavailable");
      } else this.identity.recordSubmission({ threadId, clientUserMessageId: clientId ?? "" }, context);
    }
    const prepared = await this.modelVisibleAttachmentInput(input, threadId, clientId, context);
    if (clientId && prepared.attachments.length > 0 && this.messageAttachments) this.messageAttachments.record(threadId, clientId, prepared.attachments);
    return prepared.input;
  }
  /** A bridge Thread's live notification with the sender recorded by prepareExternalInput. */
  private projectExternalNotification(message: RpcRecord): RpcRecord {
    return this.messageSenders ? projectThreadMessageNotification(this.projectSender, message) as RpcRecord : message;
  }
  /** The trusted submission lookup for collection, which names bridge Threads by their native session. */
  private usageSubmissionByRecord() {
    const submission = this.options.tokenUsage?.submission;
    return submission ? (threadId: string, inputId: string) => submission(this.externalThreadIdentities?.toPublic?.(threadId) ?? threadId, inputId) : undefined;
  }
  private externalThreadIdentities?: { toNative(threadId: string): string | undefined; toPublic?(nativeId: string): string | undefined };
  /** The provider bridge's public↔native Thread identities, for Host duties it forwards here. */
  private bindExternalThreadIdentities(identities: { toNative(threadId: string): string | undefined; toPublic?(nativeId: string): string | undefined }): void { this.externalThreadIdentities = identities; }
  /** Who submitted an input, for usage attribution: the trusted owner's record, else the submitting actor. */
  private usageIdentity(recordThreadId: string, publicThreadId: string, inputId: string, mode: "start" | "steer", context: TransportSubmissionContext): UsageSubmission {
    const actor=context.actorContext ? this.options.tokenUsage?.actor(context.actorContext) : null;
    const trusted=this.options.tokenUsage?.submission?.(publicThreadId,inputId);
    return {threadId:recordThreadId,inputId,actorId:trusted?.sourceKind==="system"?trusted.actorId:actor?.id??trusted?.actorId??null,
      actorKind:trusted?.sourceKind==="system"?trusted.actorKind:actor?.kind??trusted?.actorKind??"unknown",mode,
      sourceKind:trusted?.sourceKind === "system" ? "system" : actor?.kind === "human" ? "human":actor?.kind === "session" ? "system":trusted?.sourceKind??"unknown",submittedAt:Date.now()};
  }
  /** A bridge Thread's turn notification, with native session and turn identities, for usage collection. */
  private observeExternalUsage(method: string, params: RpcRecord): void {
    try { this.tokenUsage?.notification(method, params); } catch { this.diagnostic({event:"token-usage-partial",category:"notification"}); }
  }
  /** A bridge Thread's input is about to be submitted: record who submitted it, under its native session. */
  private async beginExternalUsage(nativeThreadId: string, publicThreadId: string, inputId: string, mode: "start" | "steer", context: TransportSubmissionContext): Promise<string | undefined> {
    const usage=this.tokenUsage;
    if(!usage||!nativeThreadId||!inputId)return undefined;
    try {
      const attemptId=randomUUID();
      await usage.attempt(attemptId,nativeThreadId,inputId,mode,this.usageIdentity(nativeThreadId,publicThreadId,inputId,mode,context));
      return attemptId;
    } catch { this.diagnostic({event:"token-usage-partial",category:"submission"}); return undefined; }
  }
  /** Its outcome: accepted into a native turn (and admitted to it), rejected, or unknown. */
  private settleExternalUsage(attemptId: string, outcome: "accepted" | "rejected" | "unknown", nativeThreadId: string, inputId: string, nativeTurnId?: string): void {
    try {
      this.tokenUsage?.attemptOutcome(attemptId,outcome,outcome==="accepted"?nativeTurnId??null:null);
      if(outcome==="accepted"&&nativeTurnId)this.tokenUsage?.admission({threadId:nativeThreadId,turnId:nativeTurnId},inputId);
    } catch { this.diagnostic({event:"token-usage-partial",category:"acceptance"}); }
  }
  /** Whether this Host can record verified senders for a bridge Thread's input. */
  private get externalSenderAttribution(): boolean { return !!this.identity; }
  /**
   * Let the bridge adopt one of this Host's Threads. Only a Thread with no turn,
   * queued or unknown input, goal, retry, recovery, title job, active schedule,
   * pending approval or admission in flight is released; this Host then stops
   * observing it. Nothing is executed or discarded.
   */
  private async releaseForAdoption(threadId: string): Promise<boolean> {
    // A pass-through to Core keeps no thread state here, so this Host cannot vouch that a Thread is idle.
    if (!threadId || this.closeOperation || this.coreBridge) return false;
    return this.withThreadOperation(threadId, async () => {
      if (this.executionBlocked(threadId) || this.generationUsageSnapshot().blockedThreadIds.includes(threadId)) return false;
      if (this.nativeSubscribedThreads.has(threadId)) {
        await this.requestPhysical("thread/unsubscribe", { threadId });
        this.nativeSubscribedThreads.delete(threadId);
      }
      return true;
    });
  }
  /** Title generation for a bridge Thread, observed by its native identity. */
  private observeExternalTitle(method: string, params: RpcRecord, result: unknown): void { this.threadTitles?.observeResult(method, params, result); }
  /**
   * The duties this Host performs for provider bridge Threads while it runs beside
   * the bridge: it holds the attachment, sender, title and usage records they share
   * with its own Threads. Collaboration queue checks come from the shared guard.
   */
  bridgeOwners(): CodexBridgeOwners {
    return {
      prepareInput: (threadId, clientId, input, context) => this.prepareExternalInput(threadId, clientId, input, context),
      projectHistory: (method, params, result) => this.projectExternalHistory(method, params, result),
      projectNotification: (message) => this.projectExternalNotification(message),
      observeTitle: (method, params, result) => this.observeExternalTitle(method, params, result),
      // The Host opens its sender storage when it connects, after a bridge is assembled.
      senderAttribution: () => this.externalSenderAttribution,
      usage: {
        notification: (method, params) => this.observeExternalUsage(method, params),
        begin: (nativeThreadId, publicThreadId, inputId, mode, context) => this.beginExternalUsage(nativeThreadId, publicThreadId, inputId, mode, context),
        settle: (attemptId, outcome, nativeThreadId, inputId, nativeTurnId) => this.settleExternalUsage(attemptId, outcome, nativeThreadId, inputId, nativeTurnId),
      },
      queueGuard: collaborationQueueGuard(this.options),
      releaseForAdoption: (threadId) => this.releaseForAdoption(threadId),
      bindThreadIdentities: (identities) => this.bindExternalThreadIdentities(identities),
    };
  }
  /** Attachments recorded by prepareExternalInput, projected onto that Thread's history. */
  private projectExternalHistory(method: string, params: RpcRecord, result: unknown): unknown {
    const attached = this.messageAttachments ? projectThreadAttachmentResult(this.messageAttachments, method, params, result) : result;
    // Senders recorded by prepareExternalInput, as on this Host's own history.
    return this.messageSenders
      ? projectThreadMessageResult(this.projectSender, method, params, attached, { trustedSubmissionSender: true })
      : attached;
  }

  private attachmentRecords(): OpenCraftMessageAttachments {
    if (!this.messageAttachments) throw new Error("Message attachment storage is unavailable");
    return this.messageAttachments;
  }

  private installThreadMetadata(): void {
    if (!this.hostState) return;
    this.identity = new ThreadIdentity(this.hostState.database, {
      createMetadata: this.options.createThreadMetadata,
      readMessageIds: (threadId, turnId, signal) => readThreadMessageIds(
        (method, params, signal) => this.requestPhysical(method, params, 30_000, signal), threadId, turnId, signal),
      notify: (method, params) => {
        for (const clientId of this.initializedClients) this.emit({ method, params }, clientId);
      },
    });
  }

  private observeMetadataResult(method: string, params: RpcRecord, result: unknown, sender?: import("@opencraft/appserver-protocol").MessageSender | null): void {
    if (["thread/start", "thread/read", "thread/resume"].includes(method)) {
      const thread = record(record(result).thread), id = string(thread.id);
      if (id && thread.ephemeral !== true && thread.canAcceptDirectInput !== false) this.queueableThreads.add(id);
      else if (id) this.queueableThreads.delete(id);
    }
    if (params.threadSource === "thread_title" || this.threadTitles?.owns(string(params.threadId))) return;
    if (method === "turn/start" && !this.ephemeralThreads.has(string(params.threadId))) {
      this.recovery?.started(string(params.threadId), string(record(record(result).turn).id), string(params.clientUserMessageId));
    }
    if (method === "thread/start" && record(record(result).thread).ephemeral !== true) {
      const threadId = string(record(record(result).thread).id);
      if (threadId) this.provisionalThreads?.created(threadId, record(result), this.executionEnvironments.get(threadId)?.owner);
    }
    if (method === "turn/start") this.provisionalThreads?.accepted(string(params.threadId), string(params.clientUserMessageId), string(record(record(result).turn).id));
    if (method === "thread/list" && Array.isArray(record(result).data))
      for (const thread of record(result).data as unknown[]) this.provisionalThreads?.persisted(string(record(thread).id));
    if (method === "thread/start") {
      const configuration = record(params.config)["mcp_servers.opencraft_session"];
      const threadId = string(record(record(result).thread).id);
      if (configuration && threadId) this.sessionMcpConfigurations.set(threadId, structuredClone(configuration));
    }
    this.threadTitles?.observeResult(method, params, result);
    this.catalogChanges.observeResult(method, params, result);
    this.durableCatalog?.observe(method, params, result);
    try { this.identity?.observeResult(method, params, result, sender); }
    catch { this.diagnostic({ event: "thread-metadata-observation-failed" }); }
  }

  private installDurableCatalog(): void {
    if (this.options.kind !== "remote" || !this.hostState) return;
    this.durableCatalog = new DurableThreadCatalog(this.hostState.database, {
      list: (params, signal) => this.requestPhysical("thread/list", params as RpcRecord, 30_000, signal),
      observed: threadIds => this.threadMetadata?.observeCatalog?.(threadIds),
      changed: () => {
        for (const clientId of this.initializedClients) this.emit({ method: "opencraft/thread-catalog/changed", params: {} }, clientId);
      },
    });
  }

  private readonly projectSender = (threadId: string, clientId: string, value: RpcRecord): RpcRecord => {
    const { sender: _untrusted, ...rest } = value;
    return { ...rest, sender: this.messageSenders?.get(threadId, clientId) ?? null };
  };

  private validateSubmissionContext(context: TransportSubmissionContext): void {
    assertSubmissionIdentity(context);
  }

  private recordSender(params: RpcRecord, context: TransportSubmissionContext): void {
    this.validateSubmissionContext(context);
    const messageId = string(params.clientUserMessageId);
    // Legacy native clients without message IDs remain unattributed.
    if (!messageId && !context.sender) return;
    // A native remote connection without an attribution owner can still forward
    // anonymous input; verified attribution must never silently lose its owner.
    if (this.options.kind === "remote" && !this.messageSenders && !context.sender) return;
    if (!this.messageSenders) throw new Error("Message sender storage is unavailable");
    this.identity!.recordSubmission(params, context);
  }

  private queueProjection(row: HostQueuedSubmission, context?: TransportSubmissionContext): RpcRecord {
    // Managed inputs can only be changed by the trusted collaboration owner.
    // Listing a message is not a grant to mutate its delivery.
    const ordinary = !row.clientUserMessageId.startsWith("actor-input:");
    const canCancel = !ordinary && context?.actorContext
      ? this.options.collaboration?.canCancel?.(context.actorContext, row.clientUserMessageId.slice("actor-input:".length)) === true : false;
    return {
      actions: { edit: ordinary && !inputExecutionEnded(row.delivery), delete: ordinary || canCancel, start: ordinary && !inputExecutionEnded(row.delivery), reorder: ordinary && !inputExecutionEnded(row.delivery) },
      delivery: row.delivery,
      id: row.id,
      input: row.input,
      clientUserMessageId: row.clientUserMessageId,
      sender: this.messageSenders?.get(row.threadId, row.clientUserMessageId) ?? null,
      createdAt: row.createdAt,
      pausedReason: row.state === "queued" && this.executionBlocked(row.threadId) ? "execution-recovering" : row.pausedReason,
    };
  }

  private emitQueueChanged(threadId: string): void {
    if(process.env.OPENCRAFT_OBSERVE_SOCKET&&this.queue)try{nodeObserver(this.options.observationComponent??'gateway').queue('codex',threadId,this.queue.observationCount(threadId));}catch{/* Observation cannot break the queue owner. */}
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

  private reconcileGenerationThread(threadId: string): void {
    if (this.closeOperation || this.generationReconciling.has(threadId)) return;
    this.generationReconciling.set(threadId, null);
    const inspect = () => {
      if (this.closeOperation) { this.generationReconciling.delete(threadId); return; }
      void this.withThreadOperation(threadId, async () => {
        await this.queueThreadIsIdle(threadId);
        const result = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
        const goal = record(await this.requestPhysical("thread/goal/get", { threadId }));
        this.noteGoal(threadId, goal.goal);
        this.receivePhysicalLine(JSON.stringify({ method: "thread/status/changed", params: { threadId, status: record(result.thread).status } }));
        this.generationReconciling.delete(threadId); this.recovery?.wake(); this.providerRetry?.wake(); this.scheduleQueueMaintenance(threadId);
        if (this.activeGoalThreads.has(threadId)) this.scheduleGoalContinuation(threadId);
      }).catch(() => {
        if (this.closeOperation) { this.generationReconciling.delete(threadId); return; }
        const timer = setTimeout(inspect, 1_000); timer.unref(); this.generationReconciling.set(threadId, timer);
      });
    };
    inspect();
  }

  private async inspectInterruptedTurn(turn: Readonly<RecoveryTurn>): Promise<"live" | "lost" | "finished" | "handled" | "unknown"> {
    if (!this.physicalInitialized || this.statusValue.state !== "open") return "unknown";
    const queued=this.queue?.firstUnsettled(turn.threadId);
    if (queued && !(await this.knownSystemInput(turn.threadId,queued.clientUserMessageId))) return "handled";
    const result = record(await this.requestPhysical("thread/read", { threadId: turn.threadId, includeTurns: false }));
    const thread = record(result.thread);
    if (thread.ephemeral || thread.archived || thread.canAcceptDirectInput === false) return "handled";
    if (!await this.queueThreadIsIdle(turn.threadId, false, undefined, turn.turnId)) return "live";
    const goal = record(await this.requestPhysical("thread/goal/get", { threadId: turn.threadId }));
    if (record(goal.goal).status === "active") { this.noteGoal(turn.threadId, goal.goal); this.scheduleGoalContinuation(turn.threadId); return "handled"; }
    const page = record(await this.requestPhysical("thread/turns/list", { threadId: turn.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));
    const latest = record(Array.isArray(page.data) ? page.data[0] : null);
    if (!latest.id) return "unknown";
    if (latest.id !== turn.turnId) return "handled";
    if (latest.status === "completed" || latest.status === "failed") return "finished";
    // A native idle thread with its tracked, unfinished last turn is positive
    // execution-loss evidence, including older CLI history marked inProgress.
    return latest.status === "interrupted" || latest.status === "inProgress" ? "lost" : "unknown";
  }

  private scheduleCoreReconnect(): void {
    if (this.coreReconnectTimer || !this.nativeTransport || this.closeOperation || ["closing", "closed"].includes(this.statusValue.state)) return;
    this.coreReconnectTimer = setTimeout(() => {
      this.coreReconnectTimer = null;
      void (async () => {
        this.coreReinitializing = true; this.generationDiscoveryComplete = false; ++this.generationGoalScan;
        await this.nativeTransport!.connect();
        if (this.closeOperation) return;
        this.activeTurns.clear(); this.nativeSubscribedThreads.clear();
        this.physicalInitialized = false;
        const initialized = await this.requestPhysical("initialize", { clientInfo: { name: "opencraft-recovery", version: "0.1.0" }, capabilities: { experimentalApi: true } });
        // A reconnect may finish before the first View ever initializes.
        // Populate the same decorated cache as normal initialization, otherwise
        // that View sends initialize again on this already-initialized socket.
        await this.completeInitialize({ clientId: "", clientEpoch: 0, originalId: "core-recovery",
          method: "initialize", params: {} }, { result: initialized });
        if (this.closeOperation) return;
        this.coreReinitializing = false;
        this.publishStatus({ state: "open" });
      })().catch(() => {
        if (this.closeOperation) return;
        this.physicalInitialized = false;
        // A failed/unknown initialize cannot be retried on an already-open
        // native connection, nor expose the previous initialize cache as ready.
        this.nativeCore!.resetConnection();
        this.scheduleCoreReconnect();
      });
    }, 1_000);
    this.coreReconnectTimer.unref();
  }

  /** Goal continuation belongs to the Host, not a browser View or websocket lease. */
  private scheduleGoalContinuation(threadId: string): void {
    if (this.recovery?.snapshot(threadId)?.handledReason === "execution_fault") return;
    if (this.options.kind === "remote" || !this.activeGoalThreads.has(threadId) || this.goalContinuationTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.goalContinuationTimers.delete(threadId);
      void this.withThreadOperation(threadId, async () => {
        if (this.executionBlocked(threadId) || this.recovery?.snapshot(threadId)?.handledReason === "execution_fault"
          || !this.activeGoalThreads.has(threadId) || this.activeTurns.has(threadId)) return;
        if (this.queue?.firstAwaitingAdmission(threadId)) return;
        if (!(await this.queueThreadIsIdle(threadId))) return;
        const result = record(await this.requestPhysical("thread/goal/get", { threadId }));
        this.noteGoal(threadId, result.goal);
        if (this.executionBlocked(threadId) || this.recovery?.snapshot(threadId)?.handledReason === "execution_fault"
          || !this.activeGoalThreads.has(threadId) || this.activeTurns.has(threadId)) return;
        await this.requestPhysical("thread/goal/set", { threadId, status: "active" });
      }).catch(error => this.diagnostic({ event: "goal-continuation-failed", threadId, reason: errorMessage(error) }));
    }, 150);
    timer.unref();
    this.goalContinuationTimers.set(threadId, timer);
  }

  private async scheduleProviderFailure(threadId: string, turnId: string, error: unknown): Promise<void> {
    const intent = JSON.stringify(this.recovery?.snapshot(threadId));
    if (this.recovery?.snapshot(threadId)?.state === "handled") return;
    const failure = codexProviderFailure(error);
    if (failure.kind !== "rate-limit") { this.providerRetry?.failed(threadId, turnId, failure); return; }
    const owner = this.providerRetry;
    if (!owner) return;
    await this.withThreadOperation(threadId, async () => {
      try {
        const accounts = this.poolStore ? this.accountViews(this.poolStore)
          : record(await this.requestPhysical("opencraft/codex/accounts/list", {}, 5_000)).accounts;
        if (this.closeOperation || this.providerRetry !== owner || JSON.stringify(this.recovery?.snapshot(threadId)) !== intent) return;
        // Pool routing owns readiness; native global quotas can belong to another account.
        failure.retryAt = pooledRetryAt(accounts, Date.now());
        const page = record(await this.requestPhysical("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));
        const latest = record(Array.isArray(page.data) ? page.data[0] : null);
        if (latest.id === turnId && latest.status === "failed") owner.failed(threadId, turnId, failure);
      } catch { this.diagnostic({ event: "provider-retry-skipped", threadId, reason: "pool-unavailable" }); }
    }).catch(() => undefined);
  }

  private async inspectProviderRetry(turn: Readonly<ProviderRetry>): Promise<"live" | "finished" | "handled" | "unknown" | { failure: ProviderFailure }> {
    if (!this.physicalInitialized || !this.physicalAvailable || this.admissionPaused()) return "unknown";
    if (this.queue?.firstUnsettled(turn.threadId)) return "handled";
    const result = record(await this.requestPhysical("thread/read", { threadId: turn.threadId, includeTurns: false }));
    const thread = record(result.thread);
    if (thread.ephemeral || thread.archived || thread.canAcceptDirectInput === false) return "handled";
    if (!await this.queueThreadIsIdle(turn.threadId, true, undefined, turn.turnId)) return "live";
    const page = record(await this.requestPhysical("thread/turns/list", { threadId: turn.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));
    const latest = record(Array.isArray(page.data) ? page.data[0] : null);
    if (!latest.id) return "unknown";
    if (latest.id !== turn.turnId) return "handled";
    if (latest.status === "completed") return "finished";
    if (latest.status !== "failed") return "unknown";
    // Summary history deliberately omits error details. The waiting receipt's
    // classification is bound to this exact failed Turn, not to prose or a scan.
    // A running successor has no such observed failure fact and cannot reuse it.
    const failure = Object.hasOwn(latest, "error") ? codexProviderFailure(latest.error)
      : turn.state === "running" ? { kind: "permanent" as const } : turn.failure;
    if (failure.kind === "permanent") return "handled";
    if (failure.kind === "rate-limit") {
      const accounts = this.poolStore ? this.accountViews(this.poolStore)
        : record(await this.requestPhysical("opencraft/codex/accounts/list", {}, 5_000)).accounts;
      failure.retryAt = pooledRetryAt(accounts, Date.now());
      if (failure.retryAt === undefined) return "handled";
    }
    return { failure };
  }

  /** Rebuild the Host's active Goal index from Codex's durable Thread state. */
  private async discoverActiveGoals(): Promise<void> {
    const scan = ++this.generationGoalScan; this.generationDiscoveryComplete = false;
    let cursor: string | null = null, partial = false;
    for (let page = 0; page < 1_000 && this.statusValue.state === "open"; page++) {
      const response = record(await this.requestPhysical("thread/list", {
        limit: 100, useStateDbOnly: true, ...(cursor ? { cursor } : {}),
      }));
      const coverage = record(response.catalog);
      partial ||= coverage.coverage === "partial" || coverage.coverage === "unknown" || coverage.state === "error" || coverage.state === "warming";
      if (!Array.isArray(response.data)) throw new Error("Codex Thread list has no data");
      for (const thread of response.data) {
        const threadId = string(record(thread).id);
        if (!threadId || this.ephemeralThreads.has(threadId)) continue;
        const result = record(await this.requestPhysical("thread/goal/get", { threadId }));
        this.noteGoal(threadId, result.goal);
        if (this.activeGoalThreads.has(threadId)) this.scheduleGoalContinuation(threadId);
      }
      if (response.nextCursor === null) { if (partial) throw new Error("Codex Goal discovery is incomplete"); if (scan === this.generationGoalScan) this.generationDiscoveryComplete = true; return; }
      if (typeof response.nextCursor !== "string" || response.nextCursor === cursor) throw new Error("Codex Thread list did not advance");
      cursor = response.nextCursor;
    }
    if (cursor !== null) throw new Error("Codex Goal discovery exceeded its safety bound");
  }

  private readonly queuePreparationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private scheduleQueuePreparationRetry(threadId: string): void {
    if (this.closeOperation || this.queuePreparationRetries.has(threadId)) return;
    const timer = setTimeout(() => {
      this.queuePreparationRetries.delete(threadId);
      if (!this.closeOperation) this.scheduleQueueMaintenance(threadId);
    }, 1_000);
    timer.unref();
    this.queuePreparationRetries.set(threadId, timer);
  }
  private scheduleQueueMaintenance(threadId: string): void {
    if (!threadId || this.queue === null || this.initializeResult === null) return;
    void this.withThreadOperation(threadId, () => this.maintainQueue(threadId)).catch(error => {
      this.diagnostic({ event: "queue-maintenance-failed", threadId, reason: errorMessage(error) });
    });
  }

  /** Adapter only: scheduling policy and persistence live outside Codex. */
  private readonly scheduleObservers = new Set<(event: ScheduleExecutionEvent) => void>();
  private scheduleExecutionPort(): ScheduleExecutionPort {
    return {
      subscribe: listener => { this.scheduleObservers.add(listener); return () => { this.scheduleObservers.delete(listener); }; },
      validate: threadId => this.assertDurableQueueThread(threadId),
      permissionProfiles: async threadId => {
        const { thread } = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
        const profiles: OpenCraftPermissionProfile[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const response = record(await this.requestPhysical("permissionProfile/list", { limit: 100, cwd: record(thread).cwd, cursor }));
          if (!Array.isArray(response.data)) throw new Error("Codex permission catalog is unavailable");
          profiles.push(...response.data as OpenCraftPermissionProfile[]);
          if (response.nextCursor == null) return projectPermissionProfileCatalog(profiles, profile => codexPermissionMode(profile.id));
          if (typeof response.nextCursor !== "string" || response.nextCursor === cursor) throw new Error("Codex permission catalog did not advance");
          cursor = response.nextCursor;
        }
        throw new Error("Codex permission catalog is too long");
      },
      submit: (run, prompt, canAdmit) => this.withThreadOperation(run.threadId, async () => {
        const queue = this.queueStore();
        const prior = queue.findByClientId(run.threadId, run.id);
        if (prior) {
          if (prior.state === "delivered") return { state: "running", turnId: prior.targetTurnId ?? undefined };
          if (prior.state === "discarded") return { state: "failed" };
          if (prior.state !== "queued") return { state: "unknown" };
          // Durable handoff already exists: its ordinary queue owner will resume it.
          this.scheduleQueueMaintenance(run.threadId);
          return { state: "running" };
        }
        await this.assertDurableQueueThread(run.threadId);
        if (queue.firstUnsettled(run.threadId) || this.activeTurns.has(run.threadId) || !await this.queueThreadIsIdle(run.threadId)) return { state: "waiting" };
        if (!canAdmit() || this.admissionPaused()) return { state: "waiting" };
        // Scheduled provenance is explicit text, never forged employee credentials.
        const row = queue.add(run.threadId, run.id, [{ type: "text", text: `[Scheduled task]\n${prompt}` }]);
        this.emitQueueChanged(run.threadId);
        try {
          const response = await this.dispatchQueuedStart(run.threadId, row.id);
          return { state: "running", turnId: string(record(response.turn).id) };
        } catch {
          return { state: "unknown" };
        }
      }),
      inspect: async run => this.inspectScheduledRun(run),
    };
  }

  private async inspectScheduledRun(run: ConversationScheduleRun): Promise<{ state: "running" | "completed" | "failed" | "unknown"; turnId?: string }> {
    return this.withThreadOperation(run.threadId, async () => {
    const queue = this.queueStore();
    const row = queue.findByClientId(run.threadId, run.id);
    if (!row) return { state: "unknown" };
    if (row.state === "discarded") return { state: "failed" };
    if (row.state === "queued") { this.scheduleQueueMaintenance(run.threadId); return { state: "running" }; }
    let turnId = row.targetTurnId;
    if (run.turnId && turnId && turnId !== "unknown" && run.turnId !== turnId) return { state: "unknown" };
    if (["unknown", "dispatching", "steering"].includes(row.state) || !turnId || turnId === "unknown") {
      // Observation only: a lost acknowledgement is never permission to resend.
      // Match the exact durable input ID, never prompt text, latest Turn or idle status.
      const confirmed = await this.historyClientMessageTurn(run.threadId, run.id, turnId === "unknown" ? null : turnId);
      if (!confirmed || run.turnId && run.turnId !== confirmed) return { state: "unknown" };
      const current = queue.findByClientId(run.threadId, run.id);
      if (!current || current.state === "discarded") return { state: "unknown" };
      if (current.targetTurnId && current.targetTurnId !== "unknown" && current.targetTurnId !== confirmed) return { state: "unknown" };
      turnId = confirmed;
      queue.deliveries.recorded(run.threadId, run.id);
      queue.settle(run.threadId, row.id, "delivered", null, turnId);
      this.emitQueueChanged(run.threadId);
    }
    const receipt = queue.findByClientId(run.threadId, run.id)?.delivery;
    if (receipt?.nativeAdmission === "accepted") {
      if (receipt.execution === "completed") return { state: "completed", turnId };
      if (receipt.execution === "failed" || receipt.execution === "interrupted") return { state: "failed", turnId };
    }
    const turn = await this.findScheduledTurn(run.threadId, turnId);
    if (!turn) return { state: "unknown", turnId };
    if (turn.status === "completed") return { state: "completed", turnId };
    if (turn.status === "failed" || turn.status === "interrupted" || turn.error) return { state: "failed", turnId };
    return { state: "running", turnId };
    });
  }

  private async findScheduledTurn(threadId: string, turnId: string, maxPages = 100, signal?: AbortSignal): Promise<RpcRecord | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const response = record(await this.requestPhysical("thread/turns/list", {
        threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}),
      }, 30_000, signal));
      if (!Array.isArray(response.data)) throw new Error("Codex turn history has no page");
      const turn = response.data.map(record).find(value => value.id === turnId);
      if (turn) return turn;
      if (response.nextCursor == null) return undefined;
      if (typeof response.nextCursor !== "string" || seen.has(response.nextCursor)) throw new Error("Codex turn history did not advance");
      cursor = response.nextCursor; seen.add(cursor);
    }
    return undefined; // Old/unobserved schedules stay unknown; never fetch the full transcript.
  }

  private async threadStatus(threadId: string): Promise<string> {
    const response = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
    return string(record(record(response.thread).status).type);
  }

  private async assertDurableQueueThread(threadId: string): Promise<void> {
    if (this.executionBlocked(threadId)) {
      const known = record(this.provisionalThreads?.get(threadId)?.result.thread);
      if (this.queueableThreads.has(threadId) || known.id === threadId && known.ephemeral !== true && known.canAcceptDirectInput !== false) return;
    }
    const response = record(await this.requestPhysical("thread/read", { threadId, includeTurns: false }));
    const thread = record(response.thread);
    if (string(thread.id) !== threadId) throw new OpenCraftQueueRpcError(-32600, "Queued Thread was not found");
    if (thread.ephemeral === true) throw new OpenCraftQueueRpcError(-32600, "Ephemeral Thread cannot own durable queued input");
    if (thread.canAcceptDirectInput === false) throw new OpenCraftQueueRpcError(-32600, "Thread does not accept direct user input");
  }

  private async workspaceResumeContext(threadId: string, context?: TransportSubmissionContext, turnId?: string): Promise<TransportSubmissionContext | undefined> {
    if (!this.options.requiresWorkspaceResume?.(threadId)) return context;
    if (context) { context.resourceOwner?.assertCurrent(); return context; }
    if (!turnId) {
      const queued = this.queue?.firstAwaitingAdmission(threadId);
      if (queued) {
        const restore = this.options.collaboration?.restoreWorkspaceSubmission;
        if (!restore) throw Error('Workspace queue authority unavailable');
        return restore(threadId, queued.clientUserMessageId, queued.executionSubmission ?? undefined);
      }
      // Only the most recent durable Turn is a restoration candidate. Its
      // persisted delegation still authorizes the operation; no owner guessing.
      const page = record(await this.requestPhysical('thread/turns/list', {threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'}));
      turnId = string(record(Array.isArray(page.data) ? page.data[0] : null).id);
    }
    if (!turnId || !this.options.collaboration?.workspaceTurnContext) throw Error('Workspace restoration authority unavailable');
    return this.options.collaboration.workspaceTurnContext(threadId, turnId);
  }

  private async queueThreadIsIdle(threadId: string, allowFailedThread = false, context?: TransportSubmissionContext, turnId?: string): Promise<boolean> {
    let status = await this.threadStatus(threadId);
    if (status === "notLoaded" || this.nativeCore && !this.nativeSubscribedThreads.has(threadId)) {
      // A core-kept active thread is loaded, but this new physical connection
      // still needs completion events for queue and Goal continuation.
      const workspaceContext = await this.workspaceResumeContext(threadId, context, turnId);
      await this.requestPhysical("thread/resume", { threadId, excludeTurns: true }, 30_000, undefined, undefined, undefined, workspaceContext);
      status = await this.threadStatus(threadId);
    }
    return status === "idle" || allowFailedThread && status === "systemError";
  }

  private async historyClientMessageTurn(threadId: string, clientId: string, turnId: string | null): Promise<string | null> {
    let cursor: string | null = null, found: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const response = record(await this.requestPhysical("thread/items/list", {
        threadId, ...(turnId ? { turnId } : {}), ...(cursor ? { cursor } : {}), limit: 100,
      }));
      const entries = response.data;
      if (!Array.isArray(entries)) throw new Error("Codex history response has no items");
      for (const entry of entries) {
        const item = record(record(entry).item);
        if (item.type === "userMessage" && item.clientId === clientId) {
          const containingTurn = string(record(entry).turnId);
          if (!containingTurn || turnId && containingTurn !== turnId) throw new Error("Codex history input has an invalid Turn");
          if (found && found !== containingTurn) throw new Error("Codex input appears in conflicting Turns");
          found = containingTurn;
        }
      }
      const next = response.nextCursor;
      if (next === null || next === undefined) return found;
      if (typeof next !== "string" || next === cursor) throw new Error("Codex history pagination did not advance");
      cursor = next;
    }
    throw new Error("Codex history is too long to reconcile safely");
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

  private async reconcileQueue(threadId: string, receiptTurnIds?: readonly string[]): Promise<void> {
    await reconcileThreadQueue(this.queueStore(), threadId, {
      historyHasInput: (clientId, target) => this.historyHasClientMessage(threadId, clientId, target),
      isIdle: () => this.queueThreadIsIdle(threadId),
      findTurn: target => this.findScheduledTurn(threadId, target),
      turnEnded: target => { if (this.activeTurns.get(threadId) === target) this.activeTurns.delete(threadId); },
      changed: () => this.emitQueueChanged(threadId),
    }, receiptTurnIds);
  }

  private actorInput(row: HostQueuedSubmission, mode: 'queue' | 'steer', expectedTurnId?: string): void {
    if (!row.clientUserMessageId.startsWith('actor-input:')) return;
    if (!this.options.collaborationInput?.authorize(row.threadId, row.clientUserMessageId, mode, expectedTurnId)) {
      throw new OpenCraftQueueRpcError(-32600, 'Actor execution authorization changed');
    }
  }

  private async maintainQueue(threadId: string): Promise<void> {
    if (this.executionBlocked(threadId)) return;
    const queue = this.queueStore();
    await this.reconcileQueue(threadId,[]);
    const first = queue.firstAwaitingAdmission(threadId);
    if (!first || first.state !== "queued" || ["model-restricted", "session-tools-unavailable"].includes(first.pausedReason ?? "")) return;
    const recovery=this.recovery?.snapshot(threadId);
    if(recovery&&['interrupted','preparing','dispatching'].includes(recovery.state)&&(await this.knownSystemInput(threadId,first.clientUserMessageId))){this.recovery?.wake(); this.providerRetry?.wake();return;}
    if (first.clientUserMessageId.startsWith('actor-input:')) {
      if (this.options.collaborationInput?.available() === false) return;
      const mode = this.options.collaborationInput?.mode(first.clientUserMessageId);
      if (!mode || !this.options.collaborationInput?.authorize(threadId, first.clientUserMessageId, mode, first.targetTurnId ?? undefined)) {
        // Steer carries its expected Turn in the collaboration authority, not in an unclaimed queue row.
        if (mode === 'steer') return;
        if (!this.options.collaborationInput) return;
        queue.delete(threadId, first.id); this.emitQueueChanged(threadId); this.scheduleQueueMaintenance(threadId); return;
      }
      if (mode === 'steer') return;
    }
    if ([...this.pending.values()].some(pending => pending.method === "turn/start" && pending.params.threadId === threadId)) return;
    if (this.activeTurns.has(threadId)) return;
    if (this.sessionMcpRetirements.has(threadId) && !this.sessionMcpRefreshes.has(threadId)) {
      // An earlier, definitively unsent preparation can leave retirement to
      // finish. The queued input owns the next refresh; never resume to poll it.
      if (!["idle", "systemError", "notLoaded"].includes(await this.threadStatus(threadId))) return;
    } else if (!(await this.queueThreadIsIdle(threadId, this.recovery?.snapshot(threadId)?.handledReason === "execution_fault"))) return;
    await this.dispatchQueuedStart(threadId, first.id);
  }

  private async knownSystemInput(threadId:string,inputId:string):Promise<boolean> {
    if(this.options.tokenUsage?.submission?.(threadId,inputId)?.sourceKind==='system')return true;
    const usage=this.tokenUsage;
    const stored=usage instanceof TokenUsageCollector?await usage.storedSubmission(threadId,inputId):usage?.ledger.storedSubmission(threadId,inputId);
    return stored?.sourceKind==='system';
  }
  private queuedUsageIdentity(context:TransportSubmissionContext|undefined,threadId:string,inputId:string,mode:"start"|"steer"):UsageSubmission|undefined {
    const trusted=this.options.tokenUsage?.submission?.(threadId,inputId);
    if(trusted?.sourceKind==="system")return {...trusted,mode};
    if(!context)return undefined;
    let actor:{id:string;kind:"human"|"session"}|null=null;
    try{actor=context.actorContext?this.options.tokenUsage?.actor(context.actorContext)??null:null;}
    catch{try{this.diagnostic({event:"token-usage-partial",category:"dispatch-identity"});}catch{}}
    return {threadId,inputId,mode,actorId:actor?.id??null,actorKind:actor?.kind??"unknown",sourceKind:actor?.kind==="human"?"human":actor?.kind==="session"?"system":"unknown",submittedAt:Date.now()};
  }
  private async dispatchQueuedStart(threadId: string, id: string, context?:TransportSubmissionContext): Promise<RpcRecord> {
    if (this.executionBlocked(threadId)) throw new RecoveryNotSubmitted("Execution is recovering before queue dispatch");
    return dispatchQueuedStart(this.queueStore(), threadId, id, {
      refuse: message => { throw new OpenCraftQueueRpcError(-32600, message); },
      prepare: async queued => {
        if (!queued.executionSubmission) this.executionLeases?.capture(threadId, queued.clientUserMessageId, { principal: null, ownership: "unknown" });
        if (!context && this.options.requiresWorkspaceResume?.(threadId)) {
          const restore = this.options.collaboration?.restoreWorkspaceSubmission;
          if (!restore) throw new OpenCraftQueueRpcError(-32600, 'Workspace queued execution authority unavailable');
          context = await restore(threadId, queued.clientUserMessageId, queued.executionSubmission ?? undefined);
          context.resourceOwner?.assertCurrent();
        }
        const prepared = await this.modelVisibleAttachmentInput(queued.input, threadId, undefined, context);
        if (prepared.attachments.length > 0) this.attachmentRecords().record(
          threadId, queued.clientUserMessageId, prepared.attachments);
        const referenceContext = await this.options.collaboration?.queuedContext?.(threadId, queued.clientUserMessageId, prepared.input);
        this.actorInput(queued, 'queue');
        const selection = this.schedules?.executionPermissions(threadId, queued.clientUserMessageId);
        const thread = selection ? record(record(await this.requestPhysical("thread/read", { threadId, includeTurns: false })).thread) : null;
        const permissions = selection ? await this.resolvePermissionSelection(selection, thread?.cwd) : {};
        return { input: prepared.input, referenceContext, permissions };
      },
      send: async (row, prepared) => {
        const response = record(await this.requestPhysical("turn/start", {
          threadId, input: prepared.input, clientUserMessageId: row.clientUserMessageId,
          ...prepared.permissions,
          ...(prepared.referenceContext ? {additionalContext:{"opencraft.conversations":{kind:"untrusted",value:JSON.stringify(prepared.referenceContext)}}} : {}),
        },30_000,undefined,this.queuedUsageIdentity(context,threadId,row.clientUserMessageId,"start"),undefined,context));
        if (!string(record(response.turn).id)) throw new Error("Codex returned an invalid turn/start acknowledgement");
        return { turnId: string(record(response.turn).id), response };
      },
      failed: error => {
        const unsent = error instanceof RecoveryNotSubmitted;
        const preparation = unsent && error.cause instanceof SessionMcpPreparationFailure ? error.cause : null;
        const retryable = unsent && (!preparation || sessionMcpRetryable(preparation.cause));
        return { state: unsent || error instanceof ModelPolicyError ? "queued" : "unknown",
          reason: error instanceof ModelPolicyError ? "model-restricted" : unsent && this.executionBlocked(threadId) ? "execution-recovering" : unsent
            ? retryable ? "session-tools-recovering" : "session-tools-unavailable" : "steer-delivery-unconfirmed",
          ...(retryable ? { after: () => this.scheduleQueuePreparationRetry(threadId) } : {}) };
      },
      changed: () => this.emitQueueChanged(threadId),
    });
  }

  /** This fence is only for commands that consume installed personal ENV.
   * Never use it to authorize native intent or shared active-Turn input. */
  private assertCurrentEnvironmentOwner(scope: EnvironmentExecutionScope): void {
    const applied = scope.threadId ? this.executionEnvironments.get(scope.threadId) : undefined;
    if (applied && applied.owner === executionEnvironmentOwner(scope)) return;
    throw new OpenCraftQueueRpcError(-32600, "This operation cannot use the current reply's account. Send a new message instead.",
      { notSubmitted: true, submissionOutcome: 'rejected', retryable: false });
  }

  private async assertNativeTurnInputReady(threadId: string): Promise<void> {
    if (!threadId) throw new OpenCraftQueueRpcError(-32602, "Steer requires a Thread");
    let reason = "native-unavailable";
    try {
      const page = record(await this.requestPhysical("thread/turns/list", {
        threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
      }, 1_500));
      if (Array.isArray(page.data) && page.data.length <= 1) {
        const latest = record(page.data[0]);
        if (string(latest.id) && latest.status === "inProgress") return;
        if (page.data.length === 0 || string(latest.id) && ["completed", "interrupted", "failed"].includes(string(latest.status)))
          reason = "no-active-execution";
      }
    } catch { /* Read failure is uncertainty, never a different account. */ }
    throw new OpenCraftQueueRpcError(-32000, "The current execution could not be confirmed.", {
      code: "EXECUTION_CONTROL_UNAVAILABLE", reason, notSubmitted: true,
      submissionOutcome: "rejected", retryable: reason === "native-unavailable",
    });
  }

  private definitiveSteerRejection(error: unknown): boolean {
    if (!(error instanceof OpenCraftQueueRpcError)) return false;
    if (error.code === -32601) return true;
    if (error.code !== -32600) return false;
    const info = record(record(error.data).codexErrorInfo);
    return Boolean(info.activeTurnNotSteerable) || error.message === "no active turn to steer"
      || /^expected active turn id `[^`]+` but found `[^`]+`$/.test(error.message)
      || error.message === "active turn uses a different output schema";
  }

  private async dispatchQueuedSteer(threadId: string, id: string, expectedTurnId: string, context?:TransportSubmissionContext, additionalContext?: unknown, canDispatch?:()=>boolean): Promise<RpcRecord> {
    return dispatchQueuedSteer(this.queueStore(), threadId, id, expectedTurnId, {
      refuse: message => { throw new OpenCraftQueueRpcError(-32600, message); },
      prepare: async queued => {
        if (this.options.executionEnvironment) {
          const submission = queued.executionSubmission;
          if (!submission || submission.ownership === 'unknown') throw new OpenCraftQueueRpcError(-32600, 'Execution identity is unavailable',
            { notSubmitted: true, submissionOutcome: 'rejected', retryable: false });
          // The queued input's provenance is independent of the target executor.
          // Do not manufacture or replace either identity from an ENV cache.
        }
        if (!context && this.options.requiresWorkspaceResume?.(threadId)) {
          const restore = this.options.collaboration?.restoreWorkspaceSubmission;
          if (!restore) throw new OpenCraftQueueRpcError(-32600, 'Workspace queued execution authority unavailable');
          context = await restore(threadId, queued.clientUserMessageId, queued.executionSubmission ?? undefined);
          context.resourceOwner?.assertCurrent();
        }
        const prepared = await this.modelVisibleAttachmentInput(queued.input, threadId, undefined, context);
        if (prepared.attachments.length > 0) this.attachmentRecords().record(
          threadId, queued.clientUserMessageId, prepared.attachments);
        if (context) {
          this.validateSubmissionContext(context);
          if (context.actorContext && this.options.collaboration?.prepare) {
            const referenceContext=await this.options.collaboration.prepare(context.actorContext,prepared.input);
            if (referenceContext) additionalContext={...record(additionalContext),'opencraft.conversations':{kind:'untrusted',value:JSON.stringify(referenceContext)}};
          }
          this.validateSubmissionContext(context);
          if (context.actorContext && this.options.collaboration) {
            context.resourceOwner?.assertCurrent();
            this.options.collaboration.authorize(context.actorContext,threadId,queued.clientUserMessageId,prepared.input);
          }
        }
        if (this.options.sharedTurnInput) await this.assertNativeTurnInputReady(threadId);
        if (context) this.validateSubmissionContext(context);
        if (canDispatch?.()===false) throw new RecoveryNotSubmitted('Sending client was replaced before native submission');
        return prepared.input;
      },
      beforeClaim: queued => this.actorInput(queued, 'steer', expectedTurnId),
      send: async (row, input) => {
        const response = record(await this.requestPhysical("turn/steer", {
          threadId, expectedTurnId, input, clientUserMessageId: row.clientUserMessageId,
          ...(additionalContext === undefined ? {} : {additionalContext}),
        },30_000,undefined,this.queuedUsageIdentity(context,threadId,row.clientUserMessageId,"steer"),()=>{
          if(context)this.validateSubmissionContext(context);
          return canDispatch?.()!==false;
        },context));
        const turnId = string(response.turnId) || string(record(response.turn).id);
        if (turnId !== expectedTurnId) throw new Error("Codex returned an invalid steer acknowledgement");
        return { turnId, response };
      },
      failed: error => {
        const unsent = error instanceof RecoveryNotSubmitted;
        const rejected = unsent || this.definitiveSteerRejection(error);
        return { state: rejected ? "queued" : "unknown",
          reason: unsent && this.executionBlocked(threadId) ? "execution-recovering" : rejected ? null : "steer-delivery-unconfirmed" };
      },
      changed: () => this.emitQueueChanged(threadId),
    }, () => this.reconcileQueue(threadId, []));
  }

  private async handleQueueRequest(clientId: string, id: string | number, method: string, params: RpcRecord, context: TransportSubmissionContext): Promise<void> {
    const threadId = string(params.threadId);
    try {
      if (!this.initializedClients.has(clientId)) throw new OpenCraftQueueRpcError(-32600, "Client is not initialized");
      if (!threadId) throw new OpenCraftQueueRpcError(-32602, "Queue request requires threadId");
      const queue = this.queueStore();
      let result: RpcRecord;
      const actorRequest = context.collaborationRequestId;
      const selected = string(params.queuedSubmissionId) ? queue.find(threadId, string(params.queuedSubmissionId)) : null;
      const actorClientId = selected?.clientUserMessageId ?? string(params.clientUserMessageId);
      if (selected && actorClientId.startsWith('actor-input:') && method === 'thread/queue/delete'
          && !actorRequest && context.actorContext && this.options.collaboration) {
        await this.options.collaboration.command(context.actorContext, {
          action: 'cancel', requestId: actorClientId.slice('actor-input:'.length),
        });
        this.emit({ id, result: { deleted: true } }, clientId);
        return;
      }
      if (actorClientId.startsWith('actor-input:') && actorClientId !== `actor-input:${actorRequest}`) {
        throw new OpenCraftQueueRpcError(-32600, 'Actor input requires its trusted admission');
      }
      if (selected?.clientUserMessageId.startsWith('actor-input:') && method === 'thread/queue/update') throw new OpenCraftQueueRpcError(-32600, 'Actor messages are immutable');
      if (method === "thread/queue/collaborationReceipt") {
        if (!actorRequest) throw new OpenCraftQueueRpcError(-32600, 'Trusted Actor admission required');
        const row = queue.findByClientId(threadId, `actor-input:${actorRequest}`);
        const completionSignal = params.includeCompletion === true ? AbortSignal.timeout(15_000) : undefined;
        const completion = row && params.includeCompletion === true
          ? await readInputCompletion(threadId, row, queue.deliveries,
              (id, turnId) => this.findScheduledTurn(id, turnId, 5, completionSignal),
              (id, turnId, cursor) => this.requestPhysical("thread/items/list", {threadId:id,turnId,cursor,limit:100,sortDirection:"asc"}, 30_000, completionSignal))
          : undefined;
        result = { receipt: row ? { id: row.id, state: row.state, targetTurnId: row.targetTurnId,
          ...(completion ? {completion} : {}) } : null };
      } else if (method === "thread/queue/list") {
        const cursor = params.cursor == null ? 0 : Number(params.cursor);
        const limit = params.limit == null ? 50 : Number(params.limit);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new OpenCraftQueueRpcError(-32602, "Invalid queue pagination");
        const receiptTurnIds = params.receiptTurnIds;
        if (receiptTurnIds !== undefined && (!Array.isArray(receiptTurnIds) || receiptTurnIds.length>1000
          || receiptTurnIds.some(id=>typeof id!=="string"||!id))) throw new OpenCraftQueueRpcError(-32602,"Invalid receipt Turn scope");
        await this.withThreadOperation(threadId, () => this.reconcileQueue(threadId,receiptTurnIds as string[] | undefined));
        const rows = queue.list(threadId,receiptTurnIds as string[] | undefined);
        const queued = rows.filter(row => row.state === "queued");
        const page = queued.slice(cursor, cursor + Math.min(limit, 100));
        result = {
          data: page.map(row => this.queueProjection(row, context)),
          nextCursor: cursor + page.length < queued.length ? String(cursor + page.length) : null,
          ...(cursor === 0 ? { steering: rows.filter(row => row.state === "steering" || row.state === "unknown" || row.state === "dispatching" || row.state === "closed")
            .map(row => ({ ...this.queueProjection(row, context), targetTurnId: row.targetTurnId ?? "unknown",
              retryable: row.state !== "closed" && row.delivery?.nativeAdmission !== "accepted" && !inputExecutionEnded(row.delivery) && !row.clientUserMessageId.startsWith("actor-input:") && row.pausedReason !== "execution-fault-unconfirmed" })) } : {}),
        };
      } else if (method === "thread/queue/add") {
        try { await this.assertDurableQueueThread(threadId); }
        catch (cause) {
          if (!sessionMcpRetryable(cause)) throw cause;
          throw new OpenCraftQueueRpcError(-32000, "The session connection is recovering; input was not queued yet.",
            { code: "QUEUE_NOT_READY", submissionOutcome: "rejected", retryable: true });
        }
        if (actorClientId.startsWith('actor-input:')) {
          const mode = this.options.collaborationInput?.mode(actorClientId);
          if (!mode) throw new OpenCraftQueueRpcError(-32600, 'Actor request unavailable');
          // Steer is checked again against its exact Turn at dispatch; add itself never executes it.
          if (mode === 'queue' && !this.options.collaborationInput?.authorize(threadId, actorClientId, mode)) throw new OpenCraftQueueRpcError(-32600, 'Actor execution authorization changed');
        }
        const row = this.hostState!.transaction(() => {
          this.recordSender(params, context);
          if (context.actorContext && this.options.collaboration && !actorClientId.startsWith('actor-input:')) {context.resourceOwner?.assertCurrent();this.options.collaboration.authorize(context.actorContext, threadId, string(params.clientUserMessageId), Array.isArray(params.input) ? params.input : []);}
          return queue.add(threadId, string(params.clientUserMessageId), params.input as readonly unknown[], snapshotExecutionSubmission(context));
        });
        result = record(projectThreadMessageResult(this.projectSender, method, params,
          { queuedSubmission: this.queueProjection(row, context) }, { trustedSubmissionSender: !!this.messageSenders }));
        this.emitQueueChanged(threadId);
        this.scheduleQueueMaintenance(threadId);
      } else if (method === "thread/queue/retry") {
        await this.withThreadOperation(threadId, async () => {
          if (this.executionBlocked(threadId)) throw new RecoveryNotSubmitted("Execution is recovering before retry");
          const itemId = string(params.queuedSubmissionId);
          const row = queue.find(threadId, itemId);
          if (!row || row.clientUserMessageId.startsWith("actor-input:"))
            throw new OpenCraftQueueRpcError(-32600, "Message is unavailable for retry");
          // Already settled/admitted retries are harmless no-ops, even after
          // the explicitly retried input acquired a newer Turn binding.
          if (row.state === "delivered" || row.state === "queued" && row.targetTurnId === null) return;
          if (row.targetTurnId !== string(params.expectedTurnId)) throw new OpenCraftQueueRpcError(-32600, "Message identity already belongs to another Turn");
          if (row.delivery?.nativeAdmission === "accepted" || inputExecutionEnded(row.delivery)
            || row.state === "dispatching" || row.state === "steering") return;
          if (!queue.requestRetry(threadId, itemId, string(params.expectedTurnId)))
            throw new OpenCraftQueueRpcError(-32600, "Message changed before retry");
          await this.reconcileQueue(threadId);
        });
        result = {};
        this.emitQueueChanged(threadId);
        this.scheduleQueueMaintenance(threadId);
      } else if (method === "thread/queue/update") {
        if (this.options.executionEnvironment && selected) {
          // Shared members may edit ordinary queued input. Preserve its captured
          // execution principal; editing must not silently transfer credentials.
          const original = selected.executionSubmission;
          if (!original || original.ownership === 'unknown')
            throw new OpenCraftQueueRpcError(-32600, 'Execution identity is unavailable',
              { notSubmitted: true, submissionOutcome: 'rejected', retryable: false });
        }
        const row = queue.update(threadId, string(params.queuedSubmissionId), params.input as readonly unknown[]);
        if (!row) throw new OpenCraftQueueRpcError(-32600, "Queued message is not editable");
        result = { queuedSubmission: this.queueProjection(row, context) };
        this.emitQueueChanged(threadId);
      } else if (method === "thread/queue/delete") {
        const itemId = string(params.queuedSubmissionId);
        if (params.acknowledgeUnknownDelivery === true) {
          const target = string(params.expectedTurnId);
          const row = queue.find(threadId, itemId);
          if (!target || !row || row.state !== "unknown" || row.targetTurnId !== target) {
            throw new OpenCraftQueueRpcError(-32600, "Unknown delivery claim does not match the target turn");
          }
          await this.withThreadOperation(threadId, async () => {
            if (!(await this.queueThreadIsIdle(threadId, false, context))) throw new OpenCraftQueueRpcError(-32600, "Turn is still active");
            if (await this.historyHasClientMessage(threadId, row.clientUserMessageId, target === "unknown" ? null : target)) {
              queue.settle(threadId, itemId, "delivered");
              this.emitQueueChanged(threadId);
              return;
            }
            if (!queue.discardUnknown(threadId, itemId, target)) throw new OpenCraftQueueRpcError(-32600, "Delivery claim changed before discard");
          });
          result = { deleted: true };
        } else {
          result = { deleted: queue.delete(threadId, itemId) };
        }
        this.emitQueueChanged(threadId);
        this.scheduleQueueMaintenance(threadId);
      } else if (method === "thread/queue/reorder") {
        if (!Array.isArray(params.queuedSubmissionIds)) throw new OpenCraftQueueRpcError(-32602, "Queue order must be an array");
        if (queue.list(threadId).some(row => row.clientUserMessageId.startsWith('actor-input:'))) throw new OpenCraftQueueRpcError(-32600, 'Actor inputs retain authority ordering');
        queue.reorder(threadId, params.queuedSubmissionIds as string[]);
        result = {};
        this.emitQueueChanged(threadId);
      } else if (method === "thread/queue/start") {
        result = await this.withThreadOperation(threadId, async () => {
          if (!(await this.queueThreadIsIdle(threadId, false, context))) throw new OpenCraftQueueRpcError(-32600, "Thread is not idle");
          await this.reconcileQueue(threadId,[]);
          const row = string(params.queuedSubmissionId)
            ? queue.find(threadId, string(params.queuedSubmissionId))
            : queue.firstAwaitingAdmission(threadId);
          if (!row || row.state !== "queued") throw new OpenCraftQueueRpcError(-32600, "Queued message is unavailable");
          if (row.clientUserMessageId.startsWith('actor-input:') && row.clientUserMessageId !== `actor-input:${actorRequest}`) throw new OpenCraftQueueRpcError(-32600, 'Actor input requires its trusted admission');
          return this.dispatchQueuedStart(threadId, row.id,context);
        });
      } else if (method === "thread/queue/steer") {
        const target = string(params.expectedTurnId);
        if (!target) throw new OpenCraftQueueRpcError(-32602, "Steer requires expectedTurnId");
        result = await this.withThreadOperation(threadId, () => this.dispatchQueuedSteer(threadId, string(params.queuedSubmissionId), target,context));
      } else throw new OpenCraftQueueRpcError(-32601, `Unknown queue method ${method}`);
      this.emit({ id, result }, clientId);
    } catch (error) {
      this.emit({ id, error: { code: error instanceof OpenCraftQueueRpcError ? error.code : -32000,
        message: errorMessage(error), ...(error instanceof OpenCraftQueueRpcError && error.data !== undefined ? { data: error.data }
          : error instanceof RecoveryNotSubmitted ? {data: {notSubmitted: true, submissionOutcome: "rejected", retryable: true}} : {}) } }, clientId);
    }
  }

  // Confirmed configuration belongs to this physical connection. The in-flight
  // map only coalesces preparation; neither map is a configuration authority.
  private sessionMcpFailure(cause: unknown): RpcRecord {
    const failure = cause instanceof SessionMcpPreparationFailure ? cause : null;
    const original = failure ? failure.cause : cause;
    const detail = record(original);
    const unavailable = threadUnavailableReason(new AppServerRpcError({ code: typeof detail.code === "number" ? detail.code : -32000,
      message: errorMessage(original), data: detail.data }));
    const recovering = original instanceof SessionMcpRecoveryPending;
    const reason = unavailable ? `thread-${unavailable}` : sessionMcpReason(original);
    const stage = failure?.stage ?? "initial-preparation";
    const diagnosticId = failure?.diagnosticId ?? randomUUID();
    const nativeCode = typeof detail.code === "number" ? detail.code : null;
    const diagnostic = { diagnosticId, stage, reason, nativeCode,
      ...(failure?.nativeStatus ? { nativeStatus: failure.nativeStatus } : {}) };
    this.diagnostic({ event: "session-mcp-preparation-failed", category: recovering ? "recovering" : "unavailable",
      ...diagnostic, ...(failure ? { threadId: failure.threadId, inputId: failure.inputId,
        ...(failure.rpcFailure ? { ...failure.rpcFailure,
          rpcTransport: this.options.kind === "remote" ? "remote" : this.nativeCore ? "native-core" : "child-stdio",
          connectionGeneration: failure.connectionGeneration } : {}) } : {}) });
    const message = unavailable ? "This conversation is unavailable; input was not sent."
      : recovering ? original.message
      : reason === "thread-busy" ? "The previous turn is still active; input was not sent. Wait for it to finish and retry."
      : reason === "workspace-access-denied" ? "Session tools cannot access workspace configuration; input was not sent. Restore workspace permissions and retry."
      : reason === "execution-start-unavailable" ? "Session tools could not start; input was not sent. Check execution installation and workspace mounts."
      : reason === "sandbox-unsupported" ? "Session permissions cannot be verified; input was not sent. Start a new session or contact the host administrator."
      : reason === "environment-handoff-required" ? "This execution owner cannot safely install the current environment; input was not sent. Contact the host administrator."
      : "Session tools are unavailable; input was not sent. Reconnect and retry.";
    return { code: unavailable === "archived" ? -32071 : unavailable ? -32600 : -32000,
      message: `${message} [${stage}/${reason}; ref ${diagnosticId}]`,
      data: { code: unavailable === "archived" ? "THREAD_ARCHIVED" : unavailable ? "THREAD_NOT_FOUND"
        : recovering ? "SESSION_TOOLS_RECOVERING" : "SESSION_TOOLS_UNAVAILABLE",
        submissionOutcome: "rejected", retryable: !unavailable && sessionMcpRetryable(original), ...diagnostic } };
  }

  private async adoptCreationMcp(threadId: string, creation: SessionMcpCreation, replayable: boolean): Promise<void> {
    const generation = this.sessionMcpGeneration;
    const restored = replayable ? await this.options.restoreSessionMcp?.(threadId) : null;
    if (generation !== this.sessionMcpGeneration) throw new Error("Creation capability belongs to an expired connection");
    if (restored) {
      creation.cancel();
      this.sessionMcpInitial.set(threadId, { reservation: restored });
    } else {
      creation.bindThread?.(threadId);
      this.sessionMcpInitial.set(threadId, { reservation: creation });
    }
  }
  private readonly sessionMcpCreations = new Map<string, SessionMcpCreation>();
  private readonly sessionMcpInitial = new Map<string, { reservation: SessionMcpCreation; inputId?: string }>();
  private readonly sessionMcpRetirements = new Map<string,
    | { settings: RpcRecord; phase: "retiring" }
    | { settings: RpcRecord; phase: "restoring"; configuration: unknown; environmentKey: string | undefined }
  >();
  private readonly sessionMcpConfigurations = new Map<string, unknown>();
  // A recovered creation attests its owner, but not a freshly applied configuration key.
  // Installed configuration cache, NOT participation/executor/Goal authority.
  // It may be empty while an independent native execution is still active.
  private readonly executionEnvironments = new Map<string, { readonly owner: string; readonly key?: string; readonly account?: string | null; readonly needsGitAdmission?: boolean; bindGitExecution?(inputId: string, executionId: string): void }>();
  private readonly environmentCreations = new Map<string, ExecutionEnvironmentSnapshot>();
  private readonly initialEnvironmentThreads = new Set<string>();
  private async canInjectEnvironment(threadId?: string): Promise<boolean> {
    if (!this.nativeCore) return true;
    try {
      const health = await this.nativeCore.control.health();
      if (!health.routingEpoch) return health.environmentVariablesVersion === 1;
      if (health.environmentRoutingVersion !== 1) return false;
      return record(await this.requestPhysical("opencraft/environment/capability", { threadId })).supported === true;
    } catch { return false; }
  }
  private readonly sessionMcpRefreshes = new Map<string, Promise<void>>();
  private sessionMcpGeneration = 0;
  private async materializeCreation(value: unknown, params: RpcRecord): Promise<void> {
    const thread = record(record(value).thread), threadId = string(thread.id), path = thread.path;
    const store = this.provisionalThreads;
    // A private orchestration allocation cannot be read until Core commits its
    // custody and publishes it. Eager hydration here would prevent returning its ID.
    if (params.__opencraftDeferPublication === true || params.ephemeral === true || thread.ephemeral === true || store?.get(threadId)?.phase !== "created"
      || typeof path !== "string" || !path) return;
    const generation = this.sessionMcpGeneration;
    const current = () => {
      if (this.provisionalThreads !== store || this.sessionMcpGeneration !== generation || store?.get(threadId)?.phase !== "created") {
        throw new Error("Native creation owner changed");
      }
    };
    if (!existsSync(path)) {
      try {
        // Stock Native flushes its own session metadata before hydrating history.
        // No input, model request, resume or file write is performed by the Host.
        await this.requestPhysical("thread/read", { threadId, includeTurns: true });
      } catch (cause) {
        const fault = cause instanceof AppServerRpcError || cause instanceof OpenCraftQueueRpcError ? cause : null;
        if (fault?.code !== -32601 || !/^list_turns is not supported yet$/u.test(fault.message)
          || !nativeEmptyCreation(threadId, path)) throw cause;
      }
    }
    current();
    if (!existsSync(path)) throw new Error("Native creation was not persisted");
    if (thread.historyMode === "paginated") {
      await ensureNativeCreationIndex(threadId, async (method, requestParams) => {
        current();
        const result = await this.requestPhysical(method, requestParams);
        current();
        return result;
      });
    }
  }
  private async provisionalResult(threadId: string, params: RpcRecord = {}): Promise<RpcRecord | null> {
    const store = this.provisionalThreads;
    const created = store?.get(threadId);
    if (!created || created.phase !== "created") return null;
    const result = created.result, thread = record(result.thread);
    if (params.history != null || ["model", "modelProvider", "cwd", "path"].some(key =>
      params[key] != null && !isDeepStrictEqual(params[key], key === "path" ? thread.path : result[key] ?? thread[key]))) return null;
    const loaded = record(await this.requestPhysical("thread/loaded/list", {}));
    if (this.provisionalThreads !== store || store?.get(threadId)?.phase !== "created"
      || !Array.isArray(loaded.data) || !loaded.data.includes(threadId)) return null;
    // A native peer can accept input while this Host is absent. Positive
    // current history always defeats the saved empty creation, even if this
    // Host never observed that peer's Turn acknowledgement.
    let live = record(record(await this.requestPhysical("thread/read", { threadId, includeTurns: false })).thread);
    if (this.provisionalThreads !== store || store?.get(threadId)?.phase !== "created" || string(live.id) !== threadId) return null;
    // Metadata is safe before the first Turn; a history probe can fail and
    // materialize a rollout. Only a positively located, idle, unmaterialized
    // allocation may use creation evidence without asking for its history.
    const allocated = string(record(live.status).type) === "idle"
      && typeof live.path === "string" && live.path.length > 0
      && (!existsSync(live.path) || nativeEmptyCreation(threadId, live.path));
    try {
      if (!allocated) live = record(record(await this.requestPhysical("thread/read", { threadId, includeTurns: true })).thread);
      if (this.provisionalThreads !== store || store?.get(threadId)?.phase !== "created" || string(live.id) !== threadId) return null;
      const turns = Array.isArray(live.turns) ? live.turns : [];
      if (turns.length) {
        const first = record(turns[0]);
        store!.accepted(threadId, originalExecutionInputIds({ items: Array.isArray(first.items) ? first.items : [] })[0] ?? `native:${string(first.id)}`, string(first.id));
        return null;
      }
    } catch (cause) {
      const nativeError = cause instanceof AppServerRpcError || cause instanceof OpenCraftQueueRpcError ? cause : null;
      if (nativeError?.code !== -32600
        || !/history_missing|no rollout|thread.*not found/iu.test(nativeError.message)) throw cause;
      const stillLoaded = record(await this.requestPhysical("thread/loaded/list", {}));
      if (!Array.isArray(stillLoaded.data) || !stillLoaded.data.includes(threadId)) return null;
    }
    if (allocated) {
      const current = record(await this.requestPhysical("thread/loaded/list", {}));
      if (!Array.isArray(current.data) || !current.data.includes(threadId)) return null;
      // Older allocations may have persisted session_meta before their native
      // pagination index was confirmed. File existence alone is not readiness.
      const historyMode = live.historyMode ?? thread.historyMode;
      if (!existsSync(live.path as string) || historyMode === "paginated")
        await this.materializeCreation({ ...result, thread: { ...thread, path: live.path, historyMode } }, {});
    }
    if (this.provisionalThreads !== store || store?.get(threadId)?.phase !== "created") return null;
    // Never hide a file that has appeared since creation. Normal history remains authoritative.
    if (typeof live.path === "string" && existsSync(live.path) && !nativeEmptyCreation(threadId, live.path)) {
      store!.persisted(threadId); return null;
    }
    return { ...result, thread: { ...thread, turns: [], creationPhase: "created" } };
  }
  private async prepareSessionMcp(threadId: string, inputId?: string, executionId?: string): Promise<void> {
    try { await this.prepareSessionMcpInternal(threadId, inputId, executionId); }
    catch (cause) {
      throw cause instanceof SessionMcpPreparationFailure ? cause
        : new SessionMcpPreparationFailure("initial-preparation", cause, threadId, inputId);
    }
  }
  private async prepareSessionMcpInternal(threadId: string, inputId?: string, executionId?: string): Promise<void> {
    if (!threadId || !this.options.sessionMcp && !this.options.executionEnvironment && !this.executionGit) return;
    if (this.ephemeralThreads.has(threadId)) {
      if (this.executionGit && inputId) {
        const environment = await this.executionGit.reserve({hostId: 'local-codex', threadId, inputId});
        if (Object.keys(environment.overlay()).length) throw new Error('Git environment refresh requires a persistent native Thread');
      }
      return;
    }
    let keepInitialEnvironment = !!(this.options.executionEnvironment && inputId && this.initialEnvironmentThreads.has(threadId));
    let initial = this.sessionMcpInitial.get(threadId);
    const creation = this.provisionalThreads?.get(threadId);
    if (!initial && creation?.phase === "created") {
      const generation = this.sessionMcpGeneration;
      const reservation = await this.options.restoreSessionMcp?.(threadId);
      if (generation !== this.sessionMcpGeneration) throw new Error("Thread creation belongs to an expired connection");
      if (reservation) { initial = { reservation }; this.sessionMcpInitial.set(threadId, initial); }
    }
    // A durable creation record identifies provenance, not what an independent
    // native owner currently has configured. After reconnect or a failed handoff,
    // refresh before dispatch instead of assuming the creation environment survived.
    if (keepInitialEnvironment) {
      const runtime = this.options.executionEnvironment!;
      const currentScope = runtime.execution('local-codex', threadId, inputId);
      const current = { owner: executionEnvironmentOwner(currentScope), account: currentScope.account };
      if (current.owner !== this.executionEnvironments.get(threadId)?.owner || this.executionEnvironments.get(threadId)?.needsGitAdmission) {
        // The first admitted participant may differ from the creator. Retire the
        // native creation environment and tools before accepting that input.
        // Keep the durable creation record and cancel its reservation only once
        // the normal refresh has installed the new sender's configuration.
        keepInitialEnvironment = false;
        this.initialEnvironmentThreads.delete(threadId);
        this.executionEnvironments.delete(threadId);
        initial = undefined;
      } else {
        const applied = this.executionEnvironments.get(threadId)!;
        if (inputId && executionId) applied.bindGitExecution?.(inputId, executionId);
        if (!applied.bindGitExecution) this.executionEnvironments.set(threadId, { ...applied, account: current.account });
      }
    }
    if (initial && (!this.options.executionEnvironment && !this.executionGit || keepInitialEnvironment)
      && !this.sessionMcpRetirements.has(threadId) && (!inputId || !initial.inputId || initial.inputId === inputId)) {
      if (inputId) {
        if (!executionId) throw new Error("Session tools require an attested execution");
        initial.reservation.bind(threadId, inputId, executionId); initial.inputId = inputId;
      }
      if (!this.options.executionEnvironment && !this.executionGit || keepInitialEnvironment) return;
    }
    if (keepInitialEnvironment) {
      return;
    }
    for (;;) {
      const pending = this.sessionMcpRefreshes.get(threadId);
      if (pending) {
        await pending;
        // The provider may have changed while this caller waited. Resolve its
        // current value rather than applying a captured, possibly older value.
        continue;
      }
      const generation = this.sessionMcpGeneration;
      const operation = Promise.resolve().then(() => this.refreshSessionMcp(threadId, generation, inputId, executionId)).finally(() => {
        if (this.sessionMcpRefreshes.get(threadId) === operation) this.sessionMcpRefreshes.delete(threadId);
      });
      this.sessionMcpRefreshes.set(threadId, operation);
      return operation;
    }
  }

  private async refreshSessionMcp(threadId: string, generation: number, inputId?: string, executionId?: string): Promise<void> {
    let stage: SessionMcpStage = "resolve-tools";
    let rpcFailure: SessionMcpRpcFailureDiagnostic | undefined;
    let nativeStatus: string | undefined;
    try {
      const current = () => {
        if (generation !== this.sessionMcpGeneration) throw new Error("Session tool preparation belongs to an expired connection");
      };
      stage = "resolve-tools";
      const configuration = structuredClone(await this.options.sessionMcp?.(threadId, inputId, executionId) ?? null);
      stage = "resolve-environment";
      let environment = this.executionGit && inputId
        ? await this.executionGit.reserve({hostId: 'local-codex', threadId, inputId})
        : this.options.executionEnvironment?.snapshot(this.options.executionEnvironment.execution('local-codex', threadId, inputId));
      if (environment && !await this.canInjectEnvironment(threadId)) {
        // An empty requested environment does not prove that an independent
        // Native owner has cleared credentials installed by a previous owner.
        throw new Error("Environment variables require a Codex owner handoff");
      }
      if (environment) { await environment.ready(); environment.apply(process.env); }
      current();
      const previous = this.sessionMcpConfigurations.get(threadId);
      if (!this.sessionMcpRetirements.has(threadId)
        && (isDeepStrictEqual(previous, configuration) || (configuration === null && previous === undefined))
        && (!environment || environment.key === this.executionEnvironments.get(threadId)?.key)) return;
      const request = async (method: string, params: RpcRecord): Promise<unknown> => {
        current();
        const started = performance.now();
        let result: unknown;
        try { result = await this.requestPhysical(method, params); }
        catch (cause) {
          rpcFailure = { rpcMethod: method, rpcElapsedMs: Math.round(performance.now() - started),
            nativeErrorHint: sessionMcpNativeErrorHint(cause) };
          throw cause;
        }
        current();
        return result;
      };
      stage = "read-thread";
      const read = record(await request("thread/read", { threadId, includeTurns: false }));
      const thread = record(read.thread);
      if (thread.ephemeral === true) {
        this.ephemeralThreads.add(threadId);
        if (environment && Object.keys(environment.overlay()).length) throw new Error('Git environment refresh requires a persistent native Thread');
        return;
      }
      stage = "check-idle";
      let status = string(record(thread.status).type);
      nativeStatus = ["idle", "systemError", "notLoaded", "active"].includes(status) ? status : "unknown";
      if (!["idle", "systemError", "notLoaded"].includes(status)) throw new Error("Wait until the Codex thread is idle before changing its tools");
      this.cancelNativeRelease(threadId);
      const retirement = this.sessionMcpRetirements.get(threadId);
      const waitForUnload = async () => {
        stage = "wait-for-unload";
        this.nativeUnloadDiagnostic(threadId, "waiting", { status: nativeStatus, pendingRetirement: !!retirement });
        // Native unsubscribe releases a subscription, not the Thread runtime.
        // Keep this admitted input in preparation while native's retirement runs;
        // never resubmit input or reattach the old runtime to poll readiness.
        // Tool-only refresh has the same asynchronous retirement boundary.
        // Allow a short reconciliation window before returning a retryable
        // refusal; the environment handoff retains its longer existing budget.
        const deadline = Date.now() + (this.options.executionEnvironment || this.executionGit ? 90_000 : 1_000);
        while (status !== "notLoaded") {
          current();
          if (Date.now() >= deadline) throw new SessionMcpRecoveryPending();
          const snapshot = record(await request("thread/read", { threadId, includeTurns: false }));
          status = string(record(record(snapshot.thread).status).type);
          nativeStatus = ["idle", "systemError", "notLoaded", "active"].includes(status) ? status : "unknown";
          if (!["idle", "systemError", "notLoaded"].includes(status)) throw new SessionMcpRecoveryPending();
          if (status !== "notLoaded") await new Promise<void>(resolve => setTimeout(resolve, 250));
        }
        this.nativeUnloadDiagnostic(threadId, "confirmed");
      };
      if (retirement?.phase === "retiring" && status !== "notLoaded") await waitForUnload();
      const alreadyApplied = retirement?.phase === "restoring" && status !== "notLoaded"
        && isDeepStrictEqual(retirement.configuration, configuration)
        && retirement.environmentKey === environment?.key;
      stage = "capture-settings";
      const live = retirement?.settings ?? (status === "notLoaded" ? {} : record(await request("thread/resume", { threadId, excludeTurns: true })));
      const resume: RpcRecord = {};
      for (const key of ["model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer"])
        if (live[key] !== undefined) resume[key] = live[key];
      stage = "preserve-permissions";
      const profile = string(record(live.activePermissionProfile).id);
      if (profile) resume.permissions = profile;
      else {
        const sandbox = record(live.sandbox), modes: Record<string, string> = { dangerFullAccess: "danger-full-access", readOnly: "read-only", workspaceWrite: "workspace-write" };
        // An unloaded Native owner cannot supply live settings. Omitting sandbox
        // here would apply its current default, which may be more permissive.
        const mode = Object.hasOwn(modes, string(sandbox.type)) ? modes[string(sandbox.type)] : undefined;
        if (!mode) throw new Error("Cannot preserve this Codex sandbox while refreshing tools");
        resume.sandbox = mode;
      }
      // Once native configuration can change, the old confirmation is no longer
      // valid either. A partial failure must not make a later rollback look applied.
      this.sessionMcpConfigurations.delete(threadId);
      this.executionEnvironments.delete(threadId);
      if (!alreadyApplied && status !== "notLoaded") {
        this.sessionMcpRetirements.set(threadId, { settings: live, phase: "retiring" });
        stage = "unsubscribe";
        await request("thread/unsubscribe", { threadId });
        this.nativeSubscribedThreads.delete(threadId);
        await waitForUnload();
      }
      if (!alreadyApplied) {
        stage = "apply-tools";
        await request("thread/resume", { ...resume, threadId, excludeTurns: true, config: {
          "mcp_servers.opencraft_session": configuration ?? { enabled: false, url: "http://127.0.0.1:1/mcp" },
          ...(environment ? { 'shell_environment_policy.set': environment.overlay() } : {}),
        } });
        this.sessionMcpRetirements.set(threadId, { settings: live, phase: "restoring", configuration, environmentKey: environment?.key });
      }
      if (Object.keys(live).length) {
        const settings: RpcRecord = { threadId };
        if (profile) settings.permissions = profile;
        else if (live.sandbox) settings.sandboxPolicy = live.sandbox;
        for (const key of ["approvalPolicy", "approvalsReviewer", "model", "serviceTier", "collaborationMode"])
          if (live[key] !== undefined && live[key] !== null) settings[key] = live[key];
        if (live.reasoningEffort) settings.effort = live.reasoningEffort;
        stage = "restore-settings";
        await request("thread/settings/update", settings);
      }
      this.sessionMcpConfigurations.set(threadId, configuration);
      if (environment) this.executionEnvironments.set(threadId, environment);
      this.sessionMcpRetirements.delete(threadId);
      stage = "release-initial";
      this.sessionMcpInitial.get(threadId)?.reservation.cancel();
      this.sessionMcpInitial.delete(threadId);
    } catch (cause) {
      throw new SessionMcpPreparationFailure(stage, cause, threadId, inputId, nativeStatus, rpcFailure, generation);
    }
  }

  private async writePhysical(message: RpcRecord, admit?: () => boolean): Promise<void> {
    if (message.method === "thread/fork") {
      const params = record(message.params);
      // Native fork starts from Host defaults, even when its source is loaded.
      // Copy only execution choices; credentials and tool configuration retain
      // their own lifecycle. A path fork ignores threadId, so do not read it.
      if (string(params.threadId) && !string(params.path)) {
        const source = record(await this.requestPhysical("thread/resume", { threadId: params.threadId, excludeTurns: true }));
        const inherited: RpcRecord = {};
        for (const key of ["model", "modelProvider", "serviceTier"])
          if (!Object.hasOwn(params, key) && source[key] !== undefined) inherited[key] = source[key];
        const config = record(params.config);
        if (!Object.hasOwn(config, "model_reasoning_effort") && source.reasoningEffort != null) {
          inherited.config = { ...config, model_reasoning_effort: source.reasoningEffort };
        }
        message = { ...message, params: { ...params, ...inherited } };
      }
    }
    const initialEnvironment = this.environmentCreations.get(String(message.id));
    if ((message.method === "thread/start" || message.method === "thread/fork") && initialEnvironment) {
      const params = record(message.params);
      message = { ...message, params: { ...params, config: { ...record(params.config), "shell_environment_policy.set": initialEnvironment.overlay() } } };
    }
    if ((message.method === "thread/start" || message.method === "thread/fork")
      && record(message.params).ephemeral === true && this.options.sessionMcp) {
      const params = record(message.params);
      message = { ...message, params: { ...params, config: { ...record(params.config),
        "mcp_servers.opencraft_session": { enabled: false, url: "http://127.0.0.1:1/mcp" },
      } } };
    }
    if (message.method === "thread/start" && record(message.params).ephemeral !== true && this.options.createSessionMcp) {
      const generation = this.sessionMcpGeneration;
      const creation = await this.options.createSessionMcp();
      if (generation !== this.sessionMcpGeneration) { creation.cancel(); throw new Error("Thread creation belongs to an expired connection"); }
      const params = record(message.params);
      params.config = { ...record(params.config), "mcp_servers.opencraft_session": creation.configuration };
      this.sessionMcpCreations.set(String(message.id), creation);
    }
    if (message.method === "turn/start") {
      const params = record(message.params), threadId = string(params.threadId);
      const inputId = string(params.clientUserMessageId) || `internal-input:${randomUUID()}`;
      message = { ...message, params: { ...params, clientUserMessageId: inputId } };
      const executionId = await this.beginExecution(threadId, inputId);
      try { await this.prepareSessionMcp(threadId, inputId, executionId); }
      catch (cause) { this.retireGatewayAdmission(params);throw new RecoveryNotSubmitted(string(this.sessionMcpFailure(cause).message), { cause }); }
    }
    if ((this.nativeCore?.supportsOrchestration || this.nativeCore?.supportsOrchestrationRouting) && (message.method === "turn/start" || message.method === "turn/steer")) {
      const params=record(message.params),delegationId=this.options.collaboration?.inputDelegation?.(string(params.threadId),string(params.clientUserMessageId),string(params.expectedTurnId)||undefined);
      message={...message,params:{...params,__opencraftDelegationId:delegationId??null}};
    }
    if (this.options.collaboration && message.method === "thread/start") {
      const params = record(message.params), tools = Array.isArray(params.dynamicTools) ? params.dynamicTools : [];
      const owned = (this.nativeCore?.supportsOrchestration || this.nativeCore?.supportsOrchestrationRouting) && this.options.collaboration.orchestration
        ? [...CONVERSATION_TOOLS,...THREAD_ORCHESTRATION_TOOLS.filter(tool=>tool.name!=='thread_set_title'||this.nativeCore?.supportsThreadTitle)] : CONVERSATION_TOOLS;
      const names = new Set<string>([...CONVERSATION_TOOLS,...THREAD_ORCHESTRATION_TOOLS].map(t=>t.name));
      message = {...message, params:{...params,dynamicTools:[...tools.filter(t=>!names.has(string(record(t).name))),...owned.map(t=>({type:"function",...t}))]}};
    }
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
    try {
      if (isCodexAdmission(message.method, message.params) && this.executionBlocked(string(record(message.params).threadId))) throw new RecoveryNotSubmitted("Execution environment is recovering");
      if (admit && (!this.physicalAvailable || !admit())) throw new RecoveryNotSubmitted("Automatic recovery was revoked before native submission");
      if(configuredModelGatewayPath() && (message.method==="turn/start" || message.method==="turn/steer")) {
        const p=record(message.params),key=JSON.stringify([string(p.threadId),string(p.clientUserMessageId)]),check=this.gatewayChecks.get(key);
        if(!check) {
          const path=configuredModelGatewayPath()!,store=new ModelGatewayStore(path);
          try{if(store.execution(string(p.threadId))?.state==='active'||requiresModelGateway(p.model,path))throw new RecoveryNotSubmitted("Model execution authorization is unavailable");}finally{store.close();}
        }
        try{check?.();}catch(cause){if(message.method==="turn/start")this.retireGatewayAdmission(p);throw cause;}finally{this.gatewayChecks.delete(key);}
      }
      if (message.method === "turn/start" && this.executionLeases) {
        const params = record(message.params);
        const inputId = string(params.clientUserMessageId) || `internal-input:${randomUUID()}`;
        message = { ...message, params: { ...params, clientUserMessageId: inputId } };
        // This durable write precedes the physical send: native tools may start before the ACK.
        this.executionLeases.begin(string(params.threadId), inputId, this.nativeCore?.executionIncarnation);
      }
      if (message.method === "turn/start") this.provisionalThreads?.attempted(string(record(message.params).threadId), string(record(message.params).clientUserMessageId));
      if (this.options.kind === "remote") {
        return await this.options.transport.send(JSON.stringify(message)).catch(() => {
          this.rejectInternalRequests(new Error("Remote delivery outcome is unknown"));
          this.publishStatus({ state: "failed", reason: "Remote delivery outcome is unknown", failure: { code: "SSH_DELIVERY_UNKNOWN", recovery: "automatic" } });
          throw new Error("Remote delivery outcome is unknown");
        });
      }
      if (this.nativeCore) return await this.nativeTransport!.send(JSON.stringify(message));
      if (this.child === null || this.child.stdin.destroyed) throw new Error("Codex AppServer stdin is closed");
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      const creation = this.sessionMcpCreations.get(String(message.id));
      if (creation) { creation.cancel(); this.sessionMcpCreations.delete(String(message.id)); }
      throw error;
    }
  }

  private emit(message: RpcRecord, clientId?: string, method = ""): void {
    if ("result" in message && this.options.collaboration?.topology) message = {...message,
      result:projectThreadTopologyResult(method,message.result,id => this.options.collaboration!.topology!(id))};
    const started = performance.now();
    const frame = serializeHistoryReply(clientId ? { ...message, [LOGICAL_CLIENT_FIELD]: clientId } : message, method);
    const serialized = performance.now();
    for (const listener of this.listeners) listener(frame);
    const timing = record(record(message.result).__opencraftHistoryTiming);
    if (typeof timing.pairId === "string") this.historyDiagnostic({ event: "history-read-return", pairId: timing.pairId,
      method, bytes: Buffer.byteLength(frame), serializeMs: serialized - started, publishMs: performance.now() - serialized });
  }

  private readonly fail = (error: Error): void => {
    this.executionLeases?.suspend();
    this.revokeDesktopOwners();
    this.rejectInternalRequests(error);
    for(const request of this.pending.values())if(request.usageAttemptId)this.tokenUsage?.attemptOutcome(request.usageAttemptId,"unknown");
    for (const timer of this.goalContinuationTimers.values()) clearTimeout(timer);
    this.goalContinuationTimers.clear();
    this.publishStatus({ state: "failed", reason: error.message, failure: { code: "codex-appserver-exited", recovery: "automatic" } });
  };

  private publishStatus(status: TransportStatus): void {
    if (['failed', 'closing', 'closed'].includes(status.state)) this.options.executionAuthority?.invalidate();
    this.statusValue = status;
    if (["failed", "closing", "closed"].includes(status.state)) {
      this.durableCatalog?.resetExecution();
      for (const call of this.nativeToolCalls.values()) call.abort.abort();
      this.humanInteractions.markSourceUnavailable();
      this.threadTitles?.reset();
      this.sessionMcpGeneration += 1;
      this.sessionMcpConfigurations.clear();
      this.sessionMcpRefreshes.clear();
      this.environmentCreations.clear(); this.executionEnvironments.clear(); this.initialEnvironmentThreads.clear();

      for (const creation of this.sessionMcpCreations.values()) creation.cancel();
      for (const [threadId, initial] of this.sessionMcpInitial)
        if (!initial.reservation.bindThread) initial.reservation.cancel();
      this.sessionMcpCreations.clear(); this.sessionMcpInitial.clear(); this.sessionMcpRetirements.clear();
    }
    for (const listener of this.statusListeners) listener(status);
  }
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { acquireCodexWriter, CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { BridgeGatewayOptions } from "@opencraft/agent-bridge-host/gateway";
import type {
  DuplexTransport,
  TransportStatus,
  TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import type { AppServerThread } from "@opencraft/appserver-protocol";
import {
  COLLABORATION_CAPABILITIES,
  COLLABORATION_METHOD,
  type CollaborationCapabilities,
} from "@opencraft/appserver-protocol/collaboration";
import {
  OPENCRAFT_DESKTOP_ATTACH,
  OPENCRAFT_DESKTOP_EXTENSION,
  OPENCRAFT_DESKTOP_RELEASE,
} from "@opencraft/appserver-protocol/desktop";
import type { GitExecutionHandoff, GitExecutionReservation } from "@opencraft/execution-environment/git-execution";
import type { HumanGitExecutionPort } from "@opencraft/execution-environment/human-git-execution";
import type { LocalDesktopOwner, LocalDesktopService } from "@opencraft/local-agent-host/desktop";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { BridgeExecutionAdmissionTransport, type BridgeExecutionAdmissionPort } from "./bridge-execution-admission.js";
import { codexAttachmentsService, type CodexAttachmentsOptions } from "./codex-attachments-service.js";
import { resolveCodexPermissions } from "./codex-bridge-host.js";
import { collaborationQueueGuard, type CollaborationQueueOwners } from "./codex-bridge-owners.js";
import { codexContinuationService, type CodexContinuationService } from "./codex-continuation-service.js";
import {
  CodexHostServices,
  codexAccountsService,
  codexMaintenanceService,
  codexModelsService,
  codexPinsService,
  codexTasksService,
  codexTitlesService,
  type CodexHostService,
  type CodexHostServiceClients,
} from "./codex-host-services.js";
import { codexLegacyHandoffService } from "./codex-legacy-handoff.js";
import { codexAdmissionPaused } from "./codex-maintenance.js";
import { reportedCodexExecution, type CodexRuntimeEndpoints } from "./codex-native-core-transport.js";
import { CodexNativeFallback } from "./codex-native-fallback.js";
import { CodexNativeReader } from "./codex-native-reader.js";
import { CodexNativeStorage } from "./codex-native-storage.js";
import { CodexOrchestrationControl, OrchestrationControlError } from "./codex-orchestration-control.js";
import { CodexProviderBridge } from "./codex-provider-bridge.js";
import { codexSchedulesService } from "./codex-schedules-service.js";
import {
  ExecutionLeaseStore,
  originalExecutionInputIds,
  snapshotExecutionSubmission,
} from "./execution-lease-store.js";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import {
  assertSubmissionIdentity,
  readThreadMessageIds,
  ThreadIdentity,
  type ThreadMetadataFactory,
} from "./thread-identity.js";
import { TokenUsageCollector } from "./token-usage-collector.js";
import { OpenCraftTokenUsageLedger, type UsageSubmission } from "./token-usage-ledger.js";
import { labelUsagePeople } from "./token-usage-people.js";
import { TokenUsageQueryError } from "./token-usage-query.js";
import { TokenUsageQueryService } from "./token-usage-query-service.js";
import { CodexTokenUsageRuntime } from "./token-usage-runtime.js";
import { TokenUsageStateDatabase } from "./token-usage-state-database.js";
import { TokenUsageTelemetry } from "./token-usage-telemetry.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export interface ServerCodexBridgeHostOptions {
  readonly coreEndpoint: string;
  readonly coreAuthToken: string;
  readonly coreRuntime?: CodexRuntimeEndpoints;
  readonly bridge: BridgeGatewayOptions;
  readonly admission: BridgeExecutionAdmissionPort;
  readonly codexDataDirectory: string;
  readonly artifactDirectory?: string;
  readonly prepareArtifact?: CodexAttachmentsOptions["prepareArtifact"];
  readonly readGeneratedFile?: CodexAttachmentsOptions["readGeneratedFile"];
  readonly createThreadMetadata?: ThreadMetadataFactory;
  readonly createExecutionGit?: (native: {
    inspect(value: GitExecutionHandoff): Promise<boolean>;
    inspectReservation(value: GitExecutionReservation): Promise<boolean>;
  }) => Pick<HumanGitExecutionPort, "reserve" | "prepare" | "close">;
  readonly tokenUsage?: {
    readonly queryWorkerEntry?: string;
    readonly serverId: string;
    readonly actor: (
      context: NonNullable<TransportSubmissionContext["actorContext"]>,
    ) => { id: string; kind: "human" | "session" } | null;
    readonly submission?: (threadId: string, inputId: string) => UsageSubmission | null;
    readonly person?: (actorId: string) => { kind: string; displayName: string } | null;
    readonly derivedQueries?: TokenUsageQueryService;
  };
  readonly collaboration?: {
    readonly capabilities?: CollaborationCapabilities;
    command(
      context: NonNullable<TransportSubmissionContext["actorContext"]>,
      body: Value,
      submission?: TransportSubmissionContext,
    ): Promise<unknown>;
    authorize(
      context: NonNullable<TransportSubmissionContext["actorContext"]>,
      threadId: string,
      inputId: string,
      input?: readonly unknown[],
    ): void;
    prepare?(
      context: NonNullable<TransportSubmissionContext["actorContext"]>,
      input: readonly unknown[],
    ): Promise<unknown>;
    topology?(threadId: string): { parentThreadId: string | null; visibility: "visible" | "hidden" } | null;
  };
  readonly collaborationInput?: CollaborationQueueOwners["collaborationInput"];
  readonly nativeTool?: (
    context: { threadId: string; turnId: string; callId: string },
    tool: { namespace: string | null; name: string },
    args: unknown,
    signal: AbortSignal,
  ) => Promise<unknown> | null;
  readonly creationTools?: () => readonly Record<string, unknown>[];
  readonly filterGatewayModelCatalog?: (path: string, actorId: string | null, models: unknown[]) => Promise<unknown[]>;
  readonly modelViewer?: (context: TransportSubmissionContext) => string | null;
  readonly desktop?: LocalDesktopService;
  readonly projectlessWorkspaceDirectory?: string;
  readonly storageOpened?: (outcomes: readonly { name: string; outcome: DatabaseOutcome }[]) => void;
}

/**
 * Single-stack Server Codex Host: every Codex Thread runs through the provider
 * bridge over `CodexNativeFallback` with standalone Host services and owners —
 * no `CodexEngineAdapter` instance, duplicate native connection, or duplicate
 * Host queue / recovery / schedule loops underneath.
 */
export function createServerCodexBridgeHost(options: ServerCodexBridgeHostOptions): CodexHostServices {
  const directory = options.codexDataDirectory;
  const reader = new CodexNativeReader(options.coreEndpoint, options.coreAuthToken, 30_000, options.coreRuntime);
  const control = new CodexCoreControlClient(options.coreEndpoint, options.coreAuthToken);
  const paused = () => codexAdmissionPaused(directory);
  const hostIncarnation = randomUUID();

  let releaseOverlaysLock: (() => void | Promise<void>) | undefined;
  let cachedCodexHome = "";
  let hostState: OpenCraftHostStateDatabase | undefined;
  let identity: ThreadIdentity | undefined;
  let executionLeases: ExecutionLeaseStore | undefined;
  let tokenUsageState: TokenUsageStateDatabase | undefined;
  let tokenUsage: CodexTokenUsageRuntime | TokenUsageCollector | null = null;
  let tokenUsageQueries: TokenUsageQueryService | null = null;
  let tokenUsageStorageUnavailable = false;
  let closed = false;
  let openingStores: Promise<void> | undefined;

  const gitNativeIncarnation = async (): Promise<string | undefined> => {
    if (closed) return undefined;
    return reportedCodexExecution(await reader.health(AbortSignal.timeout(1500)));
  };

  const inspectGitNative = async (value: GitExecutionHandoff | GitExecutionReservation): Promise<boolean> => {
    try {
      const threadId = value.scope.threadId;
      const incarnation = await gitNativeIncarnation();
      if (!incarnation || incarnation !== value.native.incarnation) return false;
      if ("turnId" in value.native) {
        const page = object(
          await reader.request("thread/turns/list", {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          }),
        );
        const turn = object(Array.isArray(page.data) && page.data.length === 1 ? page.data[0] : null);
        if (turn.id !== value.native.turnId || turn.status !== "inProgress") return false;
        const state = object(object(await reader.request("thread/read", { threadId, includeTurns: false })).thread);
        if (object(state.status).type !== "active") return false;
      }
      return !closed && (await gitNativeIncarnation()) === incarnation;
    } catch {
      return false;
    }
  };

  const executionGit = options.createExecutionGit?.({
    inspect: inspectGitNative,
    inspectReservation: inspectGitNative,
  });

  const attachments = codexAttachmentsService({
    directory,
    artifactDirectory: options.artifactDirectory,
    prepareArtifact: options.prepareArtifact,
    readGeneratedFile: options.readGeneratedFile,
    codexHome: async () => {
      const home = object(await reader.initializeResult()).codexHome;
      return typeof home === "string" ? home : undefined;
    },
  });

  const usageSubmissionByRecord = () => {
    const submission = options.tokenUsage?.submission;
    return submission
      ? (threadId: string, inputId: string) => submission(identities.toPublic(threadId) ?? threadId, inputId)
      : undefined;
  };
  const usageIdentity = (
    recordThreadId: string,
    publicThreadId: string,
    inputId: string,
    mode: "start" | "steer",
    context: TransportSubmissionContext,
  ): UsageSubmission => {
    const actor = context.actorContext ? options.tokenUsage?.actor(context.actorContext) : null;
    const trusted = options.tokenUsage?.submission?.(publicThreadId, inputId);
    return {
      threadId: recordThreadId,
      inputId,
      actorId: trusted?.sourceKind === "system" ? trusted.actorId : (actor?.id ?? trusted?.actorId ?? null),
      actorKind:
        trusted?.sourceKind === "system" ? trusted.actorKind : (actor?.kind ?? trusted?.actorKind ?? "unknown"),
      mode,
      sourceKind:
        trusted?.sourceKind === "system"
          ? "system"
          : actor?.kind === "human"
            ? "human"
            : actor?.kind === "session"
              ? "system"
              : (trusted?.sourceKind ?? "unknown"),
      submittedAt: Date.now(),
    };
  };

  const reportStorage = () => {
    if (!options.storageOpened) return;
    options.storageOpened([
      ...(hostState ? [{ name: "opencraft-host-state", outcome: hostState.outcome }] : []),
      ...(servicesRef?.storage() ?? []),
    ]);
  };

  const ensureStoresOpen = (): Promise<void> =>
    (openingStores ??= (async () => {
      await mkdir(join(directory, "runtime"), { recursive: true, mode: 0o700 });
      releaseOverlaysLock = await acquireCodexWriter(join(directory, "host-overlays-owner"));
      try {
        hostState = new OpenCraftHostStateDatabase(directory);
        executionLeases = new ExecutionLeaseStore(hostState.sql);
        executionLeases.suspend();
        identity = new ThreadIdentity(hostState.database, {
          createMetadata: options.createThreadMetadata,
          databasePath: hostState.path,
          readMessageIds: (threadId, turnId, signal) =>
            readThreadMessageIds(
              (method, params) => servicesRef!.request(method, params, 30_000),
              threadId,
              turnId,
              signal,
            ),
          notify: (method, params) => servicesRef?.broadcast(method, params),
        });
        if (options.tokenUsage) {
          try {
            const telemetry = new TokenUsageTelemetry();
            tokenUsageState = new TokenUsageStateDatabase(directory, hostState.path);
            const usageEntry = options.tokenUsage.queryWorkerEntry;
            const derived = options.tokenUsage.derivedQueries;
            if (usageEntry) {
              tokenUsage = await TokenUsageCollector.start(
                {
                  entry: usageEntry,
                  directory,
                  serverId: options.tokenUsage.serverId,
                  projectLegacy: derived ? false : undefined,
                  submission: !!options.tokenUsage.submission,
                  derived: !!derived,
                },
                {
                  request: (method, params) => reader.request(method, params),
                  submission: usageSubmissionByRecord(),
                  diagnostic: () => {},
                  invalidate: derived ? (threadId, path) => derived.invalidate(threadId, path) : undefined,
                  failed: () => {
                    tokenUsage = null;
                  },
                },
              );
            } else {
              const initHome = object(await reader.initializeResult().catch(() => null)).codexHome;
              if (typeof initHome === "string" && initHome) cachedCodexHome = initHome;
              const nativeStorage = new CodexNativeStorage(() => cachedCodexHome || join(directory, "runtime"));
              tokenUsage = new CodexTokenUsageRuntime(
                new OpenCraftTokenUsageLedger(tokenUsageState, options.tokenUsage.serverId, Date.now, telemetry, {
                  projectLegacy: derived ? false : undefined,
                }),
                {
                  request: (method, params) => reader.request(method, params),
                  source: (threadId, path) => nativeStorage.resolve(threadId, path),
                  submission: usageSubmissionByRecord(),
                  diagnostic: () => {},
                  derived,
                },
              );
            }
            if (derived) tokenUsageQueries = derived;
            else if (usageEntry) {
              tokenUsageQueries = new TokenUsageQueryService({
                entry: usageEntry,
                databasePath: join(directory, "token-usage.sqlite"),
                serverId: options.tokenUsage.serverId,
                telemetry,
              });
            }
          } catch {
            tokenUsageStorageUnavailable = true;
            if (!options.tokenUsage.derivedQueries) tokenUsageQueries?.close();
            tokenUsageQueries = null;
            const usage = tokenUsage;
            tokenUsage = null;
            if (usage instanceof TokenUsageCollector) await usage.close().catch(() => {});
            else usage?.close();
            tokenUsageState?.close();
            tokenUsageState = undefined;
          }
        }
        reportStorage();
      } catch (error) {
        await identity?.close().catch(() => {});
        identity = undefined;
        hostState?.close();
        hostState = undefined;
        await Promise.resolve(releaseOverlaysLock?.()).catch(() => {});
        releaseOverlaysLock = undefined;
        openingStores = undefined;
        throw error;
      }
    })());

  const fallback = new CodexNativeFallback(reader);
  const statefulFallback: DuplexTransport = {
    get status(): TransportStatus {
      return fallback.status;
    },
    subscribeStatus: (listener) => fallback.subscribeStatus(listener),
    subscribeMessage: (listener) => fallback.subscribeMessage(listener),
    async connect() {
      await ensureStoresOpen();
      await fallback.connect();
    },
    send: (raw) => fallback.send(raw),
    sendWithContext: (raw, context) => fallback.sendWithContext(raw, context),
    close: () => fallback.close(),
  };

  let continuation: CodexContinuationService | undefined;
  let titles: ReturnType<typeof codexTitlesService> | undefined;

  const bridge = new CodexProviderBridge(statefulFallback, options.bridge, {
    exclusive: true,
    admissionPaused: paused,
    resolvePermissions: (selection, cwd) => resolveCodexPermissions(reader, selection, cwd),
    projectlessWorkspace: async () => {
      const root =
        options.projectlessWorkspaceDirectory ||
        process.env.OPENCRAFT_CODEX_PROJECTLESS_DIR ||
        join(directory, "projectless-workspaces");
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(join(root, "thread-"));
    },
    nativeTool: options.nativeTool,
    creationTools: options.creationTools,
    prepareInput: async (threadId, clientId, input, context, purpose) => {
      if (purpose === "queue-edit") {
        assertSubmissionIdentity(context);
        return attachments.prepareInput(threadId, undefined, input);
      }
      if (clientId || context.sender) {
        if (!identity) {
          if (context.sender) throw new Error("Message sender storage is unavailable");
        } else {
          identity.recordSubmission({ threadId, clientUserMessageId: clientId ?? "" }, context);
        }
      }
      return attachments.prepareInput(threadId, clientId, input);
    },
    projectHistory: (method, params, result) => {
      const attached = attachments.projectHistory(method, params, result);
      return identity ? identity.projectResult(method, params, attached) : attached;
    },
    projectNotification: (frame) => {
      try {
        identity?.observeNotification(frame);
      } catch {
        /* metadata observer never alters delivery */
      }
      const attributed = identity ? identity.projectNotification(frame) : frame;
      return attachments.projectNotification(attributed);
    },
    observeTitle: (method, params, result) => {
      void result;
      if (method === "thread/name/set" || method === "thread/archive" || method === "thread/delete") {
        const publicId = identities?.toPublic(text(params.threadId)) ?? text(params.threadId);
        if (publicId) titles?.beforeRoute?.(method, { threadId: publicId });
      }
    },
    observeIdentityResult: (method, params, result, sender) => {
      try {
        identity?.observeResult(method, params, result, sender);
      } catch {
        /* metadata observer never alters response */
      }
    },
    beforeUserInput: (method, threadId) => {
      continuation?.beforeRoute?.(method, { threadId });
    },
    senderAttribution: () => identity !== undefined,
    ...(executionGit
      ? {
          executionGit: {
            prepare: async (nativeThreadId, inputId, context) => {
              if (!executionLeases) throw new Error("git_execution_unavailable");
              assertSubmissionIdentity(context);
              executionLeases.capture(nativeThreadId, inputId, snapshotExecutionSubmission(context));
              const incarnation = await gitNativeIncarnation();
              if (!incarnation) {
                executionLeases.outcome(nativeThreadId, inputId, true);
                throw new Error("git_execution_unavailable");
              }
              executionLeases.begin(nativeThreadId, inputId, incarnation);
              try {
                const snapshot = await executionGit.reserve({
                  hostId: "local-codex",
                  threadId: nativeThreadId,
                  inputId,
                });
                await snapshot.ready();
                assertSubmissionIdentity(context);
                return {
                  environment: snapshot.overlay(),
                  settle: (outcome, nativeTurnId) => {
                    try {
                      if (outcome === "accepted" && nativeTurnId)
                        executionLeases!.started(nativeThreadId, nativeTurnId, inputId);
                      else executionLeases!.outcome(nativeThreadId, inputId, outcome === "rejected");
                    } catch {
                      /* lease reconciliation runs on next startup */
                    }
                  },
                };
              } catch {
                executionLeases.outcome(nativeThreadId, inputId, true);
                throw new Error("git_execution_unavailable");
              }
            },
            notification: (method, params) => {
              const threadId = text(params.threadId),
                turnId = text(params.turnId);
              if (!executionLeases || !threadId || !turnId) return;
              try {
                if (method === "turn/started" || method === "turn/completed") {
                  executionLeases.observedStart(threadId, turnId);
                  if (method === "turn/completed") executionLeases.finished(threadId, turnId);
                } else {
                  const inputId = originalExecutionInputIds({ items: [params.item] })[0];
                  if (
                    inputId &&
                    executionLeases
                      .unsettledTargets(threadId)
                      .some((target) => target.inputId === inputId && target.turnId === null)
                  )
                    executionLeases.observedInput(threadId, turnId, inputId);
                }
              } catch {
                /* lease reconciliation runs on next startup */
              }
            },
          },
        }
      : {}),
    usage: {
      notification: (method, params) => {
        try {
          tokenUsage?.notification(method, params);
        } catch {
          /* usage collection never blocks notifications */
        }
      },
      begin: async (nativeThreadId, publicThreadId, inputId, mode, context) => {
        if (!tokenUsage || !nativeThreadId || !inputId) return undefined;
        try {
          const attemptId = randomUUID();
          await tokenUsage.attempt(
            attemptId,
            nativeThreadId,
            inputId,
            mode,
            usageIdentity(nativeThreadId, publicThreadId, inputId, mode, context),
          );
          return attemptId;
        } catch {
          return undefined;
        }
      },
      settle: (attemptId, outcome, nativeThreadId, inputId, nativeTurnId) => {
        try {
          tokenUsage?.attemptOutcome(attemptId, outcome, outcome === "accepted" ? (nativeTurnId ?? null) : null);
          if (outcome === "accepted" && nativeTurnId)
            tokenUsage?.admission({ threadId: nativeThreadId, turnId: nativeTurnId }, inputId);
        } catch {
          /* usage collection never blocks turns */
        }
      },
    },
    queueGuard: collaborationQueueGuard({
      collaboration: options.collaboration,
      collaborationInput: options.collaborationInput,
    }),
    topology: options.collaboration?.topology,
    releaseForAdoption: async () => true,
  });

  const identities = bridge.threadIdentities();
  const admittedRouting = new BridgeExecutionAdmissionTransport(bridge, options.admission, true);

  const servicesRef: CodexHostServices = new CodexHostServices(
    admittedRouting,
    (clients) => {
      titles = codexTitlesService(reader, clients, identities);
      continuation = codexContinuationService({
        directory,
        clients,
        admissionOpen: () => !paused(),
        accounts: async () => object(await control.accountRequest("opencraft/codex/accounts/list", {})).accounts,
        native: reader,
        identities,
      });

      const services: CodexHostService[] = [
        codexTasksService(join(directory, "tasks.sqlite"), clients, reportStorage),
        codexAccountsService(control),
        codexModelsService(reader, options.modelViewer, options.filterGatewayModelCatalog),
        codexPinsService(reader, clients, identities),
        titles,
        attachments,
        continuation,
        codexSchedulesService({ directory, clients, native: reader, admissionOpen: () => !paused() }),
        codexMaintenanceService({
          paused,
          bridge: () => bridge.maintenance(),
          continuation: () => continuation!.counts(),
          pendingTitles: () => titles!.pendingCount(),
        }),
        codexLegacyHandoffService(directory, clients),
        codexThreadMetadataService(() => identity),
        codexTokenUsageService({
          configured: Boolean(options.tokenUsage),
          unavailable: () => tokenUsageStorageUnavailable,
          usage: () => tokenUsage,
          queries: () => tokenUsageQueries,
          derivedQueries: options.tokenUsage?.derivedQueries,
          person: options.tokenUsage?.person,
        }),
        codexBridgeOrchestrationService({
          clients,
          continuation: () => continuation,
          incarnation: () => hostIncarnation,
        }),
        ...(options.collaboration ? [codexCollaborationService(options.collaboration)] : []),
        ...(options.desktop ? [codexDesktopService(options.desktop, reader, identities)] : []),
        {
          handles: () => false,
          request: () => null,
          close: async () => {
            closed = true;
            reader.close();
            await executionGit?.close().catch(() => {});
            await identity?.close().catch(() => {});
            identity = undefined;
            if (!options.tokenUsage?.derivedQueries) tokenUsageQueries?.close();
            tokenUsageQueries = null;
            const usage = tokenUsage;
            tokenUsage = null;
            if (usage instanceof TokenUsageCollector) await usage.close().catch(() => {});
            else usage?.close();
            tokenUsageState?.close();
            tokenUsageState = undefined;
            hostState?.close();
            hostState = undefined;
            await Promise.resolve(releaseOverlaysLock?.()).catch(() => {});
            releaseOverlaysLock = undefined;
          },
        },
      ];
      return services;
    },
    (listener) => bridge.observeEvents(listener),
  );
  return servicesRef;
}

function codexThreadMetadataService(getIdentity: () => ThreadIdentity | undefined): CodexHostService {
  let inFlight = 0;
  return {
    handles: (method) => getIdentity()?.metadata?.supports(method) === true,
    request: async (method, params) => {
      const metadata = getIdentity()?.metadata;
      if (!metadata) throw Object.assign(new Error("Thread metadata is unavailable"), { code: -32000 });
      if (inFlight >= 16) throw Object.assign(new Error("Metadata request limit exceeded"), { code: -32000 });
      inFlight++;
      try {
        return await metadata.request(method, object(params));
      } catch {
        throw Object.assign(new Error("Thread metadata is unavailable"), { code: -32000 });
      } finally {
        inFlight--;
      }
    },
    observe: (method, params, result) => {
      try {
        if (method === "thread/list") getIdentity()?.observeResult(method, params, result);
      } catch {
        /* catalog observation never fails list */
      }
    },
    close: () => {},
  };
}

function codexCollaborationService(
  collaboration: NonNullable<ServerCodexBridgeHostOptions["collaboration"]>,
): CodexHostService {
  return {
    handles: (method) => method === COLLABORATION_METHOD,
    capabilities: () => ({
      "opencraft/collaboration": collaboration.capabilities ?? COLLABORATION_CAPABILITIES,
    }),
    request: async (_method, params, context) => {
      try {
        assertSubmissionIdentity(context);
        if (!context.actorContext)
          throw Object.assign(new Error("actor_authentication_required"), {
            status: 401,
            code: "actor_authentication_required",
          });
        context.resourceOwner?.assertCurrent();
        const result = await collaboration.command(context.actorContext, object(params), context);
        context.resourceOwner?.assertCurrent();
        return result;
      } catch (error) {
        const fault = error as { status?: number; code?: unknown };
        const code = fault?.code === -32601 ? "unsupported_capability" : fault?.code;
        const status = fault?.code === -32601 ? 409 : fault?.status;
        const known =
          typeof code === "string" &&
          /^[a-z_]{1,80}$/u.test(code) &&
          [400, 401, 403, 404, 409, 503].includes(status ?? 0);
        throw Object.assign(
          new Error("Conversation operation could not be confirmed. Review its receipt before retrying."),
          {
            code: -32070,
            ...(known ? { data: { code, status } } : {}),
          },
        );
      }
    },
    close: () => {},
  };
}

function codexTokenUsageService(options: {
  readonly configured: boolean;
  readonly unavailable: () => boolean;
  readonly usage: () => CodexTokenUsageRuntime | TokenUsageCollector | null;
  readonly queries: () => TokenUsageQueryService | null;
  readonly derivedQueries?: TokenUsageQueryService;
  readonly person?: (actorId: string) => { kind: string; displayName: string } | null;
}): CodexHostService {
  return {
    handles: (method) => method === "opencraft/token-usage/configure" || method === "opencraft/token-usage/query",
    request: async (method, rawParams, context) => {
      if (method === "opencraft/token-usage/configure") {
        const usage = options.usage();
        if (!usage) {
          throw Object.assign(new Error(options.unavailable() ? "unavailable" : "Token statistics are unsupported"), {
            code: options.unavailable() ? -32000 : -32601,
          });
        }
        const authority = context.tokenUsageAuthority?.();
        if (!authority || !authority.administrator) {
          throw Object.assign(new Error(authority ? "forbidden" : "unauthorized"), {
            code: authority ? 403 : 401,
          });
        }
        const params = object(rawParams);
        if (typeof params.enabled !== "boolean" || Object.keys(params).some((key) => key !== "enabled")) {
          throw Object.assign(new Error("invalid-query"), { code: -32602 });
        }
        try {
          if (usage instanceof TokenUsageCollector) await usage.setEnabled(params.enabled);
          else usage.ledger.setEnabled(params.enabled);
          options.derivedQueries?.invalidate("*");
          const { enabled, enabledAt, revision } =
            usage instanceof TokenUsageCollector ? usage.coverage() : usage.ledger.coverage();
          return { enabled, enabledAt, revision };
        } catch {
          throw Object.assign(new Error("unavailable"), { code: -32000 });
        }
      }

      const queries = options.queries();
      if (!queries) {
        throw Object.assign(
          new Error(options.unavailable() || options.configured ? "unavailable" : "Token statistics are unsupported"),
          { code: options.unavailable() || options.configured ? -32000 : -32601 },
        );
      }
      try {
        const authorize = context.tokenUsageAuthority ?? (() => null);
        const before = authorize();
        const result = labelUsagePeople(await queries.read(rawParams, authorize), options.person);
        const liveGaps = options.usage()?.liveGapCount() ?? 0;
        if (liveGaps) {
          result.coverage = {
            ...result.coverage,
            partial: true,
            openGaps: Math.max(result.coverage.openGaps, liveGaps),
          };
        }
        const after = authorize();
        if (!after) throw new TokenUsageQueryError("unauthorized");
        if (!before || after.actorId !== before.actorId || after.administrator !== before.administrator)
          throw new TokenUsageQueryError("forbidden");
        return result;
      } catch (error) {
        const kind = error instanceof TokenUsageQueryError ? error.code : "unavailable";
        throw Object.assign(new Error(kind), {
          code:
            kind === "unauthorized"
              ? 401
              : kind === "forbidden"
                ? 403
                : kind === "stale-snapshot"
                  ? 409
                  : kind === "invalid-query"
                    ? -32602
                    : -32000,
        });
      }
    },
    close: () => {},
  };
}

function codexDesktopService(
  service: LocalDesktopService,
  native: { request(method: string, params: Value): Promise<unknown> },
  identities: ReturnType<CodexProviderBridge["threadIdentities"]> | undefined,
): CodexHostService {
  const activeClients = new Set<string>();
  return {
    handles: (method) => method === OPENCRAFT_DESKTOP_ATTACH || method === OPENCRAFT_DESKTOP_RELEASE,
    capabilities: () => ({ [OPENCRAFT_DESKTOP_EXTENSION]: service.capability() }),
    disconnect: (clientId) => {
      activeClients.delete(clientId);
    },
    request: async (method, rawParams, _context, clientId) => {
      if (!clientId || !rawParams || typeof rawParams !== "object" || Array.isArray(rawParams))
        throw Object.assign(new Error("Desktop is unavailable"), { code: -32600 });
      activeClients.add(clientId);
      const key = `codex-bridge:${clientId}`;
      const params = object(rawParams);
      try {
        if (method === OPENCRAFT_DESKTOP_ATTACH) {
          if (Object.keys(params).length !== 1 || typeof params.threadId !== "string") throw new Error("invalid");
          const owner: LocalDesktopOwner = {
            key,
            isCurrent: () => activeClients.has(clientId),
            readThread: async (threadId) => {
              const nativeId = identities?.toNative(threadId) ?? threadId;
              const response = object(await native.request("thread/read", { threadId: nativeId, includeTurns: false }));
              const thread = object(response.thread);
              if (thread.id !== nativeId || typeof thread.path !== "string" || typeof thread.createdAt !== "number")
                throw new Error("invalid");
              return { id: threadId, path: thread.path, createdAt: thread.createdAt };
            },
          };
          const credential = await service.prepare(owner, params.threadId);
          if (!activeClients.has(clientId)) {
            service.release(key, credential.attachmentId);
            return null;
          }
          return credential;
        }
        if (Object.keys(params).length !== 1 || typeof params.attachmentId !== "string") throw new Error("invalid");
        service.release(key, params.attachmentId);
        return {};
      } catch {
        throw Object.assign(new Error("Desktop is unavailable"), { code: -32600 });
      }
    },
    close: () => {
      activeClients.clear();
    },
  };
}

/**
 * Trusted Thread orchestration lane (`opencraft thread spawn`, Assistant root
 * creation, status/inspect/interrupt) routed directly onto the provider bridge
 * with deterministic `bridge:codex:orch-*` identities — no Core callback lane or
 * legacy `CodexEngineAdapter` needed.
 */
function codexBridgeOrchestrationService(options: {
  readonly clients: CodexHostServiceClients;
  readonly continuation: () => CodexContinuationService | undefined;
  readonly incarnation: () => string;
}): CodexHostService {
  const operations = new Map<string, { fingerprint: string; threadId: string }>();
  const pendingState = new Map<string, "pending" | "unknown" | "paused" | "abandoned" | false>();

  const refreshQueueState = async (threadId: string) => {
    if (!threadId) return;
    try {
      const queue = object(await options.clients.request("thread/queue/list", { threadId }));
      const rows = [
        ...(Array.isArray(queue.data) ? queue.data : []),
        ...(Array.isArray(queue.steering) ? queue.steering : []),
      ].map(object);
      if (rows.some((row) => row.state === "unknown")) {
        pendingState.set(threadId, "unknown");
        return;
      }
      const head = rows.find((row) => ["queued", "dispatching", "steering"].includes(text(row.state)));
      if (head) {
        pendingState.set(
          threadId,
          head.state === "queued" && ["session-tools-unavailable", "model-restricted"].includes(text(head.pausedReason))
            ? "paused"
            : "pending",
        );
        return;
      }
      pendingState.set(threadId, false);
    } catch {
      pendingState.set(threadId, false);
    }
  };

  const control = new CodexOrchestrationControl({
    supported: () => true,
    incarnation: options.incarnation,
    request: async (method, params, admit) => {
      if (admit && !admit()) throw new OrchestrationControlError(403, "Orchestration delegation was revoked");
      if (method === "opencraft/orchestration/private-capability") return { version: 1 };
      if (method === "opencraft/orchestration/publish") return { published: true };
      if (method === "opencraft/orchestration/ack") {
        const op = text(params.creationOperationId) || text(params.operationId);
        if (op) operations.delete(op);
        return { acknowledged: true };
      }
      if (method === "thread/start") {
        const operationId = text(params.__opencraftOrchestrationOperation);
        const fingerprint = text(params.__opencraftOrchestrationFingerprint);
        const expectedIncarnation = text(params.__opencraftOrchestrationIncarnation);
        const prior = operations.get(operationId);
        if (prior) {
          if (fingerprint && prior.fingerprint && prior.fingerprint !== fingerprint) {
            throw Object.assign(new Error("Orchestration operation reused with different settings"), {
              code: 409,
              data: { orchestrationRejected: true },
            });
          }
          return { thread: { id: prior.threadId } };
        }
        if (expectedIncarnation && expectedIncarnation !== options.incarnation()) {
          throw Object.assign(new Error("Orchestration Host changed before creation"), {
            code: 503,
            data: { orchestrationRejected: true },
          });
        }
        const {
          __opencraftDeferPublication: _defer,
          __opencraftOrchestrationOperation: _op,
          __opencraftOrchestrationSourceThreadId: _source,
          __opencraftOrchestrationFingerprint: _fp,
          __opencraftOrchestrationIncarnation: _inc,
          ...cleanStart
        } = params;
        const childId = `bridge:codex:orch-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
        const created = object(
          await options.clients.request("thread/start", {
            ...cleanStart,
            agentBridge: { threadId: childId, clientRequestId: `orchestration:${operationId}` },
          }),
        );
        const resolvedId = text(object(created.thread).id) || childId;
        operations.set(operationId, { fingerprint, threadId: resolvedId });
        return { thread: { ...object(created.thread), id: resolvedId } };
      }
      if (method === "thread/name/set") {
        return options.clients.request("thread/name/set", {
          threadId: params.threadId,
          name: params.name,
        });
      }
      return options.clients.request(method, params);
    },
    read: async (threadId, limit) => {
      const read = object(await options.clients.request("thread/read", { threadId, includeTurns: true }));
      const thread = object(read.thread);
      const turns = Array.isArray(thread.turns) ? thread.turns.slice(-limit) : [];
      return { thread: { ...thread, turns } as unknown as AppServerThread };
    },
    recovery: (threadId) => options.continuation()?.snapshot(threadId) ?? null,
    pendingInput: (threadId) => pendingState.get(threadId) ?? false,
  });

  return {
    handles: (method) => method.startsWith("opencraft/orchestration/"),
    beforeInitialize: true,
    request: async (method, rawParams, context) => {
      const params = object(rawParams);
      if (method === "opencraft/orchestration/status") await refreshQueueState(text(params.threadId));
      try {
        return await control.handle(method, params, context);
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : "Orchestration failed"), {
          code: error instanceof OrchestrationControlError ? error.code : -32000,
        });
      }
    },
    close: () => {
      operations.clear();
      pendingState.clear();
    },
  };
}

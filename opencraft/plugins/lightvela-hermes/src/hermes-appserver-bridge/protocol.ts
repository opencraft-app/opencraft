import {
  HermesAppServerAdapter,
  isUnmaterializedHermesHistory,
} from "./adapter";
import {
  OPENCRAFT_SCOPED_MODEL_CATALOG_CAPABILITY,
  OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION,
  OPENCRAFT_PROFILE_SKILLS_CAPABILITY,
  OPENCRAFT_PROFILE_SKILLS_EXTENSION,
  OPENCRAFT_THREAD_QUEUE_EXTENSION,
  type ProfileSkillsMethod,
} from "@opencraft/appserver-protocol";
import type { HermesHostFileSystem } from "./dashboard-file-system";
import type { HermesHostTerminal } from "./tat-terminal";
import type { HermesProcessService } from "./process-service";
import type { AppServerTurn, JsonRpcRequest } from "./types";
import type { HermesBotAppServerHandler } from "./bot-protocol-handler";
import type { HermesDashboardProfileSkillsHandler } from "./profile-skills-handler";
import {
  isHermesWhatsAppOnboardingMethod,
  type HermesDashboardWhatsAppOnboardingHandler,
} from "./whatsapp-onboarding-handler";
import { LIGHTVELA_HOST_BINDING_EXTENSION } from "../host/lightvela-hermes-host-identity";
import { throwIfSignalAborted } from "@opencraft/workbench-runtime";

const PROFILE_SKILLS_METHODS = new Set<ProfileSkillsMethod>([
  "skills/installed/list",
  "skills/installed/content/read",
  "skills/enabled/set",
  "skills/catalog/sources/list",
  "skills/catalog/official/list",
  "skills/catalog/search",
  "skills/catalog/preview",
  "skills/catalog/scan",
  "skills/install",
  "skills/uninstall",
  "skills/update",
  "skills/action/read",
]);

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const requestParams = (request: JsonRpcRequest): Record<string, unknown> => {
  if (request.params === undefined) return {};
  if (!isObject(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params;
};

const slicePage = <T>(items: T[], cursor: unknown, limit: unknown) => {
  const offset = typeof cursor === "string" && /^local:\d+$/u.test(cursor)
    ? Number(cursor.slice(6))
    : 0;
  const size = typeof limit === "number"
    ? Math.min(Math.max(Math.floor(limit), 1), 200)
    : 50;
  return {
    data: items.slice(offset, offset + size),
    nextCursor: offset + size < items.length ? `local:${offset + size}` : null,
  };
};

const historyOffset = (cursor: unknown): number => {
  if (cursor === null || cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^hermes-messages:\d+$/u.test(cursor)) {
    throw new Error("Invalid Hermes history cursor");
  }
  return Number(cursor.slice("hermes-messages:".length));
};

const historyCursor = (offset: number | null): string | null => (
  offset === null ? null : `hermes-messages:${offset}`
);

/** Translate one AppServer request into one or more Hermes JSON-RPC calls. */
export const dispatchAppServerRequest = async (
  adapter: HermesAppServerAdapter,
  request: JsonRpcRequest,
  services: {
    readonly signal?: AbortSignal;
    readonly fileSystem?: HermesHostFileSystem;
    readonly terminal?: HermesHostTerminal;
    readonly processes?: HermesProcessService;
    readonly bots?: HermesBotAppServerHandler;
    readonly profileSkills?: HermesDashboardProfileSkillsHandler;
    readonly whatsappOnboarding?: HermesDashboardWhatsAppOnboardingHandler;
    readonly instanceId?: string;
  } = {},
): Promise<unknown> => {
  throwIfSignalAborted(services.signal);
  const value = requestParams(request);
  if (request.method.startsWith("process/")) {
    if (!services.processes) throw new Error("Hermes process service is unavailable");
    return services.processes.dispatch(request.method, value);
  }
  if (request.method.startsWith("bot/") && services.bots !== undefined) {
    return services.bots.handle(request.method, value);
  }
  if (PROFILE_SKILLS_METHODS.has(request.method as ProfileSkillsMethod)) {
    if (services.profileSkills === undefined) throw new Error("Hermes Profile Skills service is unavailable");
    return services.profileSkills.handle(request.method as ProfileSkillsMethod, value);
  }
  if (isHermesWhatsAppOnboardingMethod(request.method)) {
    if (services.whatsappOnboarding === undefined) {
      throw new Error("Hermes WhatsApp onboarding service is unavailable");
    }
    return services.whatsappOnboarding.handle(request.method, value);
  }
  switch (request.method) {
    case "initialize": {
      const botsAvailable = await services.bots?.prepareCapability() ?? false;
      return {
        codexHome: services.fileSystem?.codexHome ?? "/hermes",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "mychat-hermes-bridge/0.1.0",
        serverInfo: { name: "opencraft-hermes-browser-handler", version: "0.1.0" },
        capabilities: {
          extensions: {
            ...(services.instanceId === undefined ? {} : {
              [LIGHTVELA_HOST_BINDING_EXTENSION]: {
                version: 1,
                instanceId: services.instanceId,
              },
            }),
            "opencraft/message-window-history": { version: 1, pageRows: 120, previewNotification: "thread/history/preview" },
            [OPENCRAFT_THREAD_QUEUE_EXTENSION]: {
              version: 2,
              reorder: true,
              atomicSteer: true,
              perItemPause: true,
            },
            [OPENCRAFT_SCOPED_MODEL_CATALOG_EXTENSION]:
              OPENCRAFT_SCOPED_MODEL_CATALOG_CAPABILITY,
            ...(services.profileSkills === undefined ? {} : {
              [OPENCRAFT_PROFILE_SKILLS_EXTENSION]: OPENCRAFT_PROFILE_SKILLS_CAPABILITY,
            }),
            ...(!botsAvailable ? {} : {
              "vela/bot-conversations": {
                version: 1,
                topologies: services.bots!.groupConversations ? ["direct", "group"] : ["direct"],
                features: {
                  messageStreaming: true,
                  executionCancellation: true,
                  attachments: true,
                  interactions: services.bots!.groupConversations,
                  botManagement: services.bots!.botManagement,
                  botAssets: false,
                  // Hosted-room rosters are frozen in Hermes protocol v1.
                  // Creation supports groups; membership mutation does not.
                  groupMembership: false,
                  configuration: false,
                  routines: false,
                },
                limits: {
                  maxPageSize: 100,
                  maxInlineAttachmentBytes: 10485760,
                  maxParticipants: services.bots!.groupConversations ? 7 : 2,
                },
              },
            }),
          },
        },
      };
    }
    case "agent/list": {
      // Composer publishes agent/model capability pages atomically. Older
      // Hermes gateways have no agent catalog; that is an empty optional
      // projection, not a failure that may erase a successful model/list.
      try {
        const models = await adapter.listModels({ cursor: null, limit: 200, includeHidden: false });
        const entry = {
          id: "hermes",
          displayName: "Hermes Agent",
          description: "Hermes Agent Server",
          engineKind: "hermes",
          isDefault: true,
          defaultModel: null,
          modelIds: models.data.map((model) => model.id),
          available: models.data.length > 0,
          unavailableReason: models.data.length > 0 ? null : "Hermes has no available models",
        };
        const offset = typeof value.cursor === "string" && value.cursor === "hermes-agents:1" ? 1 : 0;
        const limit = typeof value.limit === "number" ? Math.max(0, Math.floor(value.limit)) : 100;
        return { data: offset === 0 && limit > 0 ? [entry] : [], nextCursor: null };
      } catch {
        return { data: [], nextCursor: null };
      }
    }
    case "thread/list":
      return adapter.listThreads(value);
    case "thread/read": {
      const threadId = String(value.threadId ?? "");
      return { thread: value.includeTurns === true
        ? await adapter.loadThread(threadId, true, null, services.signal)
        : await adapter.readThreadMetadata(threadId, services.signal) };
    }
    case "thread/resume": {
      const threadId = String(value.threadId ?? "");
      const includeThreadTurns = value.excludeTurns !== true;
      const initialTurnsRequest = isObject(value.initialTurnsPage) ? value.initialTurnsPage : null;
      // `excludeTurns` only controls the embedded `thread.turns` payload. It must
      // not suppress either of the two independent history bootstrap paths:
      // an initial tail page, or the cursor consumed by `thread/turns/list`.
      const requestedLimit = typeof initialTurnsRequest?.limit === "number"
        ? initialTurnsRequest.limit
        : 5;
      const cursorOnlyResume = !includeThreadTurns && initialTurnsRequest === null;
      // Cursor-only Resume still needs the authoritative tail to seed replay.
      // Prime the same page that thread/turns/list will consume, avoiding a
      // second REST snapshot and a second history authority.
      const historyRead = cursorOnlyResume
        ? adapter.prepareTurnsPage(threadId, requestedLimit, "desc", services.signal)
        : adapter.readTurnsPage(threadId, 0, requestedLimit, "desc", services.signal);
      const historyPromise = historyRead.then(page => {
        throwIfSignalAborted(services.signal);
        if (typeof value.historyPreviewToken === "string") {
          adapter.publishHistoryPreview(threadId, value.historyPreviewToken, page.chronological);
        }
        return page;
      });
      const [runtimeResult, historyResult] = await Promise.all([
        adapter.loadThread(threadId, false, null, services.signal)
          .then(thread => ({ thread, error: null as unknown }))
          .catch((error: unknown) => ({ thread: null, error })),
        historyPromise
          .then((page) => ({ page, error: null as unknown }))
          .catch((error: unknown) => ({ page: null, error })),
      ]);
      throwIfSignalAborted(services.signal);
      // A failed runtime activation must not revoke an independent REST
      // preview still in flight. Settle both legs, then report readiness error.
      if (runtimeResult.thread === null) throw runtimeResult.error;
      const loadedThread = runtimeResult.thread;
      const historyWasUnmaterialized = historyResult.page === null
        && isUnmaterializedHermesHistory(loadedThread, historyResult.error);
      if (historyResult.page === null && !historyWasUnmaterialized) {
        throw historyResult.error;
      }
      const historyPage = historyResult.page ?? {
        data: [],
        chronological: [],
        nextOffset: null,
      };
      await adapter.activateProjection(threadId, historyPage.chronological);
      // Recovery may replace the durable tail with its retained live owner or
      // append backend inflight. Both bootstrap paths must expose that array.
      historyPage.data.splice(0, historyPage.data.length, ...[...historyPage.chronological].reverse());
      const thread = includeThreadTurns
        ? { ...loadedThread, turns: historyPage?.chronological ?? [] }
        : { ...loadedThread, turns: [] };
      const initialTurns = initialTurnsRequest === null ? null : historyPage?.data ?? [];
      return {
        thread,
        cwd: thread.cwd,
        model: adapter.executionModel(threadId),
        modelProvider: "hermes",
        serviceTier: null,
        reasoningEffort: adapter.executionReasoningEffort(threadId),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [thread.cwd],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        instructionSources: [],
        runtimeWorkspaceRoots: [thread.cwd],
        // A non-null bootstrap cursor tells paginated clients to ask for the
        // first history page. `local:0` is opaque outside this bridge.
        turnsBackwardsCursor: !historyWasUnmaterialized
          && !includeThreadTurns
          && initialTurnsRequest === null
          ? "hermes-messages:0"
          : historyCursor(historyPage.nextOffset),
        itemsBackwardsCursor: null,
        ...(initialTurns !== null
          ? {
              initialTurnsPage: {
                data: initialTurns,
                nextCursor: historyCursor(historyPage?.nextOffset ?? null),
                backwardsCursor: null,
              },
            }
          : {}),
      };
    }
    case "thread/turns/list": {
      const sortDirection = value.sortDirection === "asc" ? "asc" : "desc";
      const page = await adapter.readTurnsPage(
        String(value.threadId ?? ""),
        historyOffset(value.cursor),
        typeof value.limit === "number" ? value.limit : 50,
        sortDirection,
        services.signal,
      );
      return {
        data: page.data,
        nextCursor: historyCursor(page.nextOffset),
        backwardsCursor: null,
        itemsPaginationByTurnId: {},
      };
    }
    case "thread/items/list": {
      const storedItems = adapter.readTurnItems(String(value.turnId ?? ""));
      const items = value.sortDirection === "desc" ? [...storedItems].reverse() : storedItems;
      return slicePage(items, value.cursor, value.limit);
    }
    case "thread/start": {
      const thread = await adapter.startThread(
        typeof value.cwd === "string" ? value.cwd : null,
        value.model,
        undefined,
        { reasoningEffort: typeof value.effort === "string" ? value.effort : undefined },
      );
      return {
        thread,
        model: adapter.executionModel(thread.id),
        modelProvider: "hermes",
        serviceTier: null,
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [thread.cwd],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        reasoningEffort: adapter.executionReasoningEffort(thread.id),
        multiAgentMode: "explicitRequestOnly",
      };
    }
    case "turn/start":
      return {
        turn: await adapter.startTurn(
          String(value.threadId ?? ""),
          value.input,
          value.model,
          undefined,
          typeof value.clientUserMessageId === "string"
            ? value.clientUserMessageId
            : null,
          value.effort,
        ),
      };
    case "turn/steer":
      return adapter.steerTurn(
        String(value.threadId ?? ""),
        typeof value.expectedTurnId === "string" ? value.expectedTurnId : null,
        value.input,
        typeof value.clientUserMessageId === "string"
          ? value.clientUserMessageId
          : null,
      );
    case "thread/queue/add":
      return {
        queuedSubmission: await adapter.addQueuedSubmission(
          String(value.threadId ?? ""),
          value.input,
          String(value.clientUserMessageId ?? ""),
        ),
      };
    case "thread/queue/list":
      return adapter.listQueuedSubmissions(
        String(value.threadId ?? ""),
        typeof value.cursor === "string" ? value.cursor : null,
        typeof value.limit === "number" ? value.limit : null,
      );
    case "thread/queue/update":
      return {
        queuedSubmission: await adapter.updateQueuedSubmission(
          String(value.threadId ?? ""),
          String(value.queuedSubmissionId ?? ""),
          value.input,
        ),
      };
    case "thread/queue/delete":
      return {
        deleted: await adapter.deleteQueuedSubmission(
          String(value.threadId ?? ""),
          String(value.queuedSubmissionId ?? ""),
        ),
      };
    case "thread/queue/reorder":
      await adapter.reorderQueuedSubmissions(
        String(value.threadId ?? ""),
        Array.isArray(value.queuedSubmissionIds) ? value.queuedSubmissionIds.map(String) : [],
      );
      return {};
    case "thread/queue/start": {
      const turn: AppServerTurn = await adapter.startQueuedSubmission(
        String(value.threadId ?? ""),
        typeof value.queuedSubmissionId === "string" ? value.queuedSubmissionId : null,
      );
      return { turn };
    }
    case "thread/queue/steer":
      return await adapter.steerQueuedSubmission(
        String(value.threadId ?? ""),
        String(value.queuedSubmissionId ?? ""),
        String(value.expectedTurnId ?? ""),
      );
    case "turn/interrupt":
      await adapter.cancelTurn(String(value.threadId ?? ""));
      return {};
    case "fs/getMetadata":
      if (!services.fileSystem) throw new Error("Hermes Host filesystem is unavailable");
      return services.fileSystem.getMetadata(String(value.path ?? ""), services.signal);
    case "fs/readDirectory":
      if (!services.fileSystem) throw new Error("Hermes Host filesystem is unavailable");
      return services.fileSystem.readDirectory(String(value.path ?? ""));
    case "fs/readFile":
      if (!services.fileSystem) throw new Error("Hermes Host filesystem is unavailable");
      return services.fileSystem.readFile(String(value.path ?? ""), services.signal);
    case "fs/writeFile":
      if (!services.fileSystem) throw new Error("Hermes Host filesystem is unavailable");
      await services.fileSystem.writeFile(
        String(value.path ?? ""),
        String(value.dataBase64 ?? ""),
      );
      return {};
    case "command/exec":
      if (!services.terminal) throw new Error("Hermes Host terminal is unavailable");
      return services.terminal.exec(value);
    case "command/exec/write":
      if (!services.terminal) throw new Error("Hermes Host terminal is unavailable");
      await services.terminal.write(value);
      return {};
    case "command/exec/resize":
      if (!services.terminal) throw new Error("Hermes Host terminal is unavailable");
      await services.terminal.resize(value);
      return {};
    case "command/exec/terminate":
      if (!services.terminal) throw new Error("Hermes Host terminal is unavailable");
      await services.terminal.terminate(value);
      return {};
    case "model/list":
      return adapter.listModels(value);
    case "permissionProfile/list":
    case "project/list":
      return { data: [], nextCursor: null };
    case "skills/list":
      return { data: [] };
    default:
      throw Object.assign(
        new Error(`Method not supported by Hermes bridge: ${request.method}`),
        { rpcCode: -32601 },
      );
  }
};

import {
  CONVERSATION_SCHEDULES,
  CONVERSATION_SCHEDULES_EXTENSION,
  codexPermissionMode,
  projectPermissionProfileCatalog,
  type OpenCraftPermissionProfile,
} from "@opencraft/appserver-protocol";
import { ConversationSchedules, ScheduleFault, type ScheduleExecutionEvent, type ScheduleExecutionPort } from "@opencraft/host-schedules";
import type { CodexHostService, CodexHostServiceClients, CodexNativeRequests } from "./codex-host-services.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export interface CodexSchedulesOptions {
  /** The Codex data directory; the local Host's schedules carry over. */
  readonly directory: string;
  readonly clients: CodexHostServiceClients;
  /** The Host's own native connection, for the permission catalog of a Thread's workspace. */
  readonly native: CodexNativeRequests;
  readonly admissionOpen: () => boolean;
}

/** The execution side of the schedule store, for Threads whose owner is reached by RPC. */
export function routedCodexScheduleExecution(
  request: CodexHostServiceClients["request"],
  native: CodexNativeRequests,
  admissionOpen: () => boolean,
  subscribe: ScheduleExecutionPort["subscribe"],
): ScheduleExecutionPort {
  const thread = async (threadId: string) =>
    object(object(await request("thread/read", { threadId, includeTurns: false })).thread);
  /** The turn a run's input produced, found in history by its exact client message ID. */
  const runTurn = async (threadId: string, clientId: string, turnId: string | null) => {
    let cursor: unknown = null;
    for (let page = 0; page < 20; page++) {
      const result = object(
        await request("thread/turns/list", { threadId, limit: 20, cursor, sortDirection: "desc", itemsView: turnId ? "notLoaded" : "full" }),
      );
      for (const turn of (Array.isArray(result.data) ? result.data : []).map(object)) {
        if (turnId && turn.id === turnId) return turn;
        const items = Array.isArray(turn.items) ? turn.items.map(object) : [];
        if (!turnId && items.some((item) => item.type === "userMessage" && item.clientId === clientId)) return turn;
      }
      if (result.nextCursor == null || result.nextCursor === cursor) return undefined;
      cursor = result.nextCursor;
    }
    return undefined;
  };
  return {
    subscribe,
    validate: async (threadId) => {
      const current = await thread(threadId);
      if (current.id === undefined || current.ephemeral === true || current.archived === true || current.canAcceptDirectInput === false)
        throw new ScheduleFault(-32600, "This conversation cannot run scheduled tasks");
    },
    permissionProfiles: async (threadId) => {
      const cwd = (await thread(threadId)).cwd;
      const profiles: OpenCraftPermissionProfile[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const response = object(await native.request("permissionProfile/list", { limit: 100, cwd, cursor }));
        if (!Array.isArray(response.data)) throw new Error("Codex permission catalog is unavailable");
        profiles.push(...(response.data as OpenCraftPermissionProfile[]));
        if (response.nextCursor == null)
          return projectPermissionProfileCatalog(profiles, (profile) => codexPermissionMode(profile.id));
        if (typeof response.nextCursor !== "string" || response.nextCursor === cursor)
          throw new Error("Codex permission catalog did not advance");
        cursor = response.nextCursor;
      }
      throw new Error("Codex permission catalog is too long");
    },
    submit: async (run, prompt, canAdmit) => {
      const current = await thread(run.threadId);
      if (!["idle", "notLoaded", undefined].includes(object(current.status).type as string))
        return { state: "waiting" };
      const queued = object(await request("thread/queue/list", { threadId: run.threadId }));
      if (Array.isArray(queued.data) && queued.data.length) return { state: "waiting" };
      if (!canAdmit() || !admissionOpen()) return { state: "waiting" };
      try {
        // Scheduled provenance is explicit text, never a forged person.
        const result = object(
          await request("turn/start", {
            threadId: run.threadId,
            clientUserMessageId: run.id,
            ...(run.permissions ? { permissions: run.permissions, cwd: current.cwd } : {}),
            input: [{ type: "text", text: `[Scheduled task]\n${prompt}`, text_elements: [] }],
          }),
        );
        return { state: "running", turnId: text(object(result.turn).id) || undefined };
      } catch (error) {
        return { state: object(object(error).data).submissionOutcome === "rejected" ? "failed" : "unknown" };
      }
    },
    inspect: async (run) => {
      const turn = await runTurn(run.threadId, run.id, run.turnId ?? null);
      if (!turn) return { state: "unknown" };
      const turnId = text(turn.id);
      if (turn.status === "completed" && !turn.error) return { state: "completed", turnId };
      if (turn.status === "failed" || turn.status === "interrupted" || turn.error) return { state: "failed", turnId };
      return { state: "running", turnId };
    },
  };
}

/** A single schedule store for the Host, with due work sent through its Thread router. */
export function codexSchedulesService(options: CodexSchedulesOptions): CodexHostService {
  const { clients } = options;
  const listeners = new Set<(event: ScheduleExecutionEvent) => void>();
  const schedules = new ConversationSchedules(
    options.directory,
    routedCodexScheduleExecution(
      (method, params) => clients.request(method, params), options.native, options.admissionOpen,
      listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ),
    Date.now,
    (event) => console.warn("[codex-host-services]", JSON.stringify(event)),
    () => clients.broadcast("opencraft/schedules/changed", {}),
    options.admissionOpen,
  );
  schedules.start();
  return {
    handles: (method) => method.startsWith("opencraft/schedules/"),
    request: async (method, params, context) => {
      try {
        return method === CONVERSATION_SCHEDULES.list ? schedules.list() : await schedules.handle(method, params, context.sender?.loginName ?? null);
      } catch (error) {
        throw Object.assign(
          new Error(error instanceof ScheduleFault ? error.message : "Schedule request could not be completed"),
          { code: error instanceof ScheduleFault ? error.code : -32000 },
        );
      }
    },
    capabilities: () => ({
      [CONVERSATION_SCHEDULES_EXTENSION]: {
        version: 1,
        target: "existing-thread",
        repeat: "fixed-interval",
        summary: true,
        calendar: true,
      },
    }),
    storage: () => [{ name: "conversation-schedules", outcome: schedules.outcome }],
    notification: (method, params) => {
      const threadId = text(params.threadId);
      if (!threadId) return;
      if (method === "thread/archived" || method === "thread/deleted") schedules.suspend(threadId);
      const turn = object(params.turn);
      if (method === "turn/completed" && text(turn.id))
        for (const listener of listeners)
          listener({ threadId, turnId: text(turn.id), state: turn.status === "completed" && !turn.error ? "completed" : "failed" });
    },
    close: () => schedules.close(),
  };
}

import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AgentMessageItem,
  ProjectedTurn,
  ProjectedTurnRecord,
} from "../types/appserver-projection.ts";
import type {
  CanonicalContentPart,
  CanonicalItem,
  CanonicalParams,
} from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import {
  executeMcpAppLaunch,
  isMcpAppLaunchRequest,
  type McpToolCallItem,
} from "./mcp-app-launcher.ts";

type Dependencies =
  | "administrator"
  | "allThread"
  | "appServer"
  | "canonicalTimeline"
  | "mcpRegistry"
  | "rootThread"
  | "turnManager"
  | "virtualSkills";

type SyntheticTargetContext = Pick<
  HypernodeServices,
  "allThread" | "rootThread" | "virtualSkills"
>;

export interface SyntheticTurnTarget {
  allowed: boolean;
  virtualSkill: string | null;
}

class TurnLifecycleProtocolError extends Error {
  readonly code = -32081;
  readonly data: { kind: "threadEngineBindingMissing"; threadId: string };

  constructor(threadId: string) {
    super(
      "This task has no execution engine binding. HyperNode will not fabricate a mock reply; " +
        "create the task in a routable workspace or select a configured DSH/Codex engine.",
    );
    this.data = { kind: "threadEngineBindingMissing", threadId };
  }
}

function requiredThreadId(params: CanonicalParams): string {
  if (typeof params.threadId === "string" && params.threadId) return params.threadId;
  throw new Error("turn/start requires threadId");
}

function completedAgentItem(record: ProjectedTurnRecord): AgentMessageItem {
  if (record.agentItem) return record.agentItem;
  throw new Error(`turn ${record.turn.id} completed without an agent item`);
}

function mockReply(input: CanonicalContentPart[]): string {
  const text = input
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!text) return "Hypernode 已收到这轮输入。当前是内存 mock，会话与 Turn 生命周期已接通。";
  return `Hypernode 已收到：${text}\n\n这是由 Cordis TurnService 生成的 mock 回复。`;
}

export function syntheticTurnTarget(
  ctx: SyntheticTargetContext,
  threadId: string,
  input: CanonicalContentPart[],
): SyntheticTurnTarget {
  const virtualSkill = ctx.virtualSkills.resolveInput(input);
  if (virtualSkill) return { allowed: true, virtualSkill };
  if (ctx.rootThread.is(threadId)) return { allowed: true, virtualSkill: null };
  if (ctx.allThread.is(threadId)) return { allowed: true, virtualSkill: null };
  return { allowed: false, virtualSkill: null };
}

function itemStarted(
  record: ProjectedTurnRecord,
  item: CanonicalItem,
  startedAtMs: number,
): CanonicalParams {
  return {
    threadId: record.threadId,
    turnId: record.turn.id,
    item,
    startedAtMs,
  };
}

function itemCompleted(
  record: ProjectedTurnRecord,
  item: CanonicalItem,
  completedAtMs: number,
): CanonicalParams {
  return {
    threadId: record.threadId,
    turnId: record.turn.id,
    item,
    completedAtMs,
  };
}

// `item/started` is the initial state consumed by the Desktop reducer.  Text
// delivered in this object is already part of the reducer state, so repeating
// it in `item/agentMessage/delta` appends the message twice and can mount an
// inline visualization before its stable host element exists.  Native Codex
// starts a streamed agent message with only the already-consumed prefix (empty
// for our one-shot synthetic replies), then delivers the text exactly once as
// a delta and finally replaces it with the authoritative completed item.
export function streamedAgentStartItem(agentItem: AgentMessageItem): AgentMessageItem {
  return { ...agentItem, text: "" };
}

// Native app-server does not claim that a just-started Turn has an
// authoritative item collection. Items arrive through item/* notifications;
// the completed Turn later carries a summary projection. Marking the empty
// array as `full` makes Desktop replace its item tree with an authoritative
// empty page before immediately rebuilding it from streaming events.
export function startedTurnProjection(turn: ProjectedTurn): ProjectedTurn {
  return { ...turn, items: [], itemsView: "notLoaded" };
}

// Desktop commits rich agent-message content into a DOM host before replacing
// it with the authoritative completed item. Each delay below is relative to
// the preceding phase, rather than to turn/start. This matters when the host
// event loop is briefly busy: independent absolute timers can all become due
// together and collapse the remaining phases into one renderer commit.
export const SYNTHETIC_TURN_PHASE_DELAYS_MS = Object.freeze({
  delta: 30,
  itemCompletedAfterDelta: 60,
  turnCompletedAfterItem: 60,
});

export const SYNTHETIC_MCP_APP_PHASE_DELAYS_MS = Object.freeze({
  itemCompleted: 30,
  turnCompletedAfterItem: 60,
});

interface SyntheticTurnPhaseActions {
  delta(): void;
  itemCompleted(): void;
  turnCompleted(): void;
}

export function deferSyntheticTurnPhases<TConnection>(
  appServer: {
    defer(connection: TConnection, delayMs: number, action: () => void): void;
  },
  connection: TConnection,
  actions: SyntheticTurnPhaseActions,
): void {
  appServer.defer(connection, SYNTHETIC_TURN_PHASE_DELAYS_MS.delta, () => {
    try {
      actions.delta();
    } finally {
      appServer.defer(
        connection,
        SYNTHETIC_TURN_PHASE_DELAYS_MS.itemCompletedAfterDelta,
        () => {
          try {
            actions.itemCompleted();
          } finally {
            appServer.defer(
              connection,
              SYNTHETIC_TURN_PHASE_DELAYS_MS.turnCompletedAfterItem,
              actions.turnCompleted,
            );
          }
        },
      );
    }
  });
}

interface SyntheticMcpAppPhaseActions {
  itemCompleted(): void;
  turnCompleted(): void;
}

export function deferSyntheticMcpAppPhases<TConnection>(
  appServer: {
    defer(connection: TConnection, delayMs: number, action: () => void): void;
  },
  connection: TConnection,
  actions: SyntheticMcpAppPhaseActions,
): void {
  appServer.defer(connection, SYNTHETIC_MCP_APP_PHASE_DELAYS_MS.itemCompleted, () => {
    try {
      actions.itemCompleted();
    } finally {
      appServer.defer(
        connection,
        SYNTHETIC_MCP_APP_PHASE_DELAYS_MS.turnCompletedAfterItem,
        actions.turnCompleted,
      );
    }
  });
}

export class TurnLifecycleService extends Service {
  static inject = [
    "administrator",
    "allThread",
    "appServer",
    "canonicalTimeline",
    "mcpRegistry",
    "rootThread",
    "turnManager",
    "virtualSkills",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "turnLifecycle");
    ctx.effect(() => ctx.appServer.register("turn/start", (params, connection) => {
      const lifecycleStartedAtMs = Date.now();
      const threadId = requiredThreadId(params);
      const input = Array.isArray(params.input) ? params.input : [];
      const target = syntheticTurnTarget(ctx, threadId, input);
      if (!target.allowed) {
        throw new TurnLifecycleProtocolError(threadId);
      }
      const record = ctx.turnManager.start(threadId, input, params.clientUserMessageId ?? null);
      const recordStartedAtMs = Date.now();
      const initialTurn = startedTurnProjection(record.turn);
      const userCompletedAtMs = Date.now();
      // Desktop may open an ephemeral synthetic task for a Skill instead of
      // invoking it inside the stable management task. Capability dispatch
      // therefore belongs to the input, not to one privileged thread id.
      // Keeping the old thread-id gate caused explicit `$hypernode` and
      // `$users` invocations to fall through to the generic mock reply.
      const virtualSkill = target.virtualSkill;
      const skillResult = virtualSkill
        ? ctx.virtualSkills.executeInput(input, {
          connection,
          threadId: record.threadId,
          turnId: record.turn.id,
        })
        : null;
      const skillExecutedAtMs = Date.now();
      const launchRequest = isMcpAppLaunchRequest(skillResult) ? skillResult : null;
      const agentText = typeof skillResult === "string"
        ? skillResult
        : ctx.rootThread.is(record.threadId)
          ? ctx.administrator.unavailableGuidance(connection)
          : mockReply(input);
      const initialTimelineRecords: Array<{
        method: string;
        params: CanonicalParams;
        source: { engine: string; kind: string };
      }> = [];
      let initialPhase = true;
      const notify = (method: string, notification: CanonicalParams): void => {
        const source = { engine: "hypernode", kind: "synthetic" };
        if (initialPhase) initialTimelineRecords.push({ method, params: notification, source });
        else ctx.canonicalTimeline.recordAppServer(method, notification, source);
        if (ctx.allThread.is(record.threadId)) ctx.appServer.notifyAllAfter(connection, method, notification);
        else ctx.appServer.notifyAfter(connection, method, notification);
      };
      const commitInitialTimeline = (): void => {
        initialPhase = false;
        if (typeof ctx.canonicalTimeline.recordAppServerBatch === "function") {
          ctx.canonicalTimeline.recordAppServerBatch(initialTimelineRecords);
          return;
        }
        for (const entry of initialTimelineRecords) {
          ctx.canonicalTimeline.recordAppServer(entry.method, entry.params, entry.source);
        }
      };

      notify("thread/status/changed", {
        threadId: record.threadId,
        status: { type: "active", activeFlags: [] },
      });
      notify("turn/started", {
        threadId: record.threadId,
        turn: initialTurn,
      });
      notify("item/started", itemStarted(record, record.userItem, record.startedAtMs));
      notify("item/completed", itemCompleted(record, record.userItem, userCompletedAtMs));

      if (launchRequest !== null) {
        const toolStartedAtMs = Date.now();
        const projection = executeMcpAppLaunch(
          ctx.mcpRegistry,
          launchRequest,
          connection,
          record.threadId,
        );
        const liveToolItem = ctx.turnManager.appendItem(
          record,
          projection.started,
        ) as McpToolCallItem;
        notify(
          "item/started",
          itemStarted(record, liveToolItem, toolStartedAtMs),
        );
        commitInitialTimeline();
        deferSyntheticMcpAppPhases(ctx.appServer, connection, {
          itemCompleted: () => {
            Object.assign(liveToolItem, projection.completed);
            notify(
              "item/completed",
              itemCompleted(record, liveToolItem, Date.now()),
            );
          },
          turnCompleted: () => {
            const completed = ctx.turnManager.complete(record);
            notify("turn/completed", {
              threadId: record.threadId,
              turn: {
                ...completed.turn,
                items: [liveToolItem],
                itemsView: "summary",
              },
            });
            notify("thread/status/changed", {
              threadId: record.threadId,
              status: { type: "idle" },
            });
            connection.threadWriteLease?.release(threadId, connection);
          },
        });
        return { turn: initialTurn };
      }

      const agentItem = ctx.turnManager.prepareAgent(record);
      const agentPreparedAtMs = Date.now();
      const agentStartedAtMs = Date.now();
      notify(
        "item/started",
        itemStarted(record, streamedAgentStartItem(agentItem), agentStartedAtMs),
      );
      commitInitialTimeline();
      const timelineCommittedAtMs = Date.now();
      const startDurationMs = timelineCommittedAtMs - lifecycleStartedAtMs;
      if (startDurationMs >= 250) {
        console.warn(
          `[turn-lifecycle] slow synthetic start thread=${record.threadId} totalMs=${startDurationMs} ` +
          `threadMs=${recordStartedAtMs - lifecycleStartedAtMs} ` +
          `skillMs=${skillExecutedAtMs - recordStartedAtMs} ` +
          `projectionMs=${agentPreparedAtMs - skillExecutedAtMs} ` +
          `timelineMs=${timelineCommittedAtMs - agentPreparedAtMs}`,
        );
      }

      deferSyntheticTurnPhases(ctx.appServer, connection, {
        delta: () => {
          notify("item/agentMessage/delta", {
            threadId: record.threadId,
            turnId: record.turn.id,
            itemId: agentItem.id,
            delta: agentText,
          });
        },
        itemCompleted: () => {
          const completed = ctx.turnManager.complete(record, agentText);
          notify(
            "item/completed",
            itemCompleted(record, completedAgentItem(completed), Date.now()),
          );
        },
        turnCompleted: () => {
          const completed = record.turn.status === "completed"
            ? record
            : ctx.turnManager.complete(record, agentText);
          notify("turn/completed", {
            threadId: record.threadId,
            turn: {
              ...completed.turn,
              items: [completedAgentItem(completed)],
              itemsView: "summary",
            },
          });
          notify("thread/status/changed", {
            threadId: record.threadId,
            status: { type: "idle" },
          });
          connection.threadWriteLease?.release(threadId, connection);
        },
      });
      return { turn: initialTurn };
    }));
  }
}

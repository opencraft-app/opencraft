import { Context, Service } from "@deepseek-ai/cordis";
import type {
  AppServerNotification,
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  ThreadResumeResponse,
} from "@opencraft/appserver-protocol";

import { mergeTurns } from "./merge-turns";
import type { ThreadGuardianApprovalReview, ThreadView } from "./models";
import { resolveThreadId } from "./notification-buffer";

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadResumeProjectors: ThreadResumeProjectorRegistryService;
    threadNotificationProjectors: ThreadNotificationProjectorRegistryService;
  }
}

export interface ThreadResumeProjectionContext {
  metadata: AppServerThread | null;
  response: ThreadResumeResponse;
}

export interface ThreadResumeProjector {
  readonly name: string;
  readonly priority: number;
  project(view: ThreadView, context: ThreadResumeProjectionContext): ThreadView;
}

export class ThreadResumeProjectorRegistryService extends Service {
  private readonly projectors = new Map<string, ThreadResumeProjector>();

  constructor(ctx: Context) {
    super(ctx, "threadResumeProjectors");
  }

  register(projector: ThreadResumeProjector): () => void {
    if (this.projectors.has(projector.name)) throw new Error(`Resume projector ${projector.name} already exists`);
    this.projectors.set(projector.name, projector);
    return () => {
      if (this.projectors.get(projector.name) === projector) this.projectors.delete(projector.name);
    };
  }

  project(view: ThreadView, context: ThreadResumeProjectionContext): ThreadView {
    return [...this.projectors.values()]
      .sort((left, right) => left.priority - right.priority)
      .reduce((current, projector) => projector.project(current, context), view);
  }
}

export interface ThreadNotificationProjector {
  readonly name: string;
  readonly priority: number;
  project(view: ThreadView, notification: AppServerNotification): ThreadView;
}

export class ThreadNotificationProjectorRegistryService extends Service {
  private readonly projectors = new Map<string, ThreadNotificationProjector>();

  constructor(ctx: Context) {
    super(ctx, "threadNotificationProjectors");
  }

  register(projector: ThreadNotificationProjector): () => void {
    if (this.projectors.has(projector.name)) {
      throw new Error(`Notification projector ${projector.name} already exists`);
    }
    this.projectors.set(projector.name, projector);
    return () => {
      if (this.projectors.get(projector.name) === projector) this.projectors.delete(projector.name);
    };
  }

  project(view: ThreadView, notification: AppServerNotification): ThreadView {
    const projected = [...this.projectors.values()]
      .sort((left, right) => left.priority - right.priority)
      .reduce((current, projector) => projector.project(current, notification), view);
    return {
      ...projected,
      notificationRevision: projected.notificationRevision + 1,
      lastNotification: notification,
    };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function notificationTurn(params: unknown): AppServerTurn | null {
  const source = record(params);
  const turn = record(source?.turn);
  if (turn !== null && typeof turn.id === "string") return { ...turn } as AppServerTurn;
  if (source !== null && typeof source.turnId === "string") {
    return { id: source.turnId, ...source } as AppServerTurn;
  }
  return null;
}

function notificationItem(params: unknown): { turnId: string; item: AppServerThreadItem } | null {
  const source = record(params);
  const item = record(source?.item);
  if (source === null || typeof source.turnId !== "string" || item === null || typeof item.id !== "string") {
    return null;
  }
  return { turnId: source.turnId, item: item as AppServerThreadItem };
}

function approvalReview(params: unknown): ThreadGuardianApprovalReview | null {
  const source = record(params);
  const review = record(source?.review);
  const action = record(source?.action);
  if (
    source === null
    || review === null
    || action === null
    || typeof source.threadId !== "string"
    || typeof source.turnId !== "string"
    || typeof source.reviewId !== "string"
    || typeof source.startedAtMs !== "number"
    || typeof review.status !== "string"
    || typeof action.type !== "string"
  ) return null;
  const status = review.status;
  if (status !== "inProgress" && status !== "approved" && status !== "denied" && status !== "timedOut" && status !== "aborted") {
    return null;
  }
  const riskLevel = review.riskLevel;
  const userAuthorization = review.userAuthorization;
  return {
    reviewId: source.reviewId,
    turnId: source.turnId,
    targetItemId: typeof source.targetItemId === "string" ? source.targetItemId : null,
    startedAtMs: source.startedAtMs,
    completedAtMs: typeof source.completedAtMs === "number" ? source.completedAtMs : null,
    status,
    riskLevel: riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" || riskLevel === "critical"
      ? riskLevel
      : null,
    userAuthorization: userAuthorization === "unknown" || userAuthorization === "low" || userAuthorization === "medium" || userAuthorization === "high"
      ? userAuthorization
      : null,
    rationale: typeof review.rationale === "string" ? review.rationale : null,
    action: action as ThreadGuardianApprovalReview["action"],
    decisionSource: source.decisionSource === "agent" ? "agent" : null,
  };
}

function upsertApprovalReview(
  reviews: readonly ThreadGuardianApprovalReview[],
  review: ThreadGuardianApprovalReview,
): readonly ThreadGuardianApprovalReview[] {
  const index = reviews.findIndex((candidate) => candidate.reviewId === review.reviewId);
  if (index < 0) return [...reviews, review];
  const next = [...reviews];
  next[index] = review;
  return next;
}

interface ProjectedHookRun {
  readonly id: string;
  readonly run: Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly eventName: string;
    readonly source: string;
    readonly status: "running" | "completed" | "failed" | "blocked" | "stopped";
    readonly statusMessage: string | null;
    readonly entries: readonly { readonly kind: string; readonly text: string }[];
  };
}

function projectedHookRun(params: unknown): { readonly turnId: string | null; readonly hook: ProjectedHookRun } | null {
  const source = record(params);
  const run = record(source?.run);
  if (run === null) return null;
  const id = typeof run?.id === "string" ? run.id : null;
  const eventName = typeof run?.eventName === "string" ? run.eventName : null;
  const hookSource = typeof run?.source === "string" ? run.source : null;
  const status = run?.status;
  if (
    id === null
    || eventName === null
    || hookSource === null
    || (status !== "running" && status !== "completed" && status !== "failed" && status !== "blocked" && status !== "stopped")
  ) return null;
  const entries = Array.isArray(run.entries)
    ? run.entries.flatMap((candidate) => {
      const entry = record(candidate);
      return typeof entry?.kind === "string" && typeof entry.text === "string"
        ? [{ kind: entry.kind, text: entry.text }]
        : [];
    })
    : [];
  return {
    turnId: typeof source?.turnId === "string" ? source.turnId : null,
    hook: {
      id,
      run: {
        ...run,
        id,
        eventName,
        source: hookSource,
        status,
        statusMessage: typeof run.statusMessage === "string" ? run.statusMessage : null,
        entries,
      },
    },
  };
}

function hookCompletedAt(run: ProjectedHookRun["run"]): unknown {
  return run.completedAt ?? null;
}

/** Source-equivalent reconstruction of Codex's hook-run `upsertItem`. */
function upsertHookRun(
  current: readonly ProjectedHookRun[],
  incoming: ProjectedHookRun["run"],
): readonly ProjectedHookRun[] {
  const next = [...current];
  let index = -1;
  for (let candidateIndex = next.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = next[candidateIndex];
    if (candidate?.run.id === incoming.id && candidate.run.status === "running") {
      index = candidateIndex;
      break;
    }
  }
  if (index < 0 && hookCompletedAt(incoming) !== null) {
    for (let candidateIndex = next.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = next[candidateIndex];
      if (
        candidate?.run.id === incoming.id
        && hookCompletedAt(candidate.run) === hookCompletedAt(incoming)
      ) {
        index = candidateIndex;
        break;
      }
    }
  }
  if (index >= 0) {
    const existingId = next[index]?.id ?? incoming.id;
    next[index] = { id: existingId, run: incoming };
    return next;
  }
  const reusedCount = next.filter((candidate) => candidate.run.id === incoming.id).length;
  next.push({
    id: reusedCount === 0 ? incoming.id : `${incoming.id}:${String(reusedCount)}`,
    run: incoming,
  });
  return next;
}

function projectHookNotification(view: ThreadView, notification: AppServerNotification): ThreadView | null {
  if (notification.method !== "hook/started" && notification.method !== "hook/completed") return null;
  const projected = projectedHookRun(notification.params);
  if (projected === null) return view;
  const targetTurnId = projected.turnId ?? view.turns.at(-1)?.id ?? null;
  if (targetTurnId === null) return view;
  const existing = view.turns.find((turn) => turn.id === targetTurnId);
  if (existing === undefined) return view;
  const source = existing as AppServerTurn & { readonly hookRuns?: readonly ProjectedHookRun[] };
  const hookRuns = upsertHookRun(source.hookRuns ?? [], projected.hook.run);
  const turn = { ...existing, hookRuns } as unknown as AppServerTurn;
  return { ...view, turns: mergeTurns(view.turns, [turn]) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry : "") : [];
}

function appendIndexedText(value: unknown, index: number, delta: string): string[] {
  const entries = stringArray(value);
  while (entries.length <= index) entries.push("");
  entries[index] = `${entries[index] ?? ""}${delta}`;
  return entries;
}

const COMMAND_OUTPUT_LIMIT = 20_000;
const COMMAND_OUTPUT_TRUNCATED_PREFIX = "[output truncated]\n";

function appendTruncatedCommandOutput(currentValue: unknown, delta: string): string {
  const current = typeof currentValue === "string" ? currentValue : "";
  const active = current.startsWith(COMMAND_OUTPUT_TRUNCATED_PREFIX)
    ? current.slice(COMMAND_OUTPUT_TRUNCATED_PREFIX.length)
    : current;
  let next: string;
  let didTruncate = false;
  if (delta.length >= COMMAND_OUTPUT_LIMIT) {
    next = delta.slice(-COMMAND_OUTPUT_LIMIT);
    didTruncate = true;
  } else if (active.length + delta.length <= COMMAND_OUTPUT_LIMIT) {
    next = active + delta;
  } else {
    next = active.slice(-(COMMAND_OUTPUT_LIMIT - delta.length)) + delta;
    didTruncate = true;
  }
  return didTruncate || active !== current ? COMMAND_OUTPUT_TRUNCATED_PREFIX + next : next;
}

function parseTerminalInput(
  initialBuffer: string,
  input: string,
): { readonly commands: readonly string[]; readonly inputBuffer: string } {
  const commands: string[] = [];
  let inputBuffer = initialBuffer;
  let segmentStart = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "\r" && character !== "\n" && character !== "\u0003" && character !== "\b" && character !== "\u007f") continue;
    inputBuffer += input.slice(segmentStart, index);
    segmentStart = index + 1;
    if (character === "\r" || character === "\n") {
      const command = inputBuffer.trim();
      if (command.length > 0) commands.push(command);
      inputBuffer = "";
    } else if (character === "\u0003") {
      inputBuffer = "";
    } else {
      inputBuffer = inputBuffer.slice(0, -1);
    }
  }
  inputBuffer += input.slice(segmentStart);
  return { commands, inputBuffer };
}

function mergeProjectedItem(
  view: ThreadView,
  turnId: string,
  item: AppServerThreadItem,
): ThreadView {
  const existing = view.turns.find((turn) => turn.id === turnId);
  const turn: AppServerTurn = {
    ...(existing ?? { id: turnId }),
    items: [item],
  };
  return { ...view, turns: mergeTurns(view.turns, [turn]) };
}

const TOO_MANY_AUTO_REVIEW_DENIALS = "Automatic approval review rejected too many approval requests for this turn";

function projectGuardianWarning(view: ThreadView, notification: AppServerNotification): ThreadView | null {
  if (notification.method !== "guardianWarning") return null;
  const params = record(notification.params);
  const message = typeof params?.message === "string" ? params.message : "";
  if (params?.kind !== "tooManyDenials" && !message.startsWith(TOO_MANY_AUTO_REVIEW_DENIALS)) return view;
  const turn = view.turns.at(-1);
  if (turn === undefined) return view;
  const item = {
    id: `auto-review-interruption:${view.notificationRevision + 1}`,
    type: "autoReviewInterruptionWarning",
    message,
  } as unknown as AppServerThreadItem;
  return mergeProjectedItem(view, turn.id, item);
}

function projectItemDelta(view: ThreadView, notification: AppServerNotification): ThreadView | null {
  const params = record(notification.params);
  if (params === null) return null;
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  const itemId = typeof params.itemId === "string" ? params.itemId : null;
  const delta = typeof params.delta === "string" ? params.delta : null;
  if (turnId === null || itemId === null) return null;

  const existingTurn = view.turns.find((turn) => turn.id === turnId);
  const existingItem = existingTurn?.items?.find((item) => item.id === itemId);
  let item: AppServerThreadItem;
  switch (notification.method) {
    case "item/agentMessage/delta":
      if (delta === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "agentMessage" }),
        text: `${typeof existingItem?.text === "string" ? existingItem.text : ""}${delta}`,
        status: "inProgress",
        completed: false,
      };
      break;
    case "item/plan/delta":
      if (delta === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "plan" }),
        text: `${typeof existingItem?.text === "string" ? existingItem.text : ""}${delta}`,
        status: "inProgress",
        completed: false,
      };
      break;
    case "item/commandExecution/outputDelta":
      if (delta === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "commandExecution" }),
        aggregatedOutput: appendTruncatedCommandOutput(existingItem?.aggregatedOutput, delta),
        status: "inProgress",
      };
      break;
    case "item/commandExecution/terminalInteraction": {
      const stdin = typeof params.stdin === "string" ? params.stdin : null;
      if (stdin === null || existingItem?.type !== "commandExecution") return null;
      const parsed = parseTerminalInput(
        typeof existingItem.terminalInputBuffer === "string" ? existingItem.terminalInputBuffer : "",
        stdin,
      );
      const previousActions = Array.isArray(existingItem.commandActions) ? existingItem.commandActions : [];
      item = {
        ...existingItem,
        processId: typeof params.processId === "string" ? params.processId : existingItem.processId,
        commandActions: [
          ...previousActions,
          ...parsed.commands.map((command) => ({ type: "unknown", command })),
        ],
        terminalInputBuffer: parsed.inputBuffer,
      };
      break;
    }
    case "item/fileChange/patchUpdated": {
      if (!Array.isArray(params.changes)) return null;
      item = {
        ...(existingItem?.type === "fileChange" ? existingItem : { id: itemId, type: "fileChange" }),
        changes: params.changes,
        status: "inProgress",
      };
      break;
    }
    case "item/reasoning/summaryPartAdded": {
      const summaryIndex = typeof params.summaryIndex === "number" ? params.summaryIndex : null;
      if (summaryIndex === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "reasoning" }),
        summary: appendIndexedText(existingItem?.summary, summaryIndex, ""),
        content: stringArray(existingItem?.content),
        status: "inProgress",
        completed: false,
      };
      break;
    }
    case "item/reasoning/summaryTextDelta": {
      const summaryIndex = typeof params.summaryIndex === "number" ? params.summaryIndex : null;
      if (summaryIndex === null || delta === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "reasoning" }),
        summary: appendIndexedText(existingItem?.summary, summaryIndex, delta),
        content: stringArray(existingItem?.content),
        status: "inProgress",
        completed: false,
      };
      break;
    }
    case "item/reasoning/textDelta": {
      const contentIndex = typeof params.contentIndex === "number" ? params.contentIndex : null;
      if (contentIndex === null || delta === null) return null;
      item = {
        ...(existingItem ?? { id: itemId, type: "reasoning" }),
        summary: stringArray(existingItem?.summary),
        content: appendIndexedText(existingItem?.content, contentIndex, delta),
        status: "inProgress",
        completed: false,
      };
      break;
    }
    default:
      return null;
  }
  return mergeProjectedItem(view, turnId, item);
}

export function registerBuiltinThreadProjectors(ctx: Context): () => void {
  const remove = [
    ctx.threadResumeProjectors.register({
      name: "thread-metadata",
      priority: 10,
      project(view, { metadata, response }) {
        const thread = { ...(metadata ?? {}), ...response.thread, turns: response.thread.turns } as AppServerThread;
        return {
          ...view,
          thread,
          historyMode: response.thread.historyMode ?? metadata?.historyMode ?? view.historyMode,
        };
      },
    }),
    ctx.threadResumeProjectors.register({
      name: "execution-and-security",
      priority: 20,
      project(view, { response }) {
        return {
          ...view,
          execution: {
            model: response.model,
            modelProvider: response.modelProvider,
            serviceTier: response.serviceTier ?? null,
            reasoningEffort: response.reasoningEffort ?? null,
            cwd: response.cwd ?? response.thread.cwd ?? null,
            runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
            instructionSources: response.instructionSources ?? [],
            approvalPolicy: response.approvalPolicy,
            approvalsReviewer: response.approvalsReviewer,
            sandbox: response.sandbox,
            activePermissionProfile: response.activePermissionProfile ?? null,
          },
        };
      },
    }),
    ctx.threadNotificationProjectors.register({
      name: "thread-metadata-notifications",
      priority: 10,
      project(view, notification) {
        if (resolveThreadId(notification.params) !== view.threadId) return view;
        const params = record(notification.params);
        if (notification.method === "thread/started") {
          const thread = record(params?.thread);
          if (thread !== null && typeof thread.id === "string") {
            return { ...view, thread: thread as AppServerThread };
          }
        }
        if (notification.method === "thread/status/changed" && view.thread !== null) {
          return { ...view, thread: { ...view.thread, status: params?.status } };
        }
        if (notification.method === "thread/settings/updated") {
          const settings = record(params?.threadSettings);
          if (settings === null) return view;
          return {
            ...view,
            execution: {
              ...view.execution,
              model: typeof settings.model === "string"
                ? settings.model
                : view.execution.model,
              modelProvider: typeof settings.modelProvider === "string"
                ? settings.modelProvider
                : view.execution.modelProvider,
              serviceTier: typeof settings.serviceTier === "string"
                ? settings.serviceTier
                : settings.serviceTier === null
                  ? null
                  : view.execution.serviceTier,
              reasoningEffort: "effort" in settings
                ? settings.effort
                : view.execution.reasoningEffort,
              cwd: typeof settings.cwd === "string"
                ? settings.cwd
                : view.execution.cwd,
              approvalPolicy: settings.approvalPolicy ?? view.execution.approvalPolicy,
              approvalsReviewer:
                settings.approvalsReviewer ?? view.execution.approvalsReviewer,
              sandbox: settings.sandboxPolicy ?? view.execution.sandbox,
              activePermissionProfile: settings.activePermissionProfile === null
                ? null
                : record(settings.activePermissionProfile)
                  ?? view.execution.activePermissionProfile,
            },
          };
        }
        return view;
      },
    }),
    ctx.threadNotificationProjectors.register({
      name: "turn-notifications",
      priority: 20,
      project(view, notification) {
        if (resolveThreadId(notification.params) !== view.threadId || !notification.method.startsWith("turn/")) {
          return view;
        }
        const turn = notificationTurn(notification.params);
        if (turn === null) return view;
        if (notification.method === "turn/plan/updated") {
          // A plan update is an ordered observation, not Turn metadata and not
          // a proposed plan. Each observation owns an immutable todo snapshot.
          const params = record(notification.params);
          return mergeProjectedItem(view, turn.id, {
            id: `todo-list:${crypto.randomUUID()}`,
            type: "todo-list",
            explanation: params?.explanation ?? null,
            plan: params?.plan ?? [],
          });
        }
        if (notification.method === "turn/started") {
          // Lifecycle observation belongs to this session, never a mounted
          // renderer. Prefer the server clock when it is available.
          const previous = view.turns.find((candidate) => candidate.id === turn.id);
          turn.turnStartedAtMs = previous?.turnStartedAtMs
            ?? turn.turnStartedAtMs
            ?? (typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Date.now());
        }
        const ownsFullItemMembership = notification.method === "turn/completed"
          && turn.itemsView === "full";
        return {
          ...view,
          turns: mergeTurns(view.turns, [turn], {
            itemsMode: ownsFullItemMembership ? "replace" : "merge",
          }),
        };
      },
    }),
    ctx.threadNotificationProjectors.register({
      name: "hook-notifications",
      priority: 22,
      project(view, notification) {
        if (resolveThreadId(notification.params) !== view.threadId) return view;
        return projectHookNotification(view, notification) ?? view;
      },
    }),
    ctx.threadNotificationProjectors.register({
      name: "guardian-approval-review-notifications",
      priority: 25,
      project(view, notification) {
        if (
          resolveThreadId(notification.params) !== view.threadId
          || (notification.method !== "item/autoApprovalReview/started"
            && notification.method !== "item/autoApprovalReview/completed")
        ) return view;
        const projected = approvalReview(notification.params);
        return projected === null ? view : {
          ...view,
          guardianApprovalReviews: upsertApprovalReview(view.guardianApprovalReviews, projected),
        };
      },
    }),
    ctx.threadNotificationProjectors.register({
      name: "item-notifications",
      priority: 30,
      project(view, notification) {
        if (resolveThreadId(notification.params) !== view.threadId || !notification.method.startsWith("item/")) {
          return projectGuardianWarning(view, notification) ?? view;
        }
        const deltaProjection = projectItemDelta(view, notification);
        if (deltaProjection !== null) return deltaProjection;
        const projected = notificationItem(notification.params);
        if (projected === null) return view;
        const previousTurn = view.turns.find((turn) => turn.id === projected.turnId);
        const previousItem = previousTurn?.items?.find((item) => item.id === projected.item.id);
        const params = record(notification.params);
        const eventAtMs = typeof params?.startedAtMs === "number" ? params.startedAtMs
          : typeof params?.completedAtMs === "number" ? params.completedAtMs : Date.now();
        const item: AppServerThreadItem = {
          ...(notification.method === "item/updated" ? previousItem : {}),
          ...projected.item,
          ...(notification.method === "item/started" ? {
            status: "inProgress",
            completed: false,
            startedAtMs: previousItem?.startedAtMs ?? projected.item.startedAtMs ?? eventAtMs,
          } : {}),
          ...(notification.method === "item/completed" ? {
            completed: true,
            completedAtMs: eventAtMs,
            ...(projected.item.status === undefined ? { status: "completed" } : {}),
          } : {}),
        };
        const projectedView = mergeProjectedItem(view, projected.turnId, item);
        if (notification.method !== "item/started" && notification.method !== "item/completed") return projectedView;
        return {
          ...projectedView,
          turns: projectedView.turns.map((turn) => turn.id !== projected.turnId ? turn : {
            ...turn,
            ...(item.type !== "userMessage" && item.type !== "hookPrompt" ? {
              firstTurnWorkItemStartedAtMs: turn.firstTurnWorkItemStartedAtMs ?? item.startedAtMs ?? eventAtMs,
            } : {}),
            ...(notification.method === "item/started" && item.type === "agentMessage" ? {
              finalAssistantStartedAtMs: item.startedAtMs,
            } : {}),
          }),
        };
      },
    }),
  ];
  return () => remove.reverse().forEach((dispose) => dispose());
}

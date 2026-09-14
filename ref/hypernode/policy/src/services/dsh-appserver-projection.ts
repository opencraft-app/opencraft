import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerPlanEntry,
  AppServerPlanStatus,
  DshAppServerProjectionPort,
  DshContentBlock,
  DshProjectedCall,
  DshProjectionActiveTurn,
  DshProjectionWorker,
  DshSessionEvent,
  DynamicToolContentItem,
  ProjectedToolItem,
} from "../types/appserver-projection.js";
import type { CanonicalParams } from "../types/canonical-timeline.js";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";

const BASH_TOOLS = new Set(["bash"]);

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function jsonArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function stringField(value: unknown, ...keys: string[]): string {
  const candidate = objectValue(value);
  for (const key of keys) {
    if (typeof candidate[key] === "string") return candidate[key];
  }
  return "";
}

function eventTime(event: DshSessionEvent): number {
  return typeof event.time === "number" && Number.isFinite(event.time) ? event.time : Date.now();
}

function safeItemId(callId: unknown, seq: unknown): string {
  const safe = String(callId ?? "tool")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "tool";
  return `dsh_${Number.isSafeInteger(seq) ? Number(seq) : 0}_${safe}`;
}

function resultPayload(event: DshSessionEvent): {
  callId: string | null;
  blocks: DshContentBlock[];
  isError: boolean;
} {
  const data = objectValue(event.data);
  const message = objectValue(data["message"]);
  const entries = Array.isArray(message["content"]) ? message["content"] : [];
  const blocks: DshContentBlock[] = [];
  let isError = Boolean(data["error"]);
  for (const rawEntry of entries) {
    const entry = objectValue(rawEntry);
    if (entry["isError"] === true) isError = true;
    for (const block of Array.isArray(entry["content"]) ? entry["content"] : []) {
      blocks.push(objectValue(block));
    }
  }
  const source = objectValue(message["source"]);
  return {
    callId: typeof source["callId"] === "string" ? source["callId"] : null,
    blocks,
    isError,
  };
}

function blockText(blocks: DshContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function dynamicContent(blocks: DshContentBlock[]): DynamicToolContentItem[] {
  const result: DynamicToolContentItem[] = [];
  for (const block of blocks) {
    if (block.type === "text") result.push({ type: "inputText", text: String(block.text ?? "") });
    else if (block.type === "image" && typeof block.data === "string" && block.data) {
      const mediaType = typeof block.mediaType === "string" && block.mediaType
        ? block.mediaType
        : "image/png";
      result.push({ type: "inputImage", imageUrl: `data:${mediaType};base64,${block.data}` });
    }
  }
  return result;
}

function exitCodeFromText(text: string): number {
  const match = text.match(/\[exit code:\s*(-?\d+)\]\s*$/i);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function planStatus(status: unknown): AppServerPlanStatus {
  if (status === "in_progress" || status === "inProgress" || status === "active") return "inProgress";
  if (status === "completed" || status === "complete") return "completed";
  return "pending";
}

function goalPlan(data: unknown): AppServerPlanEntry[] | null {
  const value = objectValue(data);
  const change = objectValue(value["change"]);
  const candidate = objectValue(
    value["goal"] ?? value["snapshot"] ?? change["goal"] ?? change["snapshot"],
  );
  if (typeof candidate["objective"] !== "string" || !candidate["objective"]) return null;
  return [{ step: candidate["objective"], status: planStatus(candidate["phase"]) }];
}

/** Project one DSH append-only Session log into Codex app-server item lifecycles. */
export class DshAppServerProjectionService extends Service implements DshAppServerProjectionPort {
  static inject = [
    "appServerProjection", "turnManager", "shellCommandClassifier",
  ] satisfies Inject<Pick<
    HypernodeServices,
    "appServerProjection" | "turnManager" | "shellCommandClassifier"
  >>;

  declare protected ctx: HypernodeContext<
    "appServerProjection" | "turnManager" | "shellCommandClassifier"
  >;

  constructor(ctx: HypernodeContext<
    "appServerProjection" | "turnManager" | "shellCommandClassifier"
  >) {
    super(ctx, "dshAppServerProjection");
  }

  begin(active: DshProjectionActiveTurn, { cwd = "/workspace" }: { cwd?: string } = {}): void {
    active.dshProjection = { cwd, calls: new Map() };
  }

  handle(worker: DshProjectionWorker, active: DshProjectionActiveTurn, event: DshSessionEvent): boolean {
    if (!active.dshProjection || !event.type) return false;
    if (event.type === "tool/call") {
      this.startTool(worker, active, event);
      return true;
    }
    if (event.type === "tool/result") {
      this.completeTool(worker, active, event);
      return true;
    }
    const data = objectValue(event.data);
    if (event.type === "todo/write") {
      this.updatePlan(worker, active, data["todos"]);
      return true;
    }
    if (event.type === "goal/change") {
      const plan = goalPlan(data);
      if (plan) this.updatePlan(worker, active, plan, true);
      return true;
    }
    return false;
  }

  private startTool(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    event: DshSessionEvent,
  ): void {
    const projection = active.dshProjection;
    if (!projection) return;
    const data = objectValue(event.data);
    const callId = String(data["callId"] ?? `seq-${event.seq ?? 0}`);
    if (projection.calls.has(callId)) return;
    const args = jsonArguments(data["arguments"]);
    const startedAtMs = eventTime(event);
    const command = stringField(args, "command", "cmd");
    const toolName = typeof data["name"] === "string" ? data["name"] : "tool";
    const item: ProjectedToolItem = BASH_TOOLS.has(toolName)
      ? {
          id: safeItemId(callId, event.seq),
          type: "commandExecution",
          command,
          cwd: projection.cwd,
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: this.ctx.shellCommandClassifier.classify(command, { cwd: projection.cwd }),
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        }
      : {
          id: safeItemId(callId, event.seq),
          type: "dynamicToolCall",
          namespace: "deepseek-harness",
          tool: toolName,
          arguments: args,
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        };
    const call: DshProjectedCall = { callId, item, startedAtMs };
    projection.calls.set(callId, call);
    this.ctx.turnManager.appendItem(active.record, item);
    this.notify("item/started", {
      threadId: worker.threadId,
      turnId: active.record.turn.id,
      item: { ...item },
      startedAtMs,
    });
  }

  private completeTool(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    event: DshSessionEvent,
  ): void {
    const projection = active.dshProjection;
    if (!projection) return;
    const result = resultPayload(event);
    const call = result.callId === null ? undefined : projection.calls.get(result.callId);
    if (!call || call.completed) return;
    call.completed = true;
    const completedAtMs = eventTime(event);
    call.item.durationMs = Math.max(0, completedAtMs - call.startedAtMs);
    if (call.item.type === "commandExecution") {
      const text = blockText(result.blocks);
      const exitCode = result.isError ? 1 : exitCodeFromText(text);
      if (text) this.notify("item/commandExecution/outputDelta", {
        threadId: worker.threadId,
        turnId: active.record.turn.id,
        itemId: call.item.id,
        delta: text,
      });
      call.item.aggregatedOutput = text;
      call.item.exitCode = exitCode;
      call.item.status = result.isError || exitCode !== 0 ? "failed" : "completed";
    } else {
      call.item.contentItems = dynamicContent(result.blocks);
      call.item.success = !result.isError;
      call.item.status = result.isError ? "failed" : "completed";
    }
    this.notify("item/completed", {
      threadId: worker.threadId,
      turnId: active.record.turn.id,
      item: { ...call.item },
      completedAtMs,
    });
  }

  private updatePlan(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    raw: unknown,
    alreadyProjected = false,
  ): void {
    const entries = Array.isArray(raw) ? raw : [];
    const plan: AppServerPlanEntry[] = alreadyProjected
      ? entries.flatMap((entry) => {
          const value = objectValue(entry);
          return typeof value["step"] === "string" && value["step"]
            ? [{ step: value["step"], status: planStatus(value["status"]) }]
            : [];
        })
      : entries.flatMap((entry) => {
          const value = objectValue(entry);
          return typeof value["content"] === "string" && value["content"]
            ? [{ step: value["content"], status: planStatus(value["status"]) }]
            : [];
        });
    active.record.plan = plan;
    this.notify("turn/plan/updated", {
      threadId: worker.threadId,
      turnId: active.record.turn.id,
      explanation: null,
      plan,
    });
  }

  settle(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    status: "failed" | "interrupted" = "failed",
  ): void {
    if (!active.dshProjection) return;
    const completedAtMs = Date.now();
    for (const call of active.dshProjection.calls.values()) {
      if (call.completed) continue;
      call.completed = true;
      call.item.status = status;
      call.item.durationMs = Math.max(0, completedAtMs - call.startedAtMs);
      if (call.item.type === "dynamicToolCall") call.item.success = false;
      this.notify("item/completed", {
        threadId: worker.threadId,
        turnId: active.record.turn.id,
        item: { ...call.item },
        completedAtMs,
      });
    }
  }

  private notify(method: string, params: CanonicalParams): void {
    this.ctx.appServerProjection.broadcast(method, params, {
      engine: "dsh",
      kind: "execution",
    });
  }
}

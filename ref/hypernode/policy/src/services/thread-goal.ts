import { Service, type Inject } from "@deepseek-ai/cordis";
import type { DurableStoragePort } from "../types/storage.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import {
  THREAD_GOAL_STATUSES,
  type ThreadGoal,
  type ThreadGoalPort,
  type ThreadGoalSetParams,
  type ThreadGoalStatus,
} from "../types/thread-goal.ts";

const LEGACY_NAMESPACE = "threadGoals";

function requiredThreadId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("threadId must be a non-empty string");
  }
  return value;
}

function optionalStatus(value: unknown): ThreadGoalStatus | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" ||
      !(THREAD_GOAL_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`invalid thread goal status: ${String(value)}`);
  }
  return value as ThreadGoalStatus;
}

function optionalBudget(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("tokenBudget must be a positive integer or null");
  }
  return Number(value);
}

/** Engine-neutral durable state for the single current Goal of each Thread. */
export class ThreadGoalTable implements ThreadGoalPort {
  private readonly memory = new Map<string, ThreadGoal>();
  private readonly storage: DurableStoragePort | null;

  constructor(storage: DurableStoragePort | null) {
    this.storage = storage;
    if (storage?.available && storage.sql) {
      storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS do_thread_goals (
          thread_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )
      `);
    }
  }

  get(threadId: string): ThreadGoal | null {
    const sql = this.storage?.available ? this.storage.sql : null;
    if (sql) {
      const row = sql.exec<{ payload: string }>(
        "SELECT payload FROM do_thread_goals WHERE thread_id = ?",
        threadId,
      ).toArray()[0];
      return row ? JSON.parse(row.payload) as ThreadGoal : null;
    }
    const cached = this.memory.get(threadId);
    if (cached) return { ...cached };
    const encoded = policyStore.get(LEGACY_NAMESPACE, threadId);
    return encoded == null ? null : JSON.parse(encoded) as ThreadGoal;
  }

  set(params: ThreadGoalSetParams): ThreadGoal {
    const threadId = requiredThreadId(params.threadId);
    const previous = this.get(threadId);
    const now = Math.floor(Date.now() / 1000);
    const objective = params.objective == null ? previous?.objective : params.objective.trim();
    if (!objective) throw new Error("objective is required when creating a thread goal");
    const status = optionalStatus(params.status) ?? previous?.status ?? "active";
    const tokenBudget = optionalBudget(params.tokenBudget);
    const goal: ThreadGoal = {
      threadId,
      objective,
      status,
      tokenBudget: tokenBudget === undefined
        ? (previous?.tokenBudget ?? null)
        : tokenBudget,
      tokensUsed: previous?.tokensUsed ?? 0,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const encoded = JSON.stringify(goal);
    const sql = this.storage?.available ? this.storage.sql : null;
    if (sql) {
      sql.exec(`
        INSERT INTO do_thread_goals(thread_id, payload) VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET payload = excluded.payload
      `, threadId, encoded);
    } else {
      this.memory.set(threadId, goal);
      policyStore.set(LEGACY_NAMESPACE, threadId, encoded);
    }
    return { ...goal };
  }

  clear(threadId: string): boolean {
    const existed = this.get(threadId) !== null;
    if (!existed) return false;
    const sql = this.storage?.available ? this.storage.sql : null;
    if (sql) sql.exec("DELETE FROM do_thread_goals WHERE thread_id = ?", threadId);
    else {
      this.memory.delete(threadId);
      policyStore.delete(LEGACY_NAMESPACE, threadId);
    }
    return true;
  }
}

type Dependencies = "appServer" | "storage" | "threadManager";

export class ThreadGoalService extends Service implements ThreadGoalPort {
  static inject = ["appServer", "storage", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly table: ThreadGoalTable;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadGoal");
    this.table = new ThreadGoalTable(ctx.storage);
    ctx.effect(() => ctx.appServer.register("thread/goal/get", (params) => ({
      goal: this.get(requiredThreadId(params["threadId"])),
    })));
    ctx.effect(() => ctx.appServer.register("thread/goal/set", (params, connection) => {
      const threadId = requiredThreadId(params["threadId"]);
      this.assertMaterialized(threadId);
      const objective = params["objective"];
      if (objective != null && typeof objective !== "string") {
        throw new Error("objective must be a string or null");
      }
      const goal = this.set({
        threadId,
        ...(Object.prototype.hasOwnProperty.call(params, "objective")
          ? { objective: objective as string | null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(params, "status")
          ? { status: optionalStatus(params["status"]) ?? null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(params, "tokenBudget")
          ? { tokenBudget: optionalBudget(params["tokenBudget"]) ?? null }
          : {}),
      });
      ctx.appServer.notifyAllAfter(connection, "thread/goal/updated", { threadId, goal });
      return { goal };
    }));
    ctx.effect(() => ctx.appServer.register("thread/goal/clear", (params, connection) => {
      const threadId = requiredThreadId(params["threadId"]);
      this.assertMaterialized(threadId);
      const cleared = this.clear(threadId);
      if (cleared) ctx.appServer.notifyAllAfter(connection, "thread/goal/cleared", { threadId });
      return { cleared };
    }));
  }

  get(threadId: string): ThreadGoal | null {
    this.assertMaterialized(threadId);
    return this.table.get(threadId);
  }

  set(params: ThreadGoalSetParams): ThreadGoal {
    this.assertMaterialized(params.threadId);
    return this.table.set(params);
  }

  clear(threadId: string): boolean {
    this.assertMaterialized(threadId);
    return this.table.clear(threadId);
  }

  private assertMaterialized(threadId: string): void {
    if (!this.ctx.threadManager.find(threadId)) {
      throw new Error(`thread ${threadId} is not materialized`);
    }
  }
}

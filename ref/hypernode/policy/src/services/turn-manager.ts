import { Service, type Inject } from "@deepseek-ai/cordis";
import { uuidV7 } from "./thread-identity.ts";
import type {
  AgentMessageItem,
  ProjectedTurn,
  ProjectedTurnRecord,
  ProjectedUserTurnRecord,
  ReasoningItem,
  UserMessageItem,
} from "../types/appserver-projection.ts";
import type { CanonicalItem } from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies = "principal" | "threadManager";

function createTurn(): ProjectedTurn {
  return {
    id: uuidV7(),
    items: [],
    status: "inProgress",
    error: null,
    startedAt: Math.floor(Date.now() / 1_000),
    completedAt: null,
    durationMs: null,
    itemsView: "full",
  };
}

function createAgentItem(phase: string | null): AgentMessageItem {
  return {
    id: uuidV7(),
    type: "agentMessage",
    text: "",
    phase,
    memoryCitation: null,
  };
}

function createReasoningItem(): ReasoningItem {
  return {
    id: uuidV7(),
    type: "reasoning",
    summary: [],
    content: [],
  };
}

function persistThreadState(
  manager: HypernodeServices["threadManager"],
  threadId: string,
): void {
  // Recovery fixtures and older embedded hosts may expose only the original
  // full-catalog invalidation hook. Production uses the row-local fast path.
  if (typeof manager.persistThread === "function") manager.persistThread(threadId);
  else manager.changed(threadId);
}

export class TurnManagerService extends Service {
  static inject = ["principal", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;

  readonly turns = new Map<string, ProjectedTurnRecord>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "turnManager");
  }

  start(
    threadId: string,
    input: CanonicalItem[],
    clientUserMessageId: string | null = null,
  ): ProjectedUserTurnRecord {
    const principal = this.ctx.principal.current();
    const thread = this.ctx.threadManager.touch(threadId, input, {
      ownerPrincipalId: principal.id,
      visibility: "private",
      kind: "conversation",
    });
    const turn = createTurn();
    const userItem: UserMessageItem = {
      id: uuidV7(),
      type: "userMessage",
      clientId: clientUserMessageId,
      content: input,
    };
    const record: ProjectedUserTurnRecord = {
      threadId,
      turn,
      userItem,
      itemLedger: [userItem],
      startedAtMs: Date.now(),
    };
    // The first-start order is the protocol order.  Keep one append-only
    // ledger for live projection and persistence instead of reconstructing a
    // Turn by item category at completion time.
    // `thread/read`/`thread/resume` may race an active Turn after a Desktop
    // transport reconnect.  The durable Thread projection must therefore see
    // the same live ledger that realtime item notifications mutate; keeping a
    // separate empty `turn.items` array makes an in-flight reasoning/tool item
    // disappear until Turn completion.
    turn.items = record.itemLedger;
    this.turns.set(turn.id, record);
    thread.status = { type: "active", activeFlags: [] };
    (thread.turns ??= []).push(turn);
    return record;
  }

  startAgent(threadId: string): ProjectedTurnRecord {
    const thread = this.ctx.threadManager.find(threadId);
    if (!thread) throw new Error(`unknown thread: ${threadId}`);
    const turn = createTurn();
    const agentItem = createAgentItem("final_answer");
    const record: ProjectedTurnRecord = {
      threadId,
      turn,
      userItem: null,
      agentItem,
      itemLedger: [agentItem],
      startedAtMs: Date.now(),
    };
    turn.items = record.itemLedger;
    this.turns.set(turn.id, record);
    thread.status = { type: "active", activeFlags: [] };
    (thread.turns ??= []).push(turn);
    persistThreadState(this.ctx.threadManager, threadId);
    return record;
  }

  prepareAgent(record: ProjectedTurnRecord): AgentMessageItem {
    const agentItem = record.agentItem ?? createAgentItem("final_answer");
    record.agentItem = agentItem;
    this.appendItem(record, agentItem);
    return agentItem;
  }

  createAgent(
    record: ProjectedTurnRecord,
    phase: string | null = "final_answer",
  ): AgentMessageItem {
    const agentItem = createAgentItem(phase);
    if (phase === "final_answer") record.agentItem = agentItem;
    (record.agentItems ??= []).push(agentItem);
    this.appendItem(record, agentItem);
    return agentItem;
  }

  createUser(
    record: ProjectedTurnRecord,
    content: CanonicalItem[],
    clientId: string | null = null,
  ): UserMessageItem {
    const userItem: UserMessageItem = {
      id: uuidV7(),
      type: "userMessage",
      clientId,
      content: Array.isArray(content) ? content : [],
    };
    this.appendItem(record, userItem);
    return userItem;
  }

  prepareReasoning(record: ProjectedTurnRecord): ReasoningItem {
    const reasoningItem = record.reasoningItem ?? createReasoningItem();
    record.reasoningItem = reasoningItem;
    this.appendItem(record, reasoningItem);
    return reasoningItem;
  }

  createReasoning(record: ProjectedTurnRecord): ReasoningItem {
    const reasoningItem = createReasoningItem();
    record.reasoningItem = reasoningItem;
    (record.reasoningItems ??= []).push(reasoningItem);
    this.appendItem(record, reasoningItem);
    return reasoningItem;
  }

  appendItem(record: ProjectedTurnRecord, item: CanonicalItem): CanonicalItem {
    const ledger = this.itemLedger(record);
    // Keep active history hydration and the internal ordered ledger as one
    // object. Terminal transitions intentionally snapshot this array below.
    if (record.turn) record.turn.items = ledger;
    const existing = ledger.find((candidate) => candidate.id === item.id);
    if (existing) return existing;
    ledger.push(item);
    return item;
  }

  itemLedger(record: ProjectedTurnRecord): CanonicalItem[] {
    if (Array.isArray(record.itemLedger)) return record.itemLedger;
    // Compatibility for records created before the ordered ledger existed and
    // for small service fixtures.  New records never take this branch.
    const legacy = [
      ...(record.userItem ? [record.userItem] : []),
      ...(record.reasoningItem ? [record.reasoningItem] : []),
      ...(record.projectedItems ?? []),
      ...(record.agentItem ? [record.agentItem] : []),
    ];
    record.itemLedger = [];
    for (const item of legacy) this.appendItem(record, item);
    return record.itemLedger;
  }

  complete(
    record: ProjectedTurnRecord,
    agentText: string | null = null,
    agentItem: AgentMessageItem | null = null,
  ): ProjectedTurnRecord {
    const completedAtMs = Date.now();
    if (agentText !== null) {
      const target = agentItem ?? record.agentItem ?? this.prepareAgent(record);
      target.text = agentText;
      record.agentItem = target;
      this.appendItem(record, target);
    }
    record.turn.status = "completed";
    record.turn.items = [...this.itemLedger(record)];
    record.turn.completedAt = Math.floor(completedAtMs / 1000);
    record.turn.durationMs = Math.max(0, completedAtMs - record.startedAtMs);
    const thread = this.ctx.threadManager.get(record.threadId);
    thread.status = { type: "idle" };
    thread["updatedAt"] = record.turn.completedAt;
    thread["recencyAt"] = record.turn.completedAt;
    persistThreadState(this.ctx.threadManager, record.threadId);
    return record;
  }

  fail(
    record: ProjectedTurnRecord,
    message: string,
    completedAt = Math.floor(Date.now() / 1_000),
  ): ProjectedTurnRecord {
    record.turn.status = "failed";
    record.turn.error = { message };
    record.turn.items = [...this.itemLedger(record)];
    record.turn.completedAt = completedAt;
    record.turn.durationMs = Math.max(0, completedAt * 1_000 - record.startedAtMs);
    const thread = this.ctx.threadManager.get(record.threadId);
    thread.status = { type: "idle" };
    thread["updatedAt"] = completedAt;
    thread["recencyAt"] = completedAt;
    persistThreadState(this.ctx.threadManager, record.threadId);
    return record;
  }

  interrupt(
    record: ProjectedTurnRecord,
    agentText = "",
    completedAt = Math.floor(Date.now() / 1_000),
  ): ProjectedTurnRecord {
    if (record.agentItem && agentText) {
      record.agentItem.text = agentText;
      this.appendItem(record, record.agentItem);
    }
    record.turn.status = "interrupted";
    record.turn.error = null;
    record.turn.items = [...this.itemLedger(record)];
    record.turn.completedAt = completedAt;
    record.turn.durationMs = Math.max(0, completedAt * 1_000 - record.startedAtMs);
    const thread = this.ctx.threadManager.get(record.threadId);
    thread.status = { type: "idle" };
    thread["updatedAt"] = completedAt;
    thread["recencyAt"] = completedAt;
    persistThreadState(this.ctx.threadManager, record.threadId);
    return record;
  }
}

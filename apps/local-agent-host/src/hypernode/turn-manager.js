export function createImplementation(Service, uuidV7, Date) {
function createTurn() {
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
function createAgentItem(phase) {
    return {
        id: uuidV7(),
        type: "agentMessage",
        text: "",
        phase,
        memoryCitation: null,
    };
}
function createReasoningItem() {
    return {
        id: uuidV7(),
        type: "reasoning",
        summary: [],
        content: [],
    };
}
function persistThreadState(manager, threadId) {
    // Recovery fixtures and older embedded hosts may expose only the original
    // full-catalog invalidation hook. Production uses the row-local fast path.
    if (typeof manager.persistThread === "function")
        manager.persistThread(threadId);
    else
        manager.changed(threadId);
}
class TurnManagerService extends Service {
    static inject = ["principal", "threadManager"];
    turns = new Map();
    constructor(ctx) {
        super(ctx, "turnManager");
    }
    start(threadId, input, clientUserMessageId = null) {
        const principal = this.ctx.principal.current();
        const thread = this.ctx.threadManager.touch(threadId, input, {
            ownerPrincipalId: principal.id,
            visibility: "private",
            kind: "conversation",
        });
        const turn = createTurn();
        const userItem = {
            id: uuidV7(),
            type: "userMessage",
            clientId: clientUserMessageId,
            content: input,
        };
        const record = {
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
    startAgent(threadId) {
        const thread = this.ctx.threadManager.find(threadId);
        if (!thread)
            throw new Error(`unknown thread: ${threadId}`);
        const turn = createTurn();
        const agentItem = createAgentItem("final_answer");
        const record = {
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
    prepareAgent(record) {
        const agentItem = record.agentItem ?? createAgentItem("final_answer");
        record.agentItem = agentItem;
        this.appendItem(record, agentItem);
        return agentItem;
    }
    createAgent(record, phase = "final_answer") {
        const agentItem = createAgentItem(phase);
        if (phase === "final_answer")
            record.agentItem = agentItem;
        (record.agentItems ??= []).push(agentItem);
        this.appendItem(record, agentItem);
        return agentItem;
    }
    createUser(record, content, clientId = null) {
        const userItem = {
            id: uuidV7(),
            type: "userMessage",
            clientId,
            content: Array.isArray(content) ? content : [],
        };
        this.appendItem(record, userItem);
        return userItem;
    }
    prepareReasoning(record) {
        const reasoningItem = record.reasoningItem ?? createReasoningItem();
        record.reasoningItem = reasoningItem;
        this.appendItem(record, reasoningItem);
        return reasoningItem;
    }
    createReasoning(record) {
        const reasoningItem = createReasoningItem();
        record.reasoningItem = reasoningItem;
        (record.reasoningItems ??= []).push(reasoningItem);
        this.appendItem(record, reasoningItem);
        return reasoningItem;
    }
    appendItem(record, item) {
        const ledger = this.itemLedger(record);
        // Keep active history hydration and the internal ordered ledger as one
        // object. Terminal transitions intentionally snapshot this array below.
        if (record.turn)
            record.turn.items = ledger;
        const existing = ledger.find((candidate) => candidate.id === item.id);
        if (existing)
            return existing;
        ledger.push(item);
        return item;
    }
    itemLedger(record) {
        if (Array.isArray(record.itemLedger))
            return record.itemLedger;
        // Compatibility for records created before the ordered ledger existed and
        // for small service fixtures.  New records never take this branch.
        const legacy = [
            ...(record.userItem ? [record.userItem] : []),
            ...(record.reasoningItem ? [record.reasoningItem] : []),
            ...(record.projectedItems ?? []),
            ...(record.agentItem ? [record.agentItem] : []),
        ];
        record.itemLedger = [];
        for (const item of legacy)
            this.appendItem(record, item);
        return record.itemLedger;
    }
    complete(record, agentText = null, agentItem = null) {
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
    fail(record, message, completedAt = Math.floor(Date.now() / 1_000)) {
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
    interrupt(record, agentText = "", completedAt = Math.floor(Date.now() / 1_000)) {
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

return TurnManagerService;
}

import { piSkillsPrompt } from "./skills.js";
import { ModelRuntime, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as context, type Context } from "@earendil-works/chord/context";
import { AgentDoc, InboxDoc, LiveDoc, UsageDoc, createRegistry, defineDoc, defineExtension, defineTool,
  Harness, MemoryStorage, section, watchEvents, type AgentEventStream, type Conversation, type Storage, type ContextView,
  type EntryRecord, type SubmissionRecord, type TaskRecord, type AgentState, type LiveState, type UsageState } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import lockfile from "proper-lockfile";
import { decodeImage } from "./input.js";

type Value = Record<string, any>;
export interface PiSnapshot {
  entries: readonly EntryRecord[];
  submissions: readonly SubmissionRecord[];
  tasks: ReadonlyMap<number, TaskRecord<any, any, any>>;
  agent: AgentState;
  live: LiveState;
  usage: UsageState;
  inbox: readonly Value[];
}
export const createPiModels = (directory: string) => ModelRuntime.create({ allowModelNetwork: false, authPath: `${directory}/auth.json`, modelsPath: `${directory}/models.json` });
export interface PiForkContext {
  messages: ContextView["messages"];
  base: string | null;
  developer: string | null;
}
const InstructionDoc = defineDoc<{ base: string | null; developer: string | null }>({
  kind: "opencraft.instructions", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
  initial: () => ({ base: null, developer: null }),
});
const defaultPreamble = "You are a coding assistant. Complete the user task using the available tools. Preserve existing work.";

/** One native durable owner. It publishes committed snapshots, never a second execution ledger. */
export class PiDurableSession {
  private closed = false;
  private stream!: AgentEventStream;
  private harness!: Awaited<ReturnType<typeof Harness.open>>;
  private root!: Conversation;
  private storage!: Storage;
  private release?: () => Promise<void>;
  private readonly skillPrompts = new Map<string, string>();
  private readonly environments = new Map<string, NodeExecutionEnv>();
  private entries: EntryRecord[] = [];
  private readonly submissions = new Map<number, SubmissionRecord>();
  private tasks = new Map<number, TaskRecord<any, any, any>>();
  private reads: Promise<unknown> = Promise.resolve();
  private replaceTools!: (tools: Value[]) => void;
  private constructor(private readonly options: { cwd: string; file: string; agentDirectory: string; models: ModelRuntime; tools: Value[];
    ephemeral?: boolean; inherited?: PiForkContext;
    onSnapshot(snapshot: PiSnapshot): Promise<void> | void; onTool(request: Value, signal: AbortSignal): Promise<unknown>; onExit(error: Error): void }) {}
  static async open(options: PiDurableSession["options"]) {
    const session = new PiDurableSession(options);
    try { await session.open(); return session; }
    catch (error) { await session.close(); throw error; }
  }
  private async open() {
    if (!this.options.ephemeral) this.release = await lockfile.lock(this.options.file, { realpath: false, stale: 10_000,
      retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
    const registry = createRegistry(); registry.install(CodingTools);
    registry.install(defineExtension({ name: "opencraft", sections: [
      section("preamble", async input => (await input.read.snapshot(InstructionDoc, input.conversationId, context))?.base ?? defaultPreamble, { tag: false }),
      section("workspace", input => {
        const cwd = input.agent.cwd ?? this.options.cwd;
        return `Working directory: ${cwd}\n` + loadProjectContextFiles({ cwd, agentDir: this.options.agentDirectory })
          .map(file => `# ${file.path}\n${file.content}`).join("\n\n");
      }, { tag: false }),
      section("skills", input => {
        if (!process.env.OPENCRAFT_OFFICIAL_SKILLS_ROOT) return '';
        const cwd = input.agent.cwd ?? this.options.cwd;
        let prompt = this.skillPrompts.get(cwd);
        if (prompt === undefined) {
          prompt = piSkillsPrompt(cwd, this.options.agentDirectory);
          if (this.skillPrompts.size >= 16) this.skillPrompts.delete(this.skillPrompts.keys().next().value!);
          this.skillPrompts.set(cwd, prompt);
        }
        return prompt;
      }, { tag: false }),
    ] }));
    this.replaceTools = tools => registry.install(defineExtension({ name: "opencraft.platform-tools", tools: tools.map(tool => defineTool({
      name: tool.piName, description: tool.description, parameters: tool.inputSchema,
      // The native intent is unsafe to replay: reconnect never repeats an external effect.
      execute: async (args: unknown, api: Value, ctx: Context) => {
        if (this.closed || ctx.abortSignal?.aborted) throw new Error("Platform tool cancelled");
        let cancel: (() => void) | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error("Platform tool cancelled"));
          ctx.abortSignal?.addEventListener("abort", cancel, { once: true });
        });
        let result: Value;
        try { result = await Promise.race([this.options.onTool({ id: api.callId, name: tool.piName, arguments: args }, ctx.abortSignal ?? new AbortController().signal), cancelled]) as Value; }
        finally { if (cancel) ctx.abortSignal?.removeEventListener("abort", cancel); }
        const output = (result?.contentItems ?? []).map((item: Value) => {
          if (item.type === "inputText" && typeof item.text === "string") return { type: "text" as const, text: item.text };
          if (item.type === "inputImage") return decodeImage(item.imageUrl);
          throw new Error(`Unsupported platform tool output: ${String(item.type)}`);
        });
        return { output, isError: result?.success !== true };
      },
    })) }));
    this.replaceTools(this.options.tools);
    this.storage = this.options.ephemeral ? new MemoryStorage() : await openNodeSqliteStorage(this.options.file);
    this.harness = await Harness.open(this.storage, { models: this.options.models, registry, env: target => {
      const cwd = target.cwd ?? this.options.cwd;
      let env = this.environments.get(cwd);
      if (!env) { env = new NodeExecutionEnv({ cwd }); this.environments.set(cwd, env); }
      return env;
    } }, context);
    void this.harness.closed.then(end => {
      if (!this.closed && end.reason === "failed") {
        this.options.onExit(new Error("Pi durable storage failed"));
        // Do not stop a watch from its own listener or wait for it here.
        void this.close();
      }
    }).catch(() => {});
    this.root = await this.harness.root(context);
    if (this.options.inherited) {
      const inherited = this.options.inherited;
      await this.instructions(inherited.base ?? undefined, inherited.developer ?? undefined);
      await this.root.commit(tx => tx.appendEntry(this.root.id, { kind: "opencraft.reference", model: inherited.messages }), context);
    }
    for (const record of await this.pages(cursor => this.storage.scanSubmissions({ conversationId: this.root.id }, 100, cursor, context)))
      this.submissions.set(record.id, record);
    this.stream = await watchEvents(this.harness, this.root.id, context);
    this.stream.start(async events => {
      for (const event of events) if (event.type === "submission") this.submissions.set(event.record.id, event.record);
      await this.options.onSnapshot(await this.snapshot());
    });
    void this.stream.closed.then(end => {
      if (!this.closed && end.reason === "listener_error") this.options.onExit(end.error);
    });
  }
  private async pages<T>(read: (cursor: any) => Promise<{ items: readonly T[]; next?: any }>): Promise<T[]> {
    const values: T[] = []; let cursor: any;
    do { const page = await read(cursor); values.push(...page.items); cursor = page.next; } while (cursor !== undefined);
    return values;
  }
  /** Reads one consistent native commit. Immutable entries and terminal tasks are cached. */
  snapshot(): Promise<PiSnapshot> {
    const read = this.reads.catch(() => {}).then(() => this.root.commit(async tx => {
      const tail = this.entries.at(-1)?.id;
      const added = (await this.pages(cursor => tx.scanEntries({ conversationId: this.root.id, order: "ascending",
        ...(tail === undefined ? {} : { minEntryId: tail }) }, 100, cursor))).filter(entry => tail === undefined || entry.id > tail);
      const entries = [...this.entries, ...added];
      const live = JSON.parse(JSON.stringify(await tx.doc(LiveDoc, this.root.id))) as LiveState;
      const inbox = JSON.parse(JSON.stringify(await tx.doc(InboxDoc, this.root.id))).items as Value[];
      const agent = JSON.parse(JSON.stringify(await tx.doc(AgentDoc, this.root.id))) as AgentState;
      const usage = JSON.parse(JSON.stringify(await tx.doc(UsageDoc, this.root.id))) as UsageState;
      const submissions = new Map(this.submissions);
      // Terminal submissions are immutable; refresh only pending and newly placed inputs.
      const requestIds = new Set([...this.submissions.values()].filter(s => s.status === "queued" || s.status === "placed")
        .map(s => s.requestId).filter((id): id is string => !!id));
      for (const entry of added) if ((entry.data as Value)?.turnId) requestIds.add((entry.data as Value).turnId);
      for (const item of inbox) if (item.entry?.data?.turnId) requestIds.add(item.entry.data.turnId);
      for (const id of requestIds) { const s = await tx.submissionByRequest(this.root.id, id); if (s) submissions.set(s.id, s); }
      const tasks = new Map(this.tasks);
      const ids = new Set<number>([...tasks.values()].filter(task => task.state.status !== "terminal").map(task => task.id));
      for (const entry of added) if (entry.byTaskId !== undefined) ids.add(entry.byTaskId);
      if (live.run) ids.add(live.run.taskId);
      for (const tool of [...live.tools ?? [], ...live.nestedTools ?? []]) if (tool.taskId !== undefined) ids.add(tool.taskId);
      // Include owners to preserve a run's earliest time across tool continuations.
      for (const id of ids) {
        const task = await tx.task(id as any); if (!task) continue;
        tasks.set(id, task); if (task.owner !== undefined && !tasks.has(task.owner)) ids.add(task.owner);
      }
      return { entries, submissions: [...submissions.values()], tasks, agent, live, usage, inbox };
    }, context)).then(snapshot => {
      this.entries = [...snapshot.entries]; this.tasks = new Map(snapshot.tasks);
      for (const record of snapshot.submissions) this.submissions.set(record.id, record);
      return snapshot;
    });
    this.reads = read;
    return read;
  }
  async configure(change: Value) {
    await this.root.configure(change, context);
  }
  tools(tools: Value[]) { this.replaceTools(tools); }
  async forkContext(): Promise<PiForkContext> {
    const instructions = await this.root.commit(async tx => {
      const doc = await tx.doc(InstructionDoc, this.root.id);
      return { base: doc.base, developer: doc.developer };
    }, context);
    const view = await this.root.context(context);
    return { messages: view.messages, base: instructions.base, developer: instructions.developer };
  }
  async inject(messages: ContextView["messages"]) {
    await this.root.commit(tx => tx.appendEntry(this.root.id, { kind: "opencraft.injected", model: messages }), context);
  }
  async instructions(base: string | undefined, developer: string | undefined) {
    if (base === undefined && developer === undefined) return;
    await this.root.commit(async tx => {
      const doc = await tx.doc(InstructionDoc, this.root.id);
      if (base !== undefined) doc.base = base;
      if (developer !== undefined) doc.developer = developer;
      // Both documents change on the same durable transaction.
      const agent = await tx.doc(AgentDoc, this.root.id);
      if (doc.developer == null) delete agent.instructions; else agent.instructions = doc.developer;
    }, context);
  }
  /** A content-free native receipt lookup, independent of transcript projection. */
  async execution(requestId: string): Promise<"running" | "completed" | "failed" | null> {
    const record = await this.storage.submissionByRequest(this.root.id, requestId, context);
    if (!record || record.type !== "input") return null;
    return record.status === "done" ? "completed" : record.status === "unanswered" ? "failed" : "running";
  }
  async submit(content: any, data: Value, requestId: string) {
    const admitted = await this.root.submit({ type: "input", content, whenBusy: "reject", requestId,
      entry: { kind: "opencraft.input", data } }, context);
    this.submissions.set(admitted.id, await admitted.status(context));
    return admitted;
  }
  resume() { this.harness.resume(); }
  /** Host-only provenance; no model message and no human sender is fabricated. */
  async recordRecovery(turnId: string, inputId: string) {
    await this.root.commit(tx => tx.appendEntry(this.root.id, { kind: "opencraft.systemRecovery",
      data: { turnId, inputId, sourceKind: "system", createdAtMs: Date.now() } }), context);
  }
  async abort() { await this.root.abort(context); }
  async close() {
    if (this.closed) return; this.closed = true;
    try { try { await this.stream?.stop(); } finally { await this.harness?.close(context); } }
    finally {
      try { await Promise.all([...this.environments.values()].map(env => env.cleanup(context))); }
      finally { await this.release?.(); }
    }
  }
}

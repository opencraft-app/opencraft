import { join } from "node:path";
import { PiShellWorker, PiShellDoc, shellText, shellDescription } from "./shell.js";
import { isDeepStrictEqual } from "node:util";
import { PiQueueDoc, type PiQueueState, type PiQueuedInput } from "./queue.js";
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
  queue?: PiQueueState;
  shell?: { records: import("./shell.js").ShellRecord[]; paused: boolean };
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
// Pi 1.3.0's admission kernel is used inside the same transaction as the shell
// receipt: it starts idle runs and preserves inbox ordering, with stop checked atomically.
const nativeAdmissions = () => import(new URL("./harness/submissions.js", import.meta.resolve("@earendil-works/pi-durable")).href);
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
  private shell!: PiShellWorker;
  private shellSchema!: Value;
  private shellEvents: Promise<unknown> = Promise.resolve();
  private shellLaunches = 0;
  private shellNotifications = 0;
  private readonly shellWaiters = new Map<string, () => void>();
  private readonly earlyShellNotifications = new Map<string, Value[]>();
  private replaceTools!: (tools: Value[]) => void;
  private constructor(private readonly options: { threadId: string; cwd: string; file: string; agentDirectory: string; models: ModelRuntime; tools: Value[];
    ephemeral?: boolean; inherited?: PiForkContext;
    admissionOpen?(): boolean;
    admitBackground?<T>(operation: () => Promise<T>): Promise<T>;
    prepareRecovery?(snapshot: PiSnapshot): Promise<Value[] | undefined>;
    onSnapshot(snapshot: PiSnapshot): Promise<void> | void; onTool(request: Value, signal: AbortSignal): Promise<unknown>; onExit(error: Error): void }) {}
  static async open(options: PiDurableSession["options"]) {
    const session = new PiDurableSession(options);
    try { await session.open(); return session; }
    catch (error) { await session.close(); throw error; }
  }
  private async open() {
    if (!this.options.ephemeral) this.release = await lockfile.lock(this.options.file, { realpath: false, stale: 10_000,
      retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
    this.shell = new PiShellWorker({ cwd: this.options.cwd, directory: join(this.options.agentDirectory, "shell", this.options.threadId), threadId: this.options.threadId,
      onNotification: event => { this.shellNotifications++; this.shellEvents = this.shellEvents.then(() => this.shellNotification(event)).catch(error => { if (!this.closed) this.options.onExit(new Error("Pi shell notification could not be committed")); }).finally(() => { this.shellNotifications--; }); },
      onLost: generation => { this.shellEvents = this.shellEvents.then(() => this.interruptShells("Shell owner exited; the command was not replayed.", true, generation)).catch(() => { if (!this.closed) this.options.onExit(new Error("Pi shell owner failed")); }); },
    });
    this.shellSchema = (await this.shell.start()).parameters;
    const registry = createRegistry();
    // Keep native file tools. Shell commands use the conversation-owned yielding PTY.
    registry.install(defineExtension({ ...CodingTools, tools: CodingTools.tools!.filter(tool => tool.name !== "bash") }));
    registry.install(defineExtension({ name: "opencraft.pi-shell", tools: [
      defineTool({ name: "interactive_shell", description: shellDescription, parameters: this.shellSchema as any,
        execute: (args: any, api: any, ctx: Context) => this.executeShell(args, api, ctx) }),
      defineTool({ name: "bash", description: "Run a bash command in a managed PTY. Returns a sessionId immediately while the command continues; completion arrives automatically. Query, send input, or stop with interactive_shell. timeout is in seconds. Long commands do not block user steering.",
        parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", exclusiveMinimum: 0, maximum: 2147483.647 }, yield_time_ms: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["command"], additionalProperties: false } as any,
        structuredOutputSchema: { type: "object", properties: { output: { type: "string" }, truncated: { type: "boolean" }, exitCode: { type: "number" }, sessionId: { type: "string" } }, required: ["output", "truncated"] } as any,
        execute: (args: any, api: any, ctx: Context) => this.executeShell({ command: args.command, ...(args.timeout == null ? {} : { timeout: args.timeout * 1000 }) }, api, ctx, args.yield_time_ms ?? 1000) }),
    ] }));
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
        const origin = await this.root.commit(async tx => {
          const live = await tx.doc(LiveDoc, this.root.id);
          const owns = [...live.tools ?? [], ...live.nestedTools ?? []].some(slot => slot.taskId === api.taskId);
          if (!owns || live.run?.inputs[0] === undefined) throw new Error("Tool execution has expired");
          const input = await this.storage.submission(live.run.inputs[0], ctx);
          if (!input?.requestId) throw new Error("Tool execution has no native submission");
          return input.requestId;
        }, ctx);
        let result: Value;
        try { result = await Promise.race([this.options.onTool({ id: api.callId, name: tool.piName, arguments: args, turnId: origin }, ctx.abortSignal ?? new AbortController().signal), cancelled]) as Value; }
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
      if (!env) { env = new NodeExecutionEnv({ cwd, shellEnv: { OPENCRAFT_THREAD_ID: this.options.threadId } }); this.environments.set(cwd, env); }
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
    await this.interruptShells("Shell owner restarted; the previous command was interrupted and was not replayed.", false);
    if (this.options.inherited) {
      const inherited = this.options.inherited;
      await this.instructions(inherited.base ?? undefined, inherited.developer ?? undefined);
      await this.root.commit(tx => tx.appendEntry(this.root.id, { kind: "opencraft.reference", model: inherited.messages }), context);
    }
    for (const record of await this.pages(cursor => this.storage.scanSubmissions({ conversationId: this.root.id }, 100, cursor, context)))
      this.submissions.set(record.id, record);
    const recoveredTools = await this.options.prepareRecovery?.(await this.snapshot());
    if (recoveredTools) this.replaceTools(recoveredTools);
    this.stream = await watchEvents(this.harness, this.root.id, context);
    this.stream.start(async events => {
      for (const event of events) if (event.type === "submission") this.submissions.set(event.record.id, event.record);
      await this.options.onSnapshot(await this.snapshot());
    });
    await this.deliverShellNotifications();
    void this.stream.closed.then(end => {
      if (!this.closed && end.reason === "listener_error") this.options.onExit(end.error);
    });
  }
  private async executeShell(args: Value, api: Value, ctx: Context, waitMs: number | undefined = undefined) {
    if (this.closed || ctx.abortSignal?.aborted) throw new Error("Pi shell call cancelled");
    const isLaunch = typeof args.command === "string" || args.spawn != null || args.mode === "monitor" && args.sessionId == null;
    if (isLaunch && this.shellLaunches >= 8) throw new Error("Too many concurrent shell launches");
    if (isLaunch) this.shellLaunches++;
    try {
    if (isLaunch) await this.root.commit(async tx => {
      const doc = await tx.doc(PiShellDoc, this.root.id);
      if (doc.records.filter(record => record.state === "running").length + this.shellLaunches > 8) throw new Error("Stop an existing shell session before starting another");
      if (doc.records.length >= 40 && !doc.records.some(record => record.state !== "running" && record.notified))
        throw new Error("Shell session history is full");
      doc.paused = false;
    }, context);
    if (typeof args.sessionId === "string") {
      const record = await this.root.commit(async tx => {
        const found = (await tx.doc(PiShellDoc, this.root.id)).records.find(record => record.id === args.sessionId);
        // Document proxies are valid only inside their native transaction.
        return found ? JSON.parse(JSON.stringify(found)) as typeof found : undefined;
      }, context);
      if (!record) return { output: [{ type: "text" as const, text: "Shell session does not belong to this conversation" }], isError: true };
      if (record.generation !== this.shell.generation || record.state !== "running")
        return { output: [{ type: "text" as const, text: `Session ${record.id}: ${record.state}\n${record.output}` }], isError: record.state === "interrupted" || record.isError };
    }
    const cwd = (await api.agent(ctx)).cwd ?? this.options.cwd;
    const params = { ...args, cwd: args.cwd ?? cwd,
      ...(isLaunch && args.mode == null ? { mode: "dispatch" } : {}),
      ...(isLaunch && (args.mode == null || args.mode === "dispatch") ? { background: true, handsFree: { ...args.handsFree, autoExitOnQuiet: false } } : {}),
      ...(isLaunch && args.mode === "monitor" ? { background: true } : {}),
    };
    const result = await this.shell.call(params, ctx.abortSignal);
    const id = result.details?.sessionId;
    if (!isLaunch && args.kill === true && typeof args.sessionId === "string" && !result.isError && result.details?.status === "killed") {
      // The extension suppresses completion delivery for an agent-handled kill.
      // Its successful control receipt must retire native custody directly.
      await this.root.commit(async tx => {
        const record = (await tx.doc(PiShellDoc, this.root.id)).records.find(record => record.id === args.sessionId);
        if (record?.state !== "running") return;
        record.state = "interrupted"; record.notified = true;
        record.output = shellText(result).slice(-16384);
      }, context);
      this.shellWaiters.get(args.sessionId)?.();
    }
    if (isLaunch && !result.isError && typeof id === "string") {
      await this.root.commit(async tx => {
        const doc = await tx.doc(PiShellDoc, this.root.id);
        const live = await tx.doc(LiveDoc, this.root.id);
        const input = live.run?.inputs[0] === undefined ? undefined : await this.storage.submission(live.run.inputs[0], context);
        while (doc.records.length >= 40) {
          const index = doc.records.findIndex(record => record.state !== "running" && record.notified);
          if (index < 0) throw new Error("Shell session history is full");
          doc.records.splice(index, 1);
        }
        doc.records.push({ id, state: "running", command: args.command ?? "spawn", output: shellText(result).slice(-16384),
          detached: waitMs == null || waitMs === 0, createdAtMs: Date.now(), generation: this.shell.generation, ...(input?.requestId ? { turnId: input.requestId } : {}) });
      }, context);
      const early = this.earlyShellNotifications.get(id);
      if (early) { this.earlyShellNotifications.delete(id); for (const event of early) await this.shellNotification(event); }
      if (waitMs != null && waitMs > 0) {
        let wake!: () => void;
        const completed = new Promise<void>(resolve => { wake = resolve; });
        this.shellWaiters.set(id, wake);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => wake();
        ctx.abortSignal?.addEventListener("abort", cancel, { once: true });
        try {
          const state = await this.root.commit(async tx => (await tx.doc(PiShellDoc, this.root.id)).records.find(record => record.id === id)?.state, context);
          if (state === "running") await Promise.race([completed, new Promise<void>(resolve => { deadline = setTimeout(resolve, waitMs); })]);
        } finally { clearTimeout(deadline); this.shellWaiters.delete(id); ctx.abortSignal?.removeEventListener("abort", cancel); }
        const finished = await this.root.commit(async tx => {
          const record = (await tx.doc(PiShellDoc, this.root.id)).records.find(record => record.id === id)!;
          if (record.state === "completed") { record.notified = true; return { output: record.rawOutput ?? record.output, isError: record.isError, truncated: record.truncated ?? false, exitCode: record.exitCode }; }
          record.detached = true; return null;
        }, context);
        if (finished) return { output: [{ type: "text" as const, text: finished.output }], isError: finished.isError,
          structuredOutput: { output: finished.output, truncated: finished.truncated, ...(finished.exitCode == null ? {} : { exitCode: finished.exitCode }) } };
        await this.deliverShellNotifications();
      }
    }
    return { output: result.content ?? [], isError: result.isError, ...(result.details ? { details: result.details } : {}),
      ...(waitMs == null ? {} : { structuredOutput: { output: shellText(result), truncated: false, ...(typeof id === "string" ? { sessionId: id } : {}) } }) } as any;
    } finally { if (isLaunch) this.shellLaunches--; }
  }
  private async shellNotification(event: Value) {
    if (this.closed || !this.root || !event.triggerTurn) return;
    const message = event.message;
    const id = message?.details?.sessionId;
    if (typeof id !== "string" || typeof message.content !== "string") return;
    const found = await this.root.commit(async tx => {
      const doc = await tx.doc(PiShellDoc, this.root.id);
      const record = doc.records.find(record => record.id === id);
      if (!record) return false;
      if (record.state !== "running") return true;
      if (message.customType === "interactive-shell-monitor-event") {
        if (doc.paused || !Number.isSafeInteger(message.details.eventId)) return true;
        const requestId = `pi-shell:${record.generation}:${id}:event:${message.details.eventId}`;
        if (!await tx.submissionByRequest(this.root.id, requestId)) {
          record.monitorEvents ??= [];
          if (!record.monitorEvents.some(event => event.id === message.details.eventId))
            record.monitorEvents.push({ id: message.details.eventId, content: message.content.slice(-16384), createdAtMs: Date.now() });
        }
        return true;
      }
      record.state = "completed"; record.output = message.content.slice(-16384);
      if (typeof event.commandResult?.output === "string") {
        record.rawOutput = event.commandResult.output.slice(-16384);
        if (message.customType === "interactive-shell-monitor-lifecycle" && record.rawOutput) record.output = (record.output + "\nOutput:\n" + record.rawOutput).slice(-16384);
        record.truncated = event.commandResult.truncated === true;
        if (typeof event.commandResult.exitCode === "number") record.exitCode = event.commandResult.exitCode;
      }
      record.isError = (message.details?.completion ?? message.details)?.exitCode != null && (message.details?.completion ?? message.details).exitCode !== 0
        || (message.details?.completion ?? message.details)?.timedOut === true || (message.details?.completion ?? message.details)?.cancelled === true;
      if (doc.paused) record.notified = true;
      return true;
    }, context);
    this.shellWaiters.get(id)?.();
    if (!found) {
      const pending = this.earlyShellNotifications.get(id) ?? [];
      if (this.earlyShellNotifications.size < 16 && pending.length < 16) { pending.push(event); this.earlyShellNotifications.set(id, pending); }
      return;
    }
    await this.deliverShellNotifications();
  }
  private async interruptShells(reason: string, notify: boolean, generation?: string) {
    if (!this.root || this.closed) return;
    await this.root.commit(async tx => {
      const doc = await tx.doc(PiShellDoc, this.root.id);
      for (const record of doc.records) if (record.state === "running" && (generation === undefined || record.generation === generation)) {
        record.state = "interrupted"; record.output = reason + "\n" + record.output;
        if (doc.paused || !record.detached) record.notified = true;
      }
    }, context);
    if (notify) await this.deliverShellNotifications();
  }
  private async deliverShellNotifications() {
    if (this.closed || this.options.admissionOpen?.() === false) return;
    // Import before entering the admission boundary. The entire commit stays
    // counted, and its final native mutation checks the fence again.
    const { admitSubmission } = await nativeAdmissions();
    let entered = false, admitted = false;
    const deliver = async () => {
      entered = true;
      await this.root.commit(async tx => {
        const doc = await tx.doc(PiShellDoc, this.root.id);
        if (doc.paused) return;
        for (const record of doc.records) {
          while (record.monitorEvents?.length) {
            const event = record.monitorEvents[0]!;
            if (this.closed || this.options.admissionOpen?.() === false) return;
            const requestId = `pi-shell:${record.generation}:${record.id}:event:${event.id}`;
            await admitSubmission(tx, this.root.id, { type: "input", requestId, whenBusy: "followUp", content: event.content,
              entry: { kind: "opencraft.shellNotification", data: { sourceKind: "system", turnId: requestId, createdAtMs: event.createdAtMs } } }, Date.now(),
              { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
            record.monitorEvents.shift(); admitted = true;
          }
          if (record.state === "running" || record.notified || !record.detached) continue;
          if (this.closed || this.options.admissionOpen?.() === false) return;
          const requestId = `pi-shell:${record.generation}:${record.id}`;
          await admitSubmission(tx, this.root.id, { type: "input", requestId, whenBusy: "followUp", content: `Background shell result (${record.id}):\n${record.output}`,
            entry: { kind: "opencraft.shellNotification", data: { sourceKind: "system", turnId: requestId, createdAtMs: Date.now() } } }, Date.now(),
            { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
          record.notified = true; admitted = true;
        }
      }, context);
    };
    try { await (this.options.admitBackground ? this.options.admitBackground(deliver) : deliver()); }
    catch (error) { if (entered || this.options.admissionOpen?.() !== false) throw error; }
    if (admitted && this.options.admissionOpen?.() !== false) this.harness.resume();
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
      const queueDoc = await tx.doc(PiQueueDoc, this.root.id);
      // Reconcile a crash between native admission and retiring draft custody.
      // The stable submission identity is authoritative even when its ACK was lost.
      for (let index = queueDoc.items.length - 1; index >= 0; index--) {
        if (await tx.submissionByRequest(this.root.id, queueDoc.items[index]!.id)) queueDoc.items.splice(index, 1);
      }
      const queue = JSON.parse(JSON.stringify(queueDoc)) as PiQueueState;
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
      const shell = JSON.parse(JSON.stringify(await tx.doc(PiShellDoc, this.root.id))) as PiSnapshot["shell"];
      return { entries, submissions: [...submissions.values()], tasks, agent, live, usage, inbox, queue, shell };
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
  /** Guard and enqueue on the native commit line: a late steer must never start an idle run. */
  async steer(content: any, data: Value, requestId: string, expectedTurnId: string, queuedId?: string) {
    const record = await this.root.commit(async tx => {
      const existing = await tx.submissionByRequest(this.root.id, requestId);
      const queue = await tx.doc(PiQueueDoc, this.root.id);
      const inbox = await tx.doc(InboxDoc, this.root.id);
      if (existing) {
        const entry = existing.entry === undefined ? undefined : await tx.entry(existing.entry);
        let metadata = entry?.data as Value | undefined;
        metadata ??= inbox.items.find(item => item.id === existing.id)?.entry?.data as Value | undefined;
        if (!metadata) metadata = (await this.pages(cursor => tx.scanEntries({ conversationId: this.root.id, order: "descending" }, 100, cursor)))
          .find(entry => entry.kind === "opencraft.steerAdmission" && (entry.data as Value)?.turnId === requestId)?.data as Value | undefined;
        if (queuedId === undefined && metadata && (!isDeepStrictEqual(metadata.input, data.input)
          || !isDeepStrictEqual(metadata.additionalContext ?? null, data.additionalContext ?? null)))
          throw new Error("Client message identity already belongs to different input");
        if (metadata?.steerTurnId !== expectedTurnId) throw new Error("Queued input has already been dispatched");
        return existing;
      }
      const queuedIndex = queuedId === undefined ? -1 : queue.items.findIndex(item => item.id === queuedId && item.state === "queued");
      if (queuedId !== undefined && queuedIndex < 0) throw new Error("Queued input is no longer pending");
      const live = await tx.doc(LiveDoc, this.root.id);
      let matches = false;
      for (const id of live.run?.inputs ?? []) {
        const input = await this.storage.submission(id, context);
        if (input?.requestId === expectedTurnId) matches = true;
        if (input?.entry !== undefined) {
          const entry = await tx.entry(input.entry);
          if ((entry?.data as Value)?.steerTurnId === expectedTurnId) matches = true;
        }
      }
      if (!matches) throw new Error("Pi turn identity changed");
      if (queuedIndex >= 0) queue.items.splice(queuedIndex, 1);
      const admitted = await tx.createSubmission({ conversationId: this.root.id, requestId, type: "input", status: "queued" });
      // Native withdrawal removes the inbox item; retain its presentation metadata
      // in the same native transaction, without inserting another model message.
      await tx.appendEntry(this.root.id, { kind: "opencraft.steerAdmission", data });
      inbox.items.push({ id: admitted.id, mode: "steer", content,
        entry: { kind: "opencraft.input", data } });
      return admitted;
    }, context);
    this.submissions.set(record.id, record);
    this.harness.resume();
  }
  async enqueue(item: PiQueuedInput) {
    return this.root.commit(async tx => {
      const queue = await tx.doc(PiQueueDoc, this.root.id);
      const pending = queue.items.find(candidate => candidate.id === item.id);
      const receipt = await tx.submissionByRequest(this.root.id, item.id);
      const entry = receipt?.entry === undefined ? undefined : await tx.entry(receipt.entry);
      const inbox = await tx.doc(InboxDoc, this.root.id);
      const previous = (pending ?? entry?.data ?? inbox.items.find(candidate => candidate.id === receipt?.id)?.entry?.data) as PiQueuedInput | undefined;
      if (previous && (!isDeepStrictEqual(previous.input, item.input)
        || !isDeepStrictEqual(previous.additionalContext ?? null, item.additionalContext)))
        throw new Error("Client message identity already belongs to different input");
      if (pending) return JSON.parse(JSON.stringify(pending)) as PiQueuedInput;
      if (receipt) {
        // A dispatched input is historical native custody, not a new enqueue.
        // Never echo the replaying caller's nonce into an old receipt. Older
        // native records without an admission proof remain unproven.
        const {executionAdmission:_replayed,...projection}=item;
        return {...projection, ...(previous?.executionAdmission ? {executionAdmission:previous.executionAdmission} : {})};
      }
      if (queue.items.length >= 50) throw new Error("The Pi message queue is full");
      queue.items.push(item); return item;
    }, context);
  }
  async changeQueue(action: "update" | "delete" | "reorder" | "pause", id?: string, replacement?: PiQueuedInput, order?: string[]) {
    return this.root.commit(async tx => {
      const queue = await tx.doc(PiQueueDoc, this.root.id);
      if (action === "pause") { queue.paused = true; queue.pauseReason = "user-stopped"; return null; }
      if (action === "reorder") {
        if (!order || order.length !== queue.items.length || new Set(order).size !== order.length
          || queue.items.some(item => item.state !== "queued" || !order.includes(item.id))) throw new Error("Pi queue order changed; refresh before reordering");
        const items = [...queue.items]; queue.items.splice(0, queue.items.length, ...order.map(id => items.find(item => item.id === id)!)); return null;
      }
      const index = queue.items.findIndex(item => item.id === id && item.state === "queued");
      if (index < 0) {
        if (action === "delete") return false;
        throw new Error("Queued input is no longer editable");
      }
      const item = JSON.parse(JSON.stringify(queue.items[index]!)) as PiQueuedInput;
      if (action === "update") {
        if (!replacement) throw new Error("Missing replacement input");
        queue.items[index] = replacement; return replacement;
      }
      // Retain a native idempotency tombstone, without creating a model message.
      const existing = await tx.submissionByRequest(this.root.id, item.id);
      if (existing) throw new Error("Queued input has already been dispatched");
      const entry = await tx.appendEntry(this.root.id, { kind: "opencraft.queueCancelled", data: { ...item, turnId: item.id } });
      const record = await tx.createSubmission({ conversationId: this.root.id, type: "input", requestId: item.id, status: "placed", entry: entry.id });
      tx.settleSubmission(record.id, { status: "unanswered", reason: "aborted" });
      queue.items.splice(index, 1); return true;
    }, context);
  }
  async unpauseQueue() {
    await this.root.commit(async tx => { const queue = await tx.doc(PiQueueDoc, this.root.id); queue.paused = false; delete queue.pauseReason; }, context);
  }
  async claimQueue(id?: string, explicit = false) {
    return this.root.commit(async tx => {
      const queue = await tx.doc(PiQueueDoc, this.root.id);
      const live = await tx.doc(LiveDoc, this.root.id);
      if (live.run || queue.paused && !explicit) return null;
      const item = id === undefined ? queue.items[0] : queue.items.find(item => item.id === id);
      if (!item) return null;
      if (explicit) { queue.paused = false; delete queue.pauseReason; }
      item.state = "dispatching";
      return JSON.parse(JSON.stringify(item)) as PiQueuedInput;
    }, context);
  }
  async settleQueue(id: string, failed = false) {
    await this.root.commit(async tx => {
      const queue = await tx.doc(PiQueueDoc, this.root.id);
      const index = queue.items.findIndex(item => item.id === id);
      if (index < 0) return;
      if (failed) { queue.items[index]!.state = "queued"; queue.paused = true; queue.pauseReason = "delivery-failed"; }
      else queue.items.splice(index, 1);
    }, context);
  }
  get backgroundWork() { return this.shellLaunches + this.shellNotifications + [...this.earlyShellNotifications.values()].reduce((n, rows) => n + rows.length, 0); }
  get idleWorkerPid() { return this.shell?.pid; }
  resumeBackground() { return this.deliverShellNotifications(); }
  resume() { if (this.options.admissionOpen?.() !== false) this.harness.resume(); }
  /** Host-only provenance; no model message and no human sender is fabricated. */
  async recordRecovery(turnId: string, inputId: string) {
    await this.root.commit(tx => tx.appendEntry(this.root.id, { kind: "opencraft.systemRecovery",
      data: { turnId, inputId, sourceKind: "system", createdAtMs: Date.now() } }), context);
  }
  async abort() {
    await this.root.commit(async tx => { const doc = await tx.doc(PiShellDoc, this.root.id); doc.paused = true; for (const record of doc.records) record.monitorEvents = []; }, context);
    await this.root.abort(context);
    await this.shell?.stop();
    await this.interruptShells("Stopped by the user; the command was not replayed.", false);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.shell?.stop(); await this.shellEvents.catch(() => {}); try { await this.stream?.stop(); } finally { await this.harness?.close(context); } }
    finally {
      try { await Promise.all([...this.environments.values()].map(env => env.cleanup(context))); }
      finally { await this.release?.(); }
    }
  }
}

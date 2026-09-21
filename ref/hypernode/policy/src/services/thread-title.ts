import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecyclePrincipal, ThreadLifecycleThread } from "../types/thread-lifecycle.ts";
import type {
  ThreadTitleChange,
  ThreadTitlePort,
  ThreadTitleRecord,
  ThreadTitleSetOptions,
} from "../types/thread-metadata.ts";
import { canonicalThreadTitle, cloudThreadName } from "./thread-identity.ts";

type Dependencies = "principal" | "threadManager";

interface ThreadTitleSnapshot {
  version: 1;
  records: ThreadTitleRecord[];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function actorFields(actor: ThreadTitleSetOptions["actor"]): Pick<
  ThreadTitleRecord,
  "updatedBy" | "updatedByUsername"
> {
  return {
    updatedBy: actor?.id ?? null,
    updatedByUsername: actor?.username ?? null,
  };
}

function titleRecord(value: unknown): ThreadTitleRecord | null {
  const record = objectRecord(value);
  if (record === null || typeof record["threadId"] !== "string" ||
      typeof record["text"] !== "string") return null;
  return {
    threadId: record["threadId"],
    text: canonicalThreadTitle(record["text"]),
    revision: Math.max(1, Number(record["revision"]) || 1),
    updatedBy: typeof record["updatedBy"] === "string" ? record["updatedBy"] : null,
    updatedByUsername: typeof record["updatedByUsername"] === "string"
      ? record["updatedByUsername"]
      : null,
    updatedAtMs: Number.isFinite(record["updatedAtMs"])
      ? Number(record["updatedAtMs"])
      : Date.now(),
    source: typeof record["source"] === "string" ? record["source"] : "migration",
    sourceThreadId: typeof record["sourceThreadId"] === "string"
      ? record["sourceThreadId"]
      : null,
  };
}

function titleSnapshot(value: unknown): ThreadTitleSnapshot | null {
  const snapshot = objectRecord(value);
  if (snapshot?.["version"] !== 1 || !Array.isArray(snapshot["records"])) return null;
  return {
    version: 1,
    records: snapshot["records"].map(titleRecord).filter(
      (record): record is ThreadTitleRecord => record !== null,
    ),
  };
}

export class ThreadTitleService extends Service implements ThreadTitlePort {
  static inject = ["principal", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly principal: ThreadLifecyclePrincipal;
  readonly records = new Map<string, ThreadTitleRecord>();
  readonly listeners = new Set<(event: ThreadTitleChange) => void>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadTitle");
    this.principal = ctx.principal.current();
    this.load();
    this.migrate();
    ctx.effect(() => ctx.threadManager.attachTitleService(this));
  }

  load(): void {
    const encoded = policyStore.get("threadTitles", this.principal.id);
    if (encoded === null) return;
    const snapshot = titleSnapshot(JSON.parse(encoded) as unknown);
    if (snapshot === null) throw new Error("unsupported thread title catalog");
    for (const record of snapshot.records) this.records.set(record.threadId, record);
  }

  persist(): void {
    const records = [...this.records.values()].filter((record) => {
      const thread: ThreadLifecycleThread | null | undefined =
        this.ctx.threadManager.find(record.threadId);
      return thread !== null && thread !== undefined && thread.ephemeral !== true;
    });
    policyStore.set("threadTitles", this.principal.id, JSON.stringify({ version: 1, records }));
  }

  migrate(): void {
    let changed = false;
    for (const threadId of this.records.keys()) {
      if (this.ctx.threadManager.find(threadId)) continue;
      this.records.delete(threadId);
      changed = true;
    }
    for (const thread of this.ctx.threadManager.threads.values()) {
      let record = this.records.get(thread.id);
      if (record === undefined) {
        record = {
          threadId: thread.id,
          text: canonicalThreadTitle(thread.name, thread.preview),
          revision: 1,
          updatedBy: null,
          updatedByUsername: null,
          updatedAtMs: Date.now(),
          source: "migration",
          sourceThreadId: thread.forkedFromId ?? null,
        };
        this.records.set(thread.id, record);
        changed = true;
      }
      thread.name = cloudThreadName(record.text, thread.preview);
    }
    if (changed) this.persist();
    this.ctx.threadManager.persist();
  }

  onChange(listener: (event: ThreadTitleChange) => void): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(record: ThreadTitleRecord): void {
    for (const listener of this.listeners) {
      listener({ threadId: record.threadId, record: { ...record } });
    }
  }

  get(threadId: string): ThreadTitleRecord | null {
    return this.records.get(threadId) ?? null;
  }

  text(threadId: string): string | null {
    return this.get(threadId)?.text ?? null;
  }

  ensure(
    thread: ThreadLifecycleThread,
    value: unknown = thread.name,
    options: ThreadTitleSetOptions = {},
  ): ThreadTitleRecord {
    if (!thread.id) throw new Error("thread title requires a thread");
    const existing = this.records.get(thread.id);
    if (existing !== undefined) {
      thread.name = cloudThreadName(existing.text, thread.preview);
      return existing;
    }
    const record: ThreadTitleRecord = {
      threadId: thread.id,
      text: canonicalThreadTitle(value, thread.preview),
      revision: 1,
      ...actorFields(options.actor),
      updatedAtMs: options.now ?? Date.now(),
      source: options.source ?? "create",
      sourceThreadId: options.sourceThreadId ?? thread.forkedFromId ?? null,
    };
    this.records.set(thread.id, record);
    thread.name = cloudThreadName(record.text, thread.preview);
    if (!thread.ephemeral) this.persist();
    return record;
  }

  set(threadId: string, value: string, options: ThreadTitleSetOptions = {}): ThreadTitleRecord {
    const thread: ThreadLifecycleThread = this.ctx.threadManager.get(threadId);
    const current = this.ensure(thread, thread.name, options);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw Object.assign(
        new Error(
          `thread title revision conflict: expected ${options.expectedRevision}, current ${current.revision}`,
        ),
        {
          code: -32072,
          data: {
            kind: "threadTitleRevisionConflict",
            threadId,
            current: { ...current },
          },
        },
      );
    }
    const text = canonicalThreadTitle(value, thread.preview);
    if (text === current.text) {
      thread.name = cloudThreadName(current.text, thread.preview);
      if (options.attributeIfSame !== true) return current;
      const record: ThreadTitleRecord = {
        ...current,
        ...actorFields(options.actor),
        updatedAtMs: options.now ?? Date.now(),
        source: options.source ?? current.source,
      };
      this.records.set(threadId, record);
      if (!thread.ephemeral) this.persist();
      return record;
    }
    const record: ThreadTitleRecord = {
      ...current,
      text,
      revision: current.revision + 1,
      ...actorFields(options.actor),
      updatedAtMs: options.now ?? Date.now(),
      source: options.source ?? "user",
    };
    this.records.set(threadId, record);
    thread.name = cloudThreadName(record.text, thread.preview);
    if (!thread.ephemeral) this.persist();
    if (options.persistThread !== false) this.ctx.threadManager.changed(threadId);
    this.emit(record);
    return record;
  }

  inherit(
    sourceThreadId: string,
    destinationThreadId: string,
    options: ThreadTitleSetOptions = {},
  ): ThreadTitleRecord {
    const source: ThreadLifecycleThread = this.ctx.threadManager.get(sourceThreadId);
    const destination: ThreadLifecycleThread = this.ctx.threadManager.get(destinationThreadId);
    const sourceRecord = this.ensure(source);
    const record: ThreadTitleRecord = {
      threadId: destination.id,
      text: sourceRecord.text,
      revision: 1,
      ...actorFields(options.actor),
      updatedAtMs: options.now ?? Date.now(),
      source: "fork",
      sourceThreadId,
    };
    this.records.set(destination.id, record);
    destination.name = cloudThreadName(record.text, destination.preview);
    if (!destination.ephemeral) this.persist();
    return record;
  }

  remove(threadId: string): void {
    if (!this.records.delete(threadId)) return;
    this.persist();
  }
}

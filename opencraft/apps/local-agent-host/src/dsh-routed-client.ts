import { DshClient, type DshHistoryEntry, type DshStreamEnvelope } from "./dsh-client.js";
import { DshSessionRouting } from "./dsh-session-routing.js";
import { DshHistoryIndex } from "./dsh-history-index.js";

/** Only transport identifiers change. Renderer protocol identities stay logical. */
export class DshRoutedClient extends DshClient {
  private readonly volatileIds = new Set<string>();
  private readonly volatileIndexes = new Map<string, DshHistoryIndex>();
  markVolatile(id: string): void { this.volatileIds.add(id); }
  forgetVolatile(id: string): void { this.volatileIndexes.get(id)?.close(); this.volatileIndexes.delete(id); }
  constructor(baseUrl: string, readonly routing: DshSessionRouting, readonly historyIndex = new DshHistoryIndex(":memory:")) { super(baseUrl); }
  closeIndex(): void { this.historyIndex.close(); for (const index of this.volatileIndexes.values()) index.close(); this.volatileIndexes.clear(); }
  private async hydrateImages(nativeId: string, entry: DshHistoryEntry, signal?: AbortSignal): Promise<DshHistoryEntry> {
    if (!["user/message", "assistant/message", "tool/result"].includes(entry.event.type)) return entry;
    const visit = async (value: any): Promise<any> => {
      if (Array.isArray(value)) return Promise.all(value.map(visit));
      if (!value || typeof value !== "object") return value;
      if (value.type === "image" && typeof value.attachment?.attachmentId === "string") {
        const stored = await super.call<{ attachment: { mediaType: string }; data: string }>("session.attachment", { sessionId: nativeId, attachmentId: value.attachment.attachmentId }, signal);
        return { ...value, mediaType: stored.attachment.mediaType, data: stored.data };
      }
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await visit(child)])));
    };
    return { ...entry, event: { ...entry.event, data: await visit(entry.event.data) } };
  }
  override async call<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal, rpcId?: string): Promise<T> {
    const logicalId = typeof payload.sessionId === "string" ? payload.sessionId : null;
    if (method === "session.history" && logicalId) {
      let index = this.historyIndex;
      if (this.volatileIds.has(logicalId)) {
        index = this.volatileIndexes.get(logicalId) ?? new DshHistoryIndex(":memory:");
        this.volatileIndexes.set(logicalId, index);
      }
      const entries: DshHistoryEntry[] = [];
      const size = typeof payload.maxMessages === "number" ? Math.max(1, payload.maxMessages) : 100;
      const current = this.routing.native(logicalId);
      for (const generation of [...this.routing.generations(logicalId)].reverse()) {
        await index.refresh(generation.nativeId, before => super.call(method, {
          sessionId: generation.nativeId, maxMessages: 100, ...(before === undefined ? {} : { beforeSeq: before }),
        }, signal), generation.nativeId !== current);
        const offset = generation.generation === 0 ? 0 : generation.previousLastSeq - generation.seedThroughSeq;
        const before = typeof payload.beforeSeq === "number" ? payload.beforeSeq - offset : undefined;
        const rows = index.read(generation.nativeId, before, Math.min(Number.MAX_SAFE_INTEGER, size + 1 - entries.length));
        for (const entry of rows) {
          const event = this.routing.event(generation.nativeId, entry.event);
          if (event) entries.push(await this.hydrateImages(generation.nativeId, { ...entry, event }, signal));
        }
        if (entries.length > size) break;
      }
      return { events: entries.slice(0, size).reverse(), hasMore: entries.length > size, projections: index.projections(current) } as T;
    }
    const result = await super.call<any>(method, logicalId ? { ...payload, sessionId: this.routing.native(logicalId) } : payload, signal, rpcId);
    if (method === "session.list" && Array.isArray(result.items)) {
      return { ...result, items: result.items.filter((item: any) => !this.volatileIds.has(item.sessionId) && !this.routing.hidden(item.sessionId) && this.routing.native(this.routing.logical(item.sessionId)) === item.sessionId)
        .map((item: any) => ({ ...item, sessionId: this.routing.logical(item.sessionId) })) } as T;
    }
    return result;
  }
  override async stream(path: "/api/events.mux" | "/api/events.host", onFrame: (frame: DshStreamEnvelope) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const failed = new AbortController();
    const lifetime = AbortSignal.any([signal, failed.signal]);
    let ordered = Promise.resolve();
    try {
      await super.stream(path, frame => {
        ordered = ordered.then(async () => {
          if (lifetime.aborted) return;
          const mapped = this.routing.frame(frame);
          if (!mapped) return;
          if (mapped.payload.type === "session/event" && typeof frame.payload.sessionId === "string") {
            const hydrated = await this.hydrateImages(frame.payload.sessionId, { event: mapped.payload.event as DshHistoryEntry["event"] }, lifetime);
            if (!lifetime.aborted) onFrame({ ...mapped, payload: { ...mapped.payload, event: hydrated.event } });
          } else onFrame(mapped);
        });
        void ordered.catch(() => failed.abort());
      }, lifetime, onOpen);
    } finally { await ordered; }
  }
}

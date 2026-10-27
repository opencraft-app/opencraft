import type {
  ConversationNavigationPreview,
  PreparedConversationNavigationTarget,
  PrepareConversationNavigationTargetOptions,
  ConversationNavigationSnapshot,
  ConversationNavigationSource,
} from "./types";

/** Deduplicates hover reads while leaving authoritative state in the source. */
export class ConversationNavigationController implements ConversationNavigationSource {
  private readonly previews = new Map<string, ConversationNavigationPreview>();
  private readonly pendingPreviews = new Map<string, Promise<ConversationNavigationPreview | null>>();
  private generation: string | null;
  private revision: number;
  private disposed = false;

  constructor(private readonly source: ConversationNavigationSource) {
    const snapshot = source.getSnapshot();
    this.generation = snapshot.generation;
    this.revision = snapshot.revision;
  }

  getSnapshot = (): ConversationNavigationSnapshot => this.source.getSnapshot();

  subscribe = (listener: () => void): (() => void) => this.source.subscribe(() => {
    const snapshot = this.source.getSnapshot();
    if (snapshot.generation !== this.generation || snapshot.revision !== this.revision) {
      this.generation = snapshot.generation;
      this.revision = snapshot.revision;
      this.previews.clear();
      this.pendingPreviews.clear();
    }
    listener();
  });

  prepare(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.source.prepare();
  }

  loadPreview(anchorId: string): Promise<ConversationNavigationPreview | null> {
    if (this.disposed) return Promise.resolve(null);
    const snapshot = this.source.getSnapshot();
    if (snapshot.generation !== this.generation || snapshot.revision !== this.revision) {
      this.generation = snapshot.generation;
      this.revision = snapshot.revision;
      this.previews.clear();
      this.pendingPreviews.clear();
    }
    const requestGeneration = this.generation;
    const requestRevision = this.revision;
    const cached = this.previews.get(anchorId);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pendingPreviews.get(anchorId);
    if (pending !== undefined) return pending;
    const request = this.source.loadPreview(anchorId).then((preview) => {
      const current = this.source.getSnapshot();
      if (
        preview !== null
        && !this.disposed
        && current.generation === requestGeneration
        && current.revision === requestRevision
      ) this.previews.set(anchorId, preview);
      return preview;
    }).finally(() => {
      if (this.pendingPreviews.get(anchorId) === request) this.pendingPreviews.delete(anchorId);
    });
    this.pendingPreviews.set(anchorId, request);
    return request;
  }

  prepareTarget(
    anchorId: string,
    options?: PrepareConversationNavigationTargetOptions,
  ): Promise<PreparedConversationNavigationTarget | null> {
    if (this.disposed) return Promise.resolve(null);
    return this.source.prepareTarget(anchorId, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.previews.clear();
    this.pendingPreviews.clear();
    this.source.dispose();
  }
}

import { createClientId, type ComposerAttachment, type ComposerController } from "@opencraft/composer-core";

export type AttachmentResolver = (
  file: File,
  pending: ComposerAttachment,
  signal?: AbortSignal,
) => ComposerAttachment | Promise<ComposerAttachment>;

interface AttachmentJob {
  readonly draftId: string;
  readonly attachmentId: string;
  readonly file: File;
  readonly previewUrl: string | null;
  controller: AbortController | null;
}

const sessions = new WeakMap<ComposerController, AttachmentPreviewSession>();

function jobKey(draftId: string, attachmentId: string): string {
  return JSON.stringify([draftId, attachmentId]);
}

/** Browser-only File and object-URL owner for one Composer Controller/View. */
export class AttachmentPreviewSession {
  private readonly jobs = new Map<string, AttachmentJob>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeController: () => void;
  private version = 0;
  private disposed = false;

  constructor(private readonly composer: ComposerController) {
    this.unsubscribeController = composer.subscribe(() => this.prune());
    composer.onDispose(() => this.dispose());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  previewUrl(draftId: string, attachmentId: string): string | null {
    return this.jobs.get(jobKey(draftId, attachmentId))?.previewUrl ?? null;
  }

  canRetry(draftId: string, attachmentId: string): boolean {
    return this.jobs.has(jobKey(draftId, attachmentId));
  }

  addFiles(files: readonly File[], resolve: AttachmentResolver | undefined): void {
    if (this.disposed) return;
    const draftId = this.composer.getSnapshot().draft.id;
    for (const file of files) {
      const attachmentId = createClientId();
      const mimeType = (file.type === "" || file.type === "application/octet-stream") && /\.heic$/iu.test(file.name)
        ? "image/heic"
        : (file.type === "" || file.type === "application/octet-stream") && /\.heif$/iu.test(file.name)
          ? "image/heif"
          : file.type || "application/octet-stream";
      const image = mimeType.startsWith("image/");
      let previewUrl: string | null = null;
      if (image && typeof URL.createObjectURL === "function") {
        try { previewUrl = URL.createObjectURL(file); }
        catch { /* The attachment can still resolve without an immediate preview. */ }
      }
      const entry: AttachmentJob = { draftId, attachmentId, file, previewUrl, controller: null };
      this.jobs.set(jobKey(draftId, attachmentId), entry);
      const pending: ComposerAttachment = {
        id: attachmentId,
        name: file.name,
        mimeType,
        size: file.size,
        uri: null,
        lifecycle: resolve === undefined ? "failed" : "pending",
        error: resolve === undefined ? "No browser-to-AppServer attachment bridge is configured" : null,
      };
      try {
        this.composer.dispatch({ type: "add-attachment", attachment: pending });
      } catch (error) {
        // Content admission can refuse a new draft before it owns this File.
        // Do not leak its preview or start a job that has no semantic owner.
        this.remove(draftId, attachmentId);
        throw error;
      }
      this.notify();
      if (resolve !== undefined) this.start(entry, resolve);
    }
  }

  retry(draftId: string, attachmentId: string, resolve: AttachmentResolver | undefined): boolean {
    const entry = this.jobs.get(jobKey(draftId, attachmentId));
    if (entry === undefined || resolve === undefined || this.disposed) return false;
    entry.controller?.abort();
    this.start(entry, resolve);
    return true;
  }

  remove(draftId: string, attachmentId: string): void {
    const key = jobKey(draftId, attachmentId);
    const entry = this.jobs.get(key);
    if (entry === undefined) return;
    this.jobs.delete(key);
    entry.controller?.abort();
    if (entry.previewUrl !== null) URL.revokeObjectURL(entry.previewUrl);
    this.notify();
  }

  private start(entry: AttachmentJob, resolve: AttachmentResolver): void {
    const pending = this.composer.getDraftAttachment(entry.draftId, entry.attachmentId);
    if (pending === null) return;
    const job = new AbortController();
    entry.controller = job;
    this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
      lifecycle: pending.mimeType.startsWith("image/") ? "processing" : "uploading",
      error: null,
    });
    void Promise.resolve().then(() => resolve(entry.file, pending, job.signal)).then(
      resolved => {
        if (job.signal.aborted || entry.controller !== job) return;
        const { id: _id, ...patch } = resolved;
        this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, patch);
      },
      error => {
        if (job.signal.aborted || entry.controller !== job) return;
        this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
          lifecycle: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ).catch(() => {
      // A disposed Controller rejects late writes; its resources are already released.
    }).finally(() => {
      if (entry.controller === job) entry.controller = null;
    });
  }

  private prune(): void {
    for (const entry of this.jobs.values()) {
      if (this.composer.getDraftAttachment(entry.draftId, entry.attachmentId) === null) {
        this.remove(entry.draftId, entry.attachmentId);
      }
    }
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeController();
    for (const entry of [...this.jobs.values()]) this.remove(entry.draftId, entry.attachmentId);
    this.listeners.clear();
  }
}

export function attachmentPreviewSession(composer: ComposerController): AttachmentPreviewSession {
  let session = sessions.get(composer);
  if (session === undefined) {
    session = new AttachmentPreviewSession(composer);
    sessions.set(composer, session);
  }
  return session;
}

import { createClientId, type ComposerAttachment, type ComposerController } from "@opencraft/composer-core";

export interface AttachmentProgress { readonly loaded: number; readonly total: number; readonly source?: "sent" | "confirmed"; }

export type AttachmentResolver = (
  file: File,
  pending: ComposerAttachment,
  signal?: AbortSignal,
  onProgress?: (progress: AttachmentProgress | null) => void,
) => ComposerAttachment | Promise<ComposerAttachment>;

/** One result destination captured when a history image starts editing. */
export interface ComposerImageEditSession {
  complete(file: File): boolean;
  focus(): void;
}

interface AttachmentJob {
  readonly draftId: string;
  readonly attachmentId: string;
  readonly file: File;
  previewUrl: string | null;
  controller: AbortController | null;
  progress: AttachmentProgress | null;
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

  progress(draftId: string, attachmentId: string): AttachmentProgress | null {
    return this.jobs.get(jobKey(draftId, attachmentId))?.progress ?? null;
  }

  canRetry(draftId: string, attachmentId: string): boolean {
    return this.jobs.has(jobKey(draftId, attachmentId));
  }

  /** Replace only the initiating active draft's image. Old upload results lose ownership. */
  replaceImage(draftId: string, attachmentId: string, expectedSource: string, file: File, resolve: AttachmentResolver | undefined): boolean {
    if (this.disposed || this.composer.getSnapshot().draft.id !== draftId) return false;
    const current = this.composer.getDraftAttachment(draftId, attachmentId);
    if (!current || !current.mimeType.startsWith("image/") || !file.type.startsWith("image/")) return false;
    if ((this.previewUrl(draftId, attachmentId) ?? current.uri) !== expectedSource) return false;
    const key = jobKey(draftId, attachmentId), previous = this.jobs.get(key);
    const previewUrl = URL.createObjectURL(file);
    const entry: AttachmentJob = { draftId, attachmentId, file, previewUrl, controller: null, progress: null };
    this.jobs.set(key, entry);
    try {
      if (!this.composer.updateDraftAttachment(draftId, attachmentId, {
        name: file.name, mimeType: file.type, size: file.size, uri: null, metadata: {},
        lifecycle: resolve === undefined ? "failed" : "processing",
        error: resolve === undefined ? "No browser-to-AppServer attachment bridge is configured" : null,
      })) throw new Error("Image attachment no longer exists");
    } catch (error) {
      if (previous) this.jobs.set(key, previous); else this.jobs.delete(key);
      URL.revokeObjectURL(previewUrl);
      throw error;
    }
    previous?.controller?.abort();
    if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
    this.notify();
    if (resolve) this.start(entry, resolve);
    return true;
  }

  addImageToDraft(draftId: string, file: File, resolve: AttachmentResolver | undefined): boolean {
    if (this.disposed || !resolve || !file.type.startsWith("image/")
      || this.composer.getSnapshot().draft.id !== draftId) return false;
    this.addFiles([file], resolve);
    return true;
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
      const entry: AttachmentJob = { draftId, attachmentId, file, previewUrl, controller: null, progress: null };
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
    entry.progress = null;
    this.notify();
    this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
      lifecycle: pending.mimeType.startsWith("image/") ? "processing" : "uploading",
      error: null,
    });
    void Promise.resolve().then(() => resolve(entry.file, pending, job.signal, progress => {
      if (this.disposed || job.signal.aborted || entry.controller !== job
        || this.jobs.get(jobKey(entry.draftId, entry.attachmentId)) !== entry) return;
      if (progress !== null && (!Number.isFinite(progress.loaded) || !Number.isFinite(progress.total)
        || progress.total <= 0 || progress.loaded < 0 || progress.loaded > progress.total)) return;
      entry.progress = progress === null ? null : { loaded: progress.loaded, total: progress.total, ...(progress.source ? { source: progress.source } : {}) };
      this.notify();
    })).then(
      resolved => {
        if (job.signal.aborted || entry.controller !== job) return;
        // A resolver may identify an image whose browser File had no image MIME.
        // This session still owns its preview and releases it with the same job.
        if (entry.previewUrl === null && resolved.lifecycle === 'ready' && resolved.mimeType.startsWith('image/')) {
          try { entry.previewUrl = URL.createObjectURL(new Blob([entry.file], { type: resolved.mimeType })); }
          catch { /* The resolved attachment remains usable without an immediate preview. */ }
        }
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
      if (entry.controller === job) { entry.controller = null; entry.progress = null; this.notify(); }
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

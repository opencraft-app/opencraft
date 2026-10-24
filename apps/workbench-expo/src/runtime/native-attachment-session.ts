import { createClientId, type ComposerAttachment, type ComposerController } from "@opencraft/composer-core";

import type { NativeAttachmentSource } from "./native-attachment-resolver";

export type NativeAttachmentResolver = (
  source: NativeAttachmentSource,
  pending: ComposerAttachment,
  signal?: AbortSignal,
) => Promise<ComposerAttachment>;
export type NativeAttachmentRelease = (attachment: ComposerAttachment) => Promise<void>;

interface AttachmentEntry {
  readonly draftId: string;
  readonly attachmentId: string;
  readonly source: NativeAttachmentSource;
  readonly resolve: NativeAttachmentResolver;
  readonly release: NativeAttachmentRelease;
  readonly onFailure: () => void;
  controller: AbortController | null;
  lastAttachment: ComposerAttachment | null;
  submitting: boolean;
}

const sessions = new WeakMap<ComposerController, NativeAttachmentSession>();
const entryKey = (draftId: string, attachmentId: string) => JSON.stringify([draftId, attachmentId]);

/** Local picker URIs and in-flight work belong to the Composer View, not its mounted input. */
export class NativeAttachmentSession {
  private readonly entries = new Map<string, AttachmentEntry>();
  private readonly disposedSubmissions = new Map<string, { attachment: ComposerAttachment; release: NativeAttachmentRelease }[]>();
  private readonly queuedJobs: Array<{ entry: AttachmentEntry; controller: AbortController }> = [];
  private runningJob = false;
  private readonly unsubscribeController: () => void;
  private disposed = false;

  constructor(private readonly composer: ComposerController) {
    this.unsubscribeController = composer.subscribe(() => this.prune());
    composer.onDispose(() => this.dispose());
  }

  add(
    source: NativeAttachmentSource,
    resolve: NativeAttachmentResolver,
    release: NativeAttachmentRelease,
    onFailure: () => void,
  ): void {
    if (this.disposed || this.composer.getSnapshot().draft.lifecycle.phase === "submitting") return;
    const draftId = this.composer.getSnapshot().draft.id;
    const attachmentId = createClientId();
    const pending: ComposerAttachment = {
      id: attachmentId,
      name: source.name,
      mimeType: source.mimeType,
      size: source.size ?? 0,
      uri: null,
      lifecycle: "pending",
      error: null,
    };
    const entry: AttachmentEntry = {
      draftId, attachmentId, source, resolve, release, onFailure, controller: null,
      lastAttachment: pending, submitting: false,
    };
    this.entries.set(entryKey(draftId, attachmentId), entry);
    this.composer.dispatch({ type: "add-attachment", attachment: pending });
    this.start(entry);
  }

  canRetry(draftId: string, attachmentId: string): boolean {
    return !this.disposed && this.entries.has(entryKey(draftId, attachmentId));
  }

  previewUri(draftId: string, attachmentId: string): string | null {
    if (this.disposed || this.composer.getDraftAttachment(draftId, attachmentId) === null) return null;
    const source = this.entries.get(entryKey(draftId, attachmentId))?.source;
    return source?.mimeType.startsWith("image/") ? source.uri : null;
  }

  retry(draftId: string, attachmentId: string): boolean {
    const entry = this.entries.get(entryKey(draftId, attachmentId));
    const attachment = this.composer.getDraftAttachment(draftId, attachmentId);
    if (this.disposed || entry === undefined || attachment?.lifecycle !== "failed") return false;
    this.start(entry);
    return true;
  }

  remove(draftId: string, attachmentId: string, releaseRestored?: NativeAttachmentRelease): void {
    if (this.disposed || this.composer.getSnapshot().draft.id !== draftId
      || this.composer.getSnapshot().draft.lifecycle.phase === "submitting") return;
    const attachment = this.composer.getDraftAttachment(draftId, attachmentId);
    if (attachment === null) return;
    const entry = this.entries.get(entryKey(draftId, attachmentId));
    this.drop(entry);
    this.composer.dispatch({ type: "remove-attachment", id: attachmentId });
    const release = entry?.release ?? releaseRestored;
    if (release !== undefined && attachment.lifecycle === "ready") {
      void release(attachment).catch(() => undefined);
    }
  }

  /** A disposed View cannot keep a Draft, but its in-flight send still owns staged files. */
  settleSubmission(draftId: string, outcome: "accepted" | "rejected" | "failed"): void {
    if (!this.disposed) return;
    const files = this.disposedSubmissions.get(draftId);
    this.disposedSubmissions.delete(draftId);
    if (outcome !== "accepted") {
      for (const { attachment, release } of files ?? []) void release(attachment).catch(() => undefined);
    }
  }

  private start(entry: AttachmentEntry): void {
    const pending = this.composer.getDraftAttachment(entry.draftId, entry.attachmentId);
    if (pending === null) return;
    entry.controller?.abort();
    const job = new AbortController();
    entry.controller = job;
    this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
      lifecycle: "pending", error: null,
    });
    this.queuedJobs.push({ entry, controller: job });
    this.drainJobs();
  }

  /** File.base64() can hold a large payload; admit only one picker job at a time. */
  private drainJobs(): void {
    if (this.runningJob || this.disposed) return;
    let queued: { entry: AttachmentEntry; controller: AbortController } | undefined;
    let pending: ComposerAttachment | null = null;
    while ((queued = this.queuedJobs.shift()) !== undefined) {
      if (queued.controller.signal.aborted || queued.entry.controller !== queued.controller) continue;
      pending = this.composer.getDraftAttachment(queued.entry.draftId, queued.entry.attachmentId);
      if (pending !== null) break;
      queued.entry.controller = null;
    }
    if (queued === undefined || pending === null) return;
    const { entry, controller: job } = queued;
    this.runningJob = true;
    this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
      lifecycle: pending.mimeType.startsWith("image/") ? "processing" : "uploading",
      error: null,
    });
    void Promise.resolve().then(() => job.signal.aborted
      ? null : entry.resolve(entry.source, pending, job.signal)).then(
      resolved => {
        if (resolved === null) return;
        if (job.signal.aborted || entry.controller !== job) {
          void entry.release(resolved).catch(() => undefined);
          return;
        }
        const { id: _id, ...patch } = resolved;
        if (!this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, patch)) {
          void entry.release(resolved).catch(() => undefined);
        } else {
          // Cached Draft updates do not publish a controller snapshot. Keep
          // the completed Host ref so a later reset can release it.
          entry.lastAttachment = resolved;
        }
      },
      () => {
        if (job.signal.aborted || entry.controller !== job) return;
        this.composer.updateDraftAttachment(entry.draftId, entry.attachmentId, {
          lifecycle: "failed", error: "Attachment failed",
        });
        try { entry.onFailure(); } catch { /* Logging must not affect the Draft state. */ }
      },
    ).catch(() => undefined).finally(() => {
      if (entry.controller === job) entry.controller = null;
      this.runningJob = false;
      this.drainJobs();
    });
  }

  private drop(entry: AttachmentEntry | undefined): void {
    if (entry === undefined) return;
    this.entries.delete(entryKey(entry.draftId, entry.attachmentId));
    entry.controller?.abort();
    entry.controller = null;
    for (let index = this.queuedJobs.length - 1; index >= 0; index -= 1) {
      if (this.queuedJobs[index]?.entry === entry) this.queuedJobs.splice(index, 1);
    }
  }

  private prune(): void {
    for (const entry of this.entries.values()) {
      const attachment = this.composer.getDraftAttachment(entry.draftId, entry.attachmentId);
      if (attachment !== null) {
        entry.lastAttachment = attachment;
        entry.submitting = this.composer.getDraftPhase(entry.draftId) === "submitting";
        continue;
      }
      // Successful submission clears the Draft but the transcript still owns
      // its Host file. A discarded editing Draft has no such owner.
      const discarded = !entry.submitting ? entry.lastAttachment : null;
      this.drop(entry);
      if (discarded?.lifecycle === "ready") void entry.release(discarded).catch(() => undefined);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeController();
    for (const entry of this.entries.values()) {
      const attachment = this.composer.getDraftAttachment(entry.draftId, entry.attachmentId);
      const submitting = this.composer.getDraftPhase(entry.draftId) === "submitting";
      this.drop(entry);
      if (attachment?.lifecycle !== "ready") continue;
      if (submitting) {
        const files = this.disposedSubmissions.get(entry.draftId) ?? [];
        files.push({ attachment, release: entry.release });
        this.disposedSubmissions.set(entry.draftId, files);
      } else {
        void entry.release(attachment).catch(() => undefined);
      }
    }
    sessions.delete(this.composer);
  }
}

export function nativeAttachmentSession(composer: ComposerController): NativeAttachmentSession {
  let session = sessions.get(composer);
  if (session === undefined) {
    session = new NativeAttachmentSession(composer);
    sessions.set(composer, session);
  }
  return session;
}

import { WorkspaceArtifactCleanupUnconfirmed } from "./artifact-errors.js";
import { randomBytes, createHash } from "node:crypto";
import {
  dueOwnerWork,
  periodicOwnerWork,
  timeoutOwnerWake,
  type DueOwnerWork,
  type OwnerWake,
  type PeriodicOwnerWork,
} from "@opencraft/owner-wake";
import type { Readable } from "node:stream";
import type { Artifact } from "@opencraft/local-agent-host/artifacts";
import type { WorkspaceActorAdmission } from "./actor-authority.js";

export type WorkspaceArtifactMetadata = Omit<Artifact, "path">;
export type WorkspaceArtifactChunk =
  | { state: "pending" }
  | { state: "failed" }
  | { state: "done" }
  | { state: "chunk"; sequence: number; data: Uint8Array };
export type WorkspaceArtifactUploadStatus =
  { state: "pending" } | { state: "failed" } | { state: "complete"; artifact: Artifact };
export interface WorkspaceArtifactPort {
  workspaceArtifactDownload(access: WorkspaceActorAdmission, threadId: string, path: string): Promise<string>;
  workspaceArtifactRead(token: string, sequence: number): Promise<WorkspaceArtifactChunk>;
  workspaceArtifactUpload(
    access: WorkspaceActorAdmission,
    threadId: string,
    artifact: WorkspaceArtifactMetadata,
  ): Promise<string>;
  workspaceArtifactWrite(token: string, sequence: number, data: Uint8Array): Promise<boolean>;
  workspaceArtifactFinish(token: string): Promise<WorkspaceArtifactUploadStatus>;
  workspaceArtifactClose(token: string): Promise<"pending" | "closed" | "failed">;
}
const invalid = () => Error("Workspace artifact unavailable");
/** A transfer untouched this long is closed. */
export const ARTIFACT_TRANSFER_IDLE_MS = 30_000;
/** Authority has no change notification; open transfers are re-checked this often. */
export const ARTIFACT_TRANSFER_CHECK_MS = 50;
const tokenShape = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
interface Base {
  access: WorkspaceActorAdmission;
  controller: AbortController;
  touched: number;
  closed: boolean;
  failed: boolean;
  cleanupFailed: boolean;
  pending: Set<Promise<unknown>>;
  closing?: Promise<void>;
}
interface Download extends Base {
  kind: "download";
  sequence: number;
  bytes: number;
  reading: boolean;
  chunk?: WorkspaceArtifactChunk;
  source?: { body: Readable; dispose(): Promise<void> };
  reader?: AsyncIterator<unknown>;
}
interface Upload extends Base {
  kind: "upload";
  sequence: number;
  bytes: number;
  size: number;
  lastHash?: string;
  finished: boolean;
  waiting?: { resolve(value: IteratorResult<Uint8Array>): void; reject(error: Error): void };
  status: WorkspaceArtifactUploadStatus;
}
type Entry = Download | Upload;
/** Worker-only credit transport. No long provider/stream promise occupies the
 * FIFO RPC lane; polling inspects bounded state while original owners do IO.
 * A repeated credit is an idempotent byte acknowledgement, not provider replay. */
export class WorkspaceArtifactTransfers {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly wake: OwnerWake;
  /** Idle transfers close when the least recently touched one expires; nothing wakes while none is open. */
  private readonly idle: DueOwnerWork;
  /** Armed only while a transfer is open (its phase starts with the first one). */
  private check: PeriodicOwnerWork | null = null;
  constructor(
    private readonly options: {
      current(access: WorkspaceActorAdmission): boolean;
      download(
        access: WorkspaceActorAdmission,
        threadId: string,
        path: string,
        signal: AbortSignal,
      ): Promise<{ body: Readable; dispose(): Promise<void> }>;
      upload(
        access: WorkspaceActorAdmission,
        threadId: string,
        artifact: Artifact,
        body: AsyncIterable<Uint8Array>,
        signal: AbortSignal,
      ): Promise<Artifact>;
      /** Owner wake-up for the authority check and idle expiry; the default Node timeout one. */
      wake?: OwnerWake;
    },
  ) {
    this.wake = options.wake ?? timeoutOwnerWake();
    this.idle = dueOwnerWork(
      this.wake,
      () => {
        let oldest: number | null = null;
        for (const entry of this.entries.values())
          if (!entry.closing && (oldest === null || entry.touched < oldest)) oldest = entry.touched;
        return oldest === null ? null : oldest + ARTIFACT_TRANSFER_IDLE_MS;
      },
      (now) => {
        for (const [token, entry] of this.entries)
          if (!entry.closing && now - entry.touched >= ARTIFACT_TRANSFER_IDLE_MS) void this.close(token).catch(() => {});
      },
    );
  }
  /** Re-arms the authority check and idle expiry after a transfer opens or closes. Touching a transfer only moves its
   * expiry later, so it needs no re-arm: an early wake-up finds nothing due and re-arms for the new time. */
  private changed() {
    const open = !this.closed && [...this.entries.values()].some((entry) => !entry.closing);
    if (open)
      this.check ??= periodicOwnerWork(this.wake, ARTIFACT_TRANSFER_CHECK_MS, () => {
        for (const [token, entry] of this.entries)
          if (!entry.closing && !this.options.current(entry.access)) void this.close(token).catch(() => {});
        this.changed();
      });
    else {
      this.check?.close();
      this.check = null;
    }
    this.idle.reschedule();
  }
  private base(access: WorkspaceActorAdmission): Base {
    if (this.closed || this.entries.size >= 16 || !this.options.current(access)) throw invalid();
    const value: Base = {
      access,
      controller: new AbortController(),
      touched: this.wake.now(),
      closed: false,
      failed: false,
      cleanupFailed: false,
      pending: new Set(),
    };
    return value;
  }
  private install(entry: Entry): string {
    const token = randomBytes(32).toString("hex");
    this.entries.set(token, entry);
    this.changed();
    return token;
  }
  private track(entry: Entry, work: Promise<unknown>) {
    entry.pending.add(work);
    void work.then(
      () => entry.pending.delete(work),
      (cause: unknown) => {
        entry.failed = true;
        entry.cleanupFailed ||= cause instanceof WorkspaceArtifactCleanupUnconfirmed;
        entry.pending.delete(work);
      },
    );
  }
  private get(token: string): Entry {
    if (this.closed || !tokenShape(token)) throw invalid();
    const value = this.entries.get(token);
    if (!value || value.closed || !this.options.current(value.access)) throw invalid();
    value.touched = this.wake.now();
    return value;
  }
  download(access: WorkspaceActorAdmission, threadId: string, path: string): string {
    const entry: Download = { ...this.base(access), kind: "download", sequence: 0, bytes: 0, reading: false };
    const token = this.install(entry);
    this.track(
      entry,
      (async () => {
        const source = await this.options.download(access, threadId, path, entry.controller.signal);
        entry.source = source;
        if (entry.closed || !this.options.current(access)) {
          await source.dispose();
          throw invalid();
        }
        entry.reader = source.body[Symbol.asyncIterator]();
      })(),
    );
    return token;
  }
  read(token: string, sequence: number): WorkspaceArtifactChunk {
    const entry = this.get(token);
    if (entry.kind !== "download" || !Number.isSafeInteger(sequence) || sequence < 0) throw invalid();
    if (entry.failed) return { state: "failed" };
    if (sequence !== entry.sequence) {
      if (sequence !== entry.sequence + 1 || entry.chunk?.state !== "chunk") throw invalid();
      entry.sequence = sequence;
      entry.chunk = undefined;
    }
    if (entry.chunk) return entry.chunk;
    if (entry.reader && !entry.reading) {
      entry.reading = true;
      this.track(
        entry,
        (async () => {
          try {
            const next = await entry.reader!.next();
            if (entry.closed || !this.options.current(entry.access)) throw invalid();
            if (next.done) {
              await entry.source!.dispose();
              entry.chunk = { state: "done" };
              return;
            }
            const bytes: unknown = next.value;
            if (
              !(bytes instanceof Uint8Array) ||
              !bytes.byteLength ||
              bytes.byteLength > 65536 ||
              entry.bytes + bytes.byteLength > 1024 ** 3
            )
              throw invalid();
            entry.bytes += bytes.byteLength;
            entry.chunk = { state: "chunk", sequence: entry.sequence, data: Uint8Array.from(bytes) };
          } finally {
            entry.reading = false;
          }
        })(),
      );
    }
    return { state: "pending" };
  }
  upload(access: WorkspaceActorAdmission, threadId: string, metadata: WorkspaceArtifactMetadata): string {
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Object.keys(metadata).some((k) => !["id", "name", "mimeType", "size", "sha256", "origin"].includes(k)) ||
      typeof metadata.id !== "string" ||
      !metadata.id ||
      metadata.id.length > 512 ||
      typeof metadata.name !== "string" ||
      !metadata.name ||
      metadata.name.length > 512 ||
      /[\x00-\x1f\x7f]/u.test(metadata.name) ||
      typeof metadata.mimeType !== "string" ||
      metadata.mimeType.length > 256 ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > 1024 ** 3 ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(metadata.sha256) ||
      !["upload", "generation", "transform", "execution-copy"].includes(metadata.origin)
    )
      throw invalid();
    const entry: Upload = {
      ...this.base(access),
      kind: "upload",
      sequence: 0,
      bytes: 0,
      size: metadata.size,
      finished: false,
      status: { state: "pending" },
    };
    const token = this.install(entry);
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (entry.closed || entry.failed || !this.options.current(access)) return Promise.reject(invalid());
          if (entry.finished) return Promise.resolve({ done: true, value: undefined });
          if (entry.waiting) return Promise.reject(invalid());
          return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            entry.waiting = { resolve, reject };
          });
        },
      }),
    };
    this.track(
      entry,
      (async () => {
        const artifact = await this.options.upload(
          access,
          threadId,
          { ...structuredClone(metadata), path: "" },
          body,
          entry.controller.signal,
        );
        if (entry.closed || !this.options.current(access)) throw invalid();
        if (!entry.finished || entry.bytes !== entry.size) throw invalid();
        entry.status = { state: "complete", artifact };
      })(),
    );
    return token;
  }
  write(token: string, sequence: number, data: Uint8Array): boolean {
    const entry = this.get(token);
    if (
      entry.kind !== "upload" ||
      entry.failed ||
      entry.finished ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !(data instanceof Uint8Array) ||
      !data.byteLength ||
      data.byteLength > 65536
    )
      throw invalid();
    const hash = createHash("sha256").update(data).digest("hex");
    if (sequence === entry.sequence - 1) {
      if (hash !== entry.lastHash) throw invalid();
      return true;
    }
    if (sequence !== entry.sequence || entry.bytes + data.byteLength > entry.size) throw invalid();
    if (!entry.waiting) return false;
    const waiting = entry.waiting;
    entry.waiting = undefined;
    entry.bytes += data.byteLength;
    entry.sequence++;
    entry.lastHash = hash;
    waiting.resolve({ done: false, value: Uint8Array.from(data) });
    return true;
  }
  finish(token: string): WorkspaceArtifactUploadStatus {
    const entry = this.get(token);
    if (entry.kind !== "upload") throw invalid();
    if (entry.failed) return { state: "failed" };
    if (entry.bytes !== entry.size) throw invalid();
    entry.finished = true;
    const waiting = entry.waiting;
    entry.waiting = undefined;
    waiting?.resolve({ done: true, value: undefined });
    return entry.status;
  }
  requestClose(token: string): "pending" | "closed" | "failed" {
    if (!tokenShape(token)) throw invalid();
    const entry = this.entries.get(token);
    if (!entry) return "closed";
    if (entry.cleanupFailed) return "failed";
    void this.close(token).catch(() => {
      entry.cleanupFailed = true;
    });
    return "pending";
  }
  close(token: string): Promise<void> {
    if (!tokenShape(token)) return Promise.reject(invalid());
    const entry = this.entries.get(token);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      entry.closed = true;
      entry.controller.abort();
      if (entry.kind === "upload") {
        entry.waiting?.reject(invalid());
        entry.waiting = undefined;
      }
      await Promise.allSettled([...entry.pending]);
      if (entry.kind === "download") await entry.source?.dispose();
      if (entry.cleanupFailed) throw new WorkspaceArtifactCleanupUnconfirmed();
      this.entries.delete(token);
    })();
    this.changed();
    return entry.closing;
  }
  async closeAll() {
    this.closed = true;
    this.idle.close();
    this.changed();
    const results = await Promise.allSettled([...this.entries.keys()].map((token) => this.close(token)));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Workspace artifact cleanup unconfirmed");
  }
}

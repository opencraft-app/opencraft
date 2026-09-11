export interface BlobResource {
  /** Authenticated authority namespace, not just a hostname. */
  scope: string;
  path: string;
  version?: string;
}
export interface BlobProgress {
  phase: "queued" | "cache" | "loading" | "ready" | "failed";
  receivedBytes?: number;
  totalBytes?: number;
}
export interface BlobCacheEntry {
  key: string;
  blob: Blob;
  expiresAt: number;
  accessedAt: number;
}
export interface BlobCacheStorage {
  get(key: string): Promise<BlobCacheEntry | undefined>;
  put(entry: BlobCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  close(): void;
}
export type BlobResourceLoader = (resource: BlobResource, signal: AbortSignal,
  progress: (receivedBytes: number, totalBytes?: number) => void) => Promise<Blob>;
export interface BlobLease {
  readonly promise: Promise<Blob>;
  getProgress(): BlobProgress;
  subscribe(listener: () => void): () => void;
  /** Idempotent; the last waiting consumer cancels a shared request. */
  release(): void;
}
export interface BlobAcquireOptions {
  priority?: number;
  signal?: AbortSignal;
  /** Mutable/unknown versions must expire. Default 10s. */
  maxAgeMs?: number;
  /** Explicit opt-in after establishing a stable authenticated scope. */
  persistent?: boolean;
}
export const blobResourceKey = (resource: BlobResource): string => {
  if (!resource.scope || !resource.path) throw new Error("Blob scope and path are required");
  return JSON.stringify([resource.scope, resource.path, resource.version ?? null]);
};

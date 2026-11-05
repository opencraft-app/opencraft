import type { BlobResourceService, ResourceStore } from "@opencraft/blob-resources";
import { fileBlobResource, fileBlobUrls, fileDownloadSource, loadFileBlob } from "./blob-files";
import type { ChatMediaSourceLoader, ChatMediaSourceResult, ChatMediaSourceSnapshot } from "@opencraft/chat-render-react";
import { chatMediaMimeType } from "@opencraft/chat-render-react";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

export function appServerMediaPath(target: string): string | null {
  if (!target.startsWith("file:")) return null;
  try {
    const url = new URL(target);
    if (url.protocol !== "file:") return null;
    const decoded = decodeURIComponent(url.pathname);
    return /^\/[a-z]:\//iu.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

export function mediaMimeType(path: string): string {
  return chatMediaMimeType(path);
}

interface PreparedMediaSource extends ChatMediaSourceResult { retain(): ChatMediaSourceResult; }

const unavailable: ChatMediaSourceSnapshot = Object.freeze({ status: "unavailable", value: null });

/** Prepare a replacement before withdrawing the currently displayed image. */
async function prepareReplacementImage(source: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (typeof Image === "undefined") return;
  const image = new Image(); image.src = source;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { image.src = ""; reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void image.decode().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Application-owned media results shared by every conversation and preview consumer. */
export function createAppServerMediaSourceLoader(
  runtime: AppServerWorkbenchRuntime,
  blobs: BlobResourceService,
  hostId: string,
): ChatMediaSourceLoader {
  // Snapshot reads and subscriptions must name the same authority. Reading a
  // mutable generation inside resourceFor silently moves reads off the active
  // subscription on reconnect, leaving the new resource permanently cold.
  const generation = runtime.resources.host.getConnectionGeneration?.() ?? 0;
  const shared: ResourceStore<PreparedMediaSource> = blobs.getResourceStore<PreparedMediaSource>(runtime, `media:${hostId}`, async (resource, signal) => {
    let readAttempts: number | undefined;
    const lease = blobs.acquire(resource, (_, signal) => loadFileBlob(runtime, hostId, resource.path, signal, attempt => { readAttempts = attempt; }),
      { signal, priority: 1, maxAgeMs: 10_000, persistent: true });
    try {
      const blob = await lease.promise;
      if (!blob.size) return null;
      const typed = blob.slice(0, blob.size, mediaMimeType(resource.path));
      const url = fileBlobUrls.acquire(typed);
      try {
        if (shared.getSnapshot(resource).value && typed.type.startsWith("image/")) {
          await prepareReplacementImage(url.source, signal);
        }
      } catch (error) { url.release(); throw error; }
      return { value: { source: url.source, contentType: blob.type, readAttempts,
        retain: () => ({ ...fileBlobUrls.acquire(typed), contentType: blob.type, readAttempts }) },
        sizeBytes: blob.size, expiresAt: lease.expiresAt, dispose: url.release };
    } finally { lease.release(); }
  });
  const resourceFor = (target: string) => {
    const path = appServerMediaPath(target);
    return path === null ? null : fileBlobResource(runtime, hostId, path, generation);
  };
  const loader: ChatMediaSourceLoader = ({ resolvedTarget, signal }) => {
    const resource = resourceFor(resolvedTarget);
    if (!resource) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      let unsubscribe = () => {};
      let settled = false;
      let releaseUrl: (() => void) | undefined;
      const release = () => { signal?.removeEventListener("abort", abort); unsubscribe(); releaseUrl?.(); };
      const abort = () => { release(); if (!settled) { settled = true; reject(signal?.reason); } };
      const update = () => {
        const snapshot = shared.getSnapshot(resource);
        if (settled || snapshot.status === "loading") return;
        settled = true;
        if (snapshot.status === "ready" && snapshot.value) {
          const retained = snapshot.value.retain(); releaseUrl = retained.release;
          resolve({ source: retained.source, contentType: retained.contentType, readAttempts: retained.readAttempts, release });
        } else { release(); resolve(null); }
      };
      unsubscribe = shared.subscribe(resource, update);
      signal?.addEventListener("abort", abort, { once: true });
      update();
    });
  };
  loader.getSnapshot = ({ resolvedTarget }) => {
    const resource = resourceFor(resolvedTarget);
    return resource ? shared.getSnapshot(resource) : unavailable;
  };
  loader.subscribe = ({ resolvedTarget }, listener) => {
    const resource = resourceFor(resolvedTarget);
    return resource ? shared.subscribe(resource, listener) : () => {};
  };
  loader.retry = async ({ resolvedTarget }) => {
    const resource = resourceFor(resolvedTarget);
    if (resource) await blobs.invalidate(resource);
  };
  loader.resolveFileSource = source => fileDownloadSource(source, hostId);
  return loader;
}

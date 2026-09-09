import type { BlobResourceService } from "@opencraft/blob-resources";
import { acquireFileBlob, fileBlobUrls } from "./blob-files";
import type { ChatMediaSourceLoader } from "@opencraft/chat-render-web";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

const mimeByExtension: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
});

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
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase() ?? "";
  return mimeByExtension[extension] ?? "application/octet-stream";
}

/**
 * React owns a consumer lease; the Cordis Blob service owns shared downloads
 * and cache policy. AppServer remains the only filesystem authority.
 */
export function createAppServerMediaSourceLoader(
  runtime: AppServerWorkbenchRuntime,
  blobs: BlobResourceService,
  hostId: string,
): ChatMediaSourceLoader {
  return async ({ resolvedTarget, signal }) => {
    const path = appServerMediaPath(resolvedTarget);
    if (path === null) return null;
    const lease = acquireFileBlob(blobs, runtime, hostId, path, { signal, priority: 1 });
    try {
      const blob = await lease.promise;
      if (blob.size === 0) return null;
      return fileBlobUrls.acquire(blob.slice(0, blob.size, mediaMimeType(path)));
    } finally { lease.release(); }
  };
}

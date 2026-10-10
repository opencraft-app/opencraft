import { chatMediaMimeType, type ChatMediaSourceLoader } from "@opencraft/chat-render-react";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { nativeChatResourceAction } from "./native-chat-resource";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const CACHE_AGE_MS = 10_000;
const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface CachedImage {
  readonly source: string;
  /** Conservative memory weight for the retained Base64 string. */
  readonly cacheBytes: number;
  readonly expiresAt: number;
}

interface PendingImage {
  readonly controller: AbortController;
  readonly promise: Promise<CachedImage | null>;
  consumers: number;
}

function imageByteLength(dataBase64: string): number | null {
  if (dataBase64.length === 0 || dataBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64)) return null;
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return dataBase64.length / 4 * 3 - padding;
}

/** Host bytes are the only source for Host-local images; never use a phone file:// URI. */
export function createNativeChatMediaSourceLoader(
  runtime: Pick<AppServerWorkbenchRuntime, "resources">,
  hostId: string,
): ChatMediaSourceLoader {
  const cache = new Map<string, CachedImage>();
  const pending = new Map<string, PendingImage>();
  let cachedBytes = 0;
  let connectionGeneration = runtime.resources.host.getConnectionGeneration?.() ?? 0;

  const clearForConnectionChange = () => {
    const nextGeneration = runtime.resources.host.getConnectionGeneration?.() ?? 0;
    if (nextGeneration === connectionGeneration) return;
    connectionGeneration = nextGeneration;
    cache.clear();
    cachedBytes = 0;
    for (const request of pending.values()) request.controller.abort();
    pending.clear();
  };
  const remember = (path: string, image: CachedImage) => {
    if (image.cacheBytes > MAX_CACHE_BYTES) return;
    const previous = cache.get(path);
    if (previous) cachedBytes -= previous.cacheBytes;
    cache.delete(path);
    cache.set(path, image);
    cachedBytes += image.cacheBytes;
    while (cachedBytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= cache.get(oldest)?.cacheBytes ?? 0;
      cache.delete(oldest);
    }
  };
  const join = (path: string, mimeType: string, signal?: AbortSignal): Promise<CachedImage | null> => {
    let request = pending.get(path);
    if (!request) {
      const controller = new AbortController();
      const created: PendingImage = {
        controller,
        consumers: 0,
        promise: runtime.resources.fileSystem.readFile(path, controller.signal).then(({ dataBase64 }) => {
          const bytes = imageByteLength(dataBase64);
          if (controller.signal.aborted || bytes === null || bytes > MAX_IMAGE_BYTES) return null;
          const source = `data:${mimeType};base64,${dataBase64}`;
          const image = { source, cacheBytes: source.length * 2, expiresAt: Date.now() + CACHE_AGE_MS };
          if ((runtime.resources.host.getConnectionGeneration?.() ?? 0) !== connectionGeneration) return null;
          if (pending.get(path) === created) remember(path, image);
          return image;
        }).finally(() => { if (pending.get(path) === created) pending.delete(path); }),
      };
      request = created;
      pending.set(path, request);
    }
    request.consumers++;
    const current = request;
    return new Promise<CachedImage | null>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (--current.consumers === 0 && pending.get(path) === current) {
          pending.delete(path);
          current.controller.abort();
        }
        return true;
      };
      const abort = () => { if (finish()) resolve(null); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void current.promise.then(image => { if (finish()) resolve(image); }, error => { if (finish()) reject(error); });
    });
  };

  return async ({ resolvedTarget, resourceKind, hostId: requestHostId, signal }) => {
    if (signal?.aborted || requestHostId !== hostId) return null;
    clearForConnectionChange();
    const action = nativeChatResourceAction(resolvedTarget, { allowed: true, kind: resourceKind, target: resolvedTarget });
    if (action.kind !== "file") return null;
    const mimeType = chatMediaMimeType(action.path);
    if (!supportedImageTypes.has(mimeType)) return null;
    const cached = cache.get(action.path);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(action.path);
      cache.set(action.path, cached);
      return { source: cached.source };
    }
    if (cached) { cachedBytes -= cached.cacheBytes; cache.delete(action.path); }
    const image = await join(action.path, mimeType, signal);
    return image && !signal?.aborted ? { source: image.source } : null;
  };
}

import type { BlobResourceService, BlobResource, BlobAcquireOptions } from "@opencraft/blob-resources";
import { BlobUrlManager } from "@opencraft/blob-resources/browser";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { serverFetch, serverUrl } from "./server-context";
import { parseWebDeploymentConfig } from "./web-deployment-config";

/** Retain transport facts without carrying a request URL or response body. */
export class FileBlobReadError extends Error {
  constructor(readonly httpStatus: number, readonly redirected: boolean, readonly attempts = 1) {
    super("File download failed. Try again.");
  }
}

export class FileBlobNetworkError extends TypeError {
  constructor(readonly phase: "fetch" | "body", readonly attempts: number) { super("File transfer interrupted. Try again."); }
}

/** Never reinterpret another origin, server scope, or remote Host as this file authority. */
export function fileDownloadSource(source: string, hostId: string): string | null {
  if (typeof window === "undefined" || !/^(?:https?:|\/)/iu.test(source)) return null;
  try {
    const url = new URL(source, window.location.href);
    if (url.origin !== window.location.origin || url.username || url.password
      || url.pathname !== new URL(serverUrl("/__opencraft_files"), window.location.href).pathname
      || url.searchParams.getAll("hostId").length !== 1 || url.searchParams.getAll("path").length !== 1) return null;
    const owner = url.searchParams.get("hostId")!, path = url.searchParams.get("path")!;
    if (owner !== hostId && !(["opencraft-server", "local-codex"].includes(owner) && ["opencraft-server", "local-codex"].includes(hostId))) return null;
    if (!path.startsWith("/") || path.length > 8192 || /[\0\r\n]/u.test(path) || !fileDownloadUrl(hostId, path)) return null;
    const target = new URL("file:///"); target.pathname = path.split("/").map(encodeURIComponent).join("/");
    return target.href;
  } catch { return null; }
}

/** A website capability, never inferred from the path or from an arbitrary remote Host. */
export function fileDownloadUrl(hostId: string, path: string): string | null {
  if (typeof document === "undefined" || typeof document.getElementById !== "function"
    || parseWebDeploymentConfig(document.getElementById("opencraft-deployment-config")?.textContent ?? null)?.fileDownloads !== true
    || !(hostId === "opencraft-server" || hostId === "local-codex" || hostId.startsWith("ssh:"))) return null;
  return serverUrl(`/__opencraft_files?${new URLSearchParams({ hostId, path })}`);
}

export async function fileDownloadSize(url: string, signal?: AbortSignal): Promise<number> {
  const response = await serverFetch(url, { method: "HEAD", signal });
  const raw = response.headers.get("content-length"), size = Number(raw);
  if (!response.ok || raw === null || !/^\d+$/u.test(raw) || !Number.isSafeInteger(size)) throw new Error("File information is unavailable. Try again.");
  return size;
}

export const fileBlobUrls = new BlobUrlManager();
const scopes = new WeakMap<AppServerWorkbenchRuntime, string>();
export function fileBlobResource(runtime: AppServerWorkbenchRuntime, hostId: string, path: string,
  generation = runtime.resources.host.getConnectionGeneration?.() ?? 0): BlobResource {
  let scope = scopes.get(runtime);
  if (!scope) { scope = crypto.randomUUID(); scopes.set(runtime, scope); }
  // AppServer currently exposes neither an account-scoped cache identity nor
  // reliable file revisions for every provider. Do not reuse files across
  // runtime identities/reconnections until that authority is available.
  return { scope: `${scope}:${hostId}:${generation}`, path };
}
export function acquireFileBlob(service: BlobResourceService, runtime: AppServerWorkbenchRuntime,
  hostId: string, path: string, options: BlobAcquireOptions = {}) {
  return service.acquire(fileBlobResource(runtime, hostId, path),
    (_, signal) => loadFileBlob(runtime, hostId, path, signal),
    { maxAgeMs: 10_000, persistent: true, ...options });
}
function retryDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readHttpBlob(download: string, signal: AbortSignal, attempt: number): Promise<Blob> {
  let response: Response;
  try { response = await serverFetch(download, { signal }); }
  catch (error) { if (error instanceof TypeError) throw new FileBlobNetworkError("fetch", attempt); throw error; }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FileBlobReadError(response.status, response.redirected, attempt);
  }
  try { return await response.blob(); }
  catch (error) { if (error instanceof TypeError) throw new FileBlobNetworkError("body", attempt); throw error; }
}

export async function loadFileBlob(runtime: AppServerWorkbenchRuntime, hostId: string, path: string, signal: AbortSignal,
  onReadAttempt?: (attempt: number) => void): Promise<Blob> {
  const download = fileDownloadUrl(hostId, path);
  if (download) {
    const delays = [250, 500, 1000, 2000];
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try { onReadAttempt?.(attempt); } catch { /* Metadata must not affect file reads. */ }
      try { return await readHttpBlob(download, signal, attempt); }
      catch (error) {
        signal.throwIfAborted();
        const transient = error instanceof FileBlobNetworkError || error instanceof FileBlobReadError && [408, 500, 502, 503, 504].includes(error.httpStatus);
        if (!transient || attempt > delays.length) throw error;
        await retryDelay(delays[attempt - 1]!, signal);
      }
    }
  }
  const response = await runtime.resources.fileSystem.readFile(path, signal);
  signal.throwIfAborted();
  const raw = atob(response.dataBase64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return new Blob([bytes]);
}

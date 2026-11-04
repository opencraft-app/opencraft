import type { BlobResourceService, BlobResource, BlobAcquireOptions } from "@opencraft/blob-resources";
import { BlobUrlManager } from "@opencraft/blob-resources/browser";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { serverFetch, serverUrl } from "./server-context";
import { parseWebDeploymentConfig } from "./web-deployment-config";

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
export function fileBlobResource(runtime: AppServerWorkbenchRuntime, hostId: string, path: string): BlobResource {
  let scope = scopes.get(runtime);
  if (!scope) { scope = crypto.randomUUID(); scopes.set(runtime, scope); }
  // AppServer currently exposes neither an account-scoped cache identity nor
  // reliable file revisions for every provider. Do not reuse files across
  // runtime identities/reconnections until that authority is available.
  return { scope: `${scope}:${hostId}:${runtime.resources.host.getConnectionGeneration?.() ?? 0}`, path };
}
export function acquireFileBlob(service: BlobResourceService, runtime: AppServerWorkbenchRuntime,
  hostId: string, path: string, options: BlobAcquireOptions = {}) {
  return service.acquire(fileBlobResource(runtime, hostId, path), async (_resource, signal) => {
    const download = fileDownloadUrl(hostId, path);
    if (download) {
      const response = await serverFetch(download, { signal });
      if (!response.ok) throw new Error("File download failed. Try again.");
      return response.blob();
    }
    const response = await runtime.resources.fileSystem.readFile(path, signal);
    signal.throwIfAborted();
    const raw = atob(response.dataBase64);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return new Blob([bytes]);
  }, { maxAgeMs: 10_000, persistent: true, ...options });
}

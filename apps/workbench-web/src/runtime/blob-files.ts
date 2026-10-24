import type { BlobResourceService, BlobResource, BlobAcquireOptions } from "@opencraft/blob-resources";
import { BlobUrlManager } from "@opencraft/blob-resources/browser";
import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

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
    const response = await runtime.resources.fileSystem.readFile(path, signal);
    signal.throwIfAborted();
    const raw = atob(response.dataBase64);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return new Blob([bytes]);
  }, { maxAgeMs: 10_000, persistent: true, ...options });
}

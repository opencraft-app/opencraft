import type { AppServerClient } from "@opencraft/appserver-client";
import { HOST_STORAGE, parseHostStorageCapabilities } from "@opencraft/appserver-protocol/host-storage";
import { parseDocumentRecord, serializeDocumentValue, validateDataRevision, validateDataScope, validateDataVersion,
  type DocumentPersistence, type DocumentCommit } from "@opencraft/document-storage";

/** Borrows one initialized Host client. Does not reconnect, retarget or close that client. */
export async function openHostDocumentPersistence(client: AppServerClient, options: {
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
}): Promise<DocumentPersistence> {
  const generation = client.connectionGeneration;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let closed = false;
  const listeners = new Set<(scope: string) => void>();
  const notify = (scope: string) => { for (const listener of listeners) { try { listener(scope); } catch { /* Observer only. */ } } };
  const assertCurrent = () => {
    if (closed || controller.signal.aborted || options.signal?.aborted || !options.isCurrent() || !client.initializeResult || client.status.state !== "open" || client.connectionGeneration !== generation) {
      throw new Error("Host document connection unavailable or changed; reopen this Host storage");
    }
  };
  let capabilities;
  try {
    assertCurrent();
    capabilities = parseHostStorageCapabilities(await client.requestRaw(HOST_STORAGE.capabilities, {}, { signal: controller.signal, timeoutMs: 10000 }));
    assertCurrent();
  } catch (error) { options.signal?.removeEventListener("abort", abort); controller.abort(); throw error; }
  const removeNotification = client.subscribeNotification(event => {
    if (event.method !== HOST_STORAGE.changed) return;
    try {
      assertCurrent();
      const value = event.params as { scope?: unknown; revision?: unknown } | null;
      validateDataScope(value?.scope); validateDataRevision(value?.revision);
      notify(value!.scope as string);
    } catch { /* Ignore malformed or retired generation notifications. */ }
  });
  const removeStatus = client.subscribeStatus(status => {
    if (status.state !== "open") { controller.abort(); notify("*"); }
  });
  async function request(method: string, params: unknown): Promise<unknown> {
    assertCurrent();
    const value = await client.requestRaw(method, params, { signal: controller.signal, timeoutMs: 10000 });
    assertCurrent(); return value;
  }
  return {
    async read(scope) {
      validateDataScope(scope);
      const value = await request(HOST_STORAGE.read, { scope });
      if (value === undefined) throw new Error("Invalid Host document response");
      return parseDocumentRecord(value);
    },
    async compareAndSet(scope, revision, version, value) {
      validateDataScope(scope); validateDataRevision(revision); validateDataVersion(version);
      const json = serializeDocumentValue(value);
      if (new TextEncoder().encode(json).byteLength > capabilities.maxDocumentBytes) throw new RangeError("Host document size limit exceeded");
      const response = await request(HOST_STORAGE.compareAndSet, { scope, revision, version, value }) as Partial<DocumentCommit> | null;
      if (!response || typeof response.updated !== "boolean" || response.record === undefined) throw new Error("Invalid Host document response");
      const record = parseDocumentRecord(response.record);
      if (response.updated && (!record || record.revision !== revision + 1 || record.version !== version)) throw new Error("Invalid Host document commit acknowledgement");
      return { updated: response.updated, record };
    },
    subscribe(listener) { assertCurrent(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { if (closed) return; closed = true; controller.abort(); removeNotification(); removeStatus(); options.signal?.removeEventListener("abort", abort); listeners.clear(); },
  };
}

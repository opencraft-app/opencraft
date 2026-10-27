import type { ExtensionPersistence } from "./persistence";
import { documentSchema } from "./document-migrations";
import type { ExtensionStorageApiV1, ExtensionDocumentOptions, ExtensionJson } from "@opencraft/extension-contract";

/** One activation owns handles/observers, never the shared persistence connection. */
export function createScopedExtensionStorage(backend: ExtensionPersistence | undefined, extensionId: string, accepting: () => boolean,
  resolveHost?: (hostId: string, signal: AbortSignal) => Promise<ExtensionPersistence>) {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const subscriptions = new Set<() => void>();
  const hostController = new AbortController();
  const hostDisposers = new Set<() => Promise<void>>();
  function assertLive() { if (closed || !accepting()) throw new Error("Extension storage activation is stale"); }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    try { assertLive(); } catch (error) { return Promise.reject(error); }
    const work = operation().then(value => { assertLive(); return value; });
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); return work;
  }
  const api: ExtensionStorageApiV1 = {
    forHost(hostId: string) {
      return run(async () => {
        if (typeof hostId !== "string" || !hostId.trim() || hostId.length > 256) throw new TypeError("Invalid Host identity");
        if (!resolveHost) throw new Error("Host document storage is not available in this runtime");
        const remote = await resolveHost(hostId, hostController.signal);
        try { assertLive(); } catch (error) { await remote.close(); throw error; }
        const child = createScopedExtensionStorage(remote, extensionId, () => !closed && accepting());
        hostDisposers.add(async () => { await child.dispose(); await remote.close(); });
        return Object.freeze({ open: child.api.open });
      });
    },
    open(namespace: string, input: ExtensionDocumentOptions = { version: 1, initialValue: {} }) {
      return run(async () => {
        if (!backend) throw new Error("Client-local document storage is not available in this runtime");
        const local = backend;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(namespace)) throw new TypeError("Invalid plugin document namespace");
        const schema = documentSchema(input);
        const scope = `plugin/${extensionId}/${namespace}`;
        await schema.prepare(local, scope, assertLive);
        return Object.freeze({
          read: () => run(async () => {
            const record = await local.read(scope); if (!record) throw new Error("Plugin document unavailable"); return schema.snapshot(record);
          }),
          compareAndSet: (revision: number, value: ExtensionJson) => run(async () => {
            const current = await local.read(scope); assertLive();
            if (!current) throw new Error("Plugin document unavailable");
            schema.snapshot(current);
            const result = await local.compareAndSet(scope, revision, schema.version, schema.payload(value));
            if (!result.record) throw new Error("Plugin document unavailable");
            return { updated: result.updated, snapshot: schema.snapshot(result.record) };
          }),
          subscribe: (listener: () => void) => {
            assertLive();
            const remove = local.subscribe(changed => {
              if (!closed && accepting() && (changed === scope || changed === "*")) listener();
            });
            const dispose = () => { remove(); subscriptions.delete(dispose); };
            subscriptions.add(dispose); return dispose;
          },
        });
      });
    },
  };
  return {
    api: Object.freeze(api),
    async dispose() {
      closed = true; hostController.abort();
      for (const remove of subscriptions) remove();
      await Promise.allSettled([...pending]);
      await Promise.all([...hostDisposers].map(dispose => dispose()));
      hostDisposers.clear();
    },
  };
}

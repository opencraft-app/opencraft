import {
  validateMemoryBrowser,
  memoryBrowserFailure,
  readMemoryBrowser,
} from "../application/memory-browser-view.mjs";
/** Host-only, model-free facade. Only the existing UoW may write. Safe errors survive private IPC without raw paths. */
export function createMemoryBrowser({ memory, history, transact, authorize }) {
  return async (raw) => {
    await authorize();
    let result;
    try {
      const p = validateMemoryBrowser(raw);
      result = transact(() => {
        if (!["set", "forget"].includes(p.action))
          return readMemoryBrowser(memory.browserSnapshot(), p, (ids) =>
            history.memoryEvidence(ids),
          );
        memory.inspectPrivate(p.key, true);
        const value = memory.change(
          "owner-memory:" + p.requestId,
          "memory." + p.action,
          {
            key: p.key,
            scope: "agent",
            expectedRevision: p.expectedRevision,
            ...(p.action === "set" ? { value: p.value.trim() } : {}),
          },
        );
        return { action: p.action, ...value };
      });
    } catch (error) {
      result = memoryBrowserFailure(error);
    }
    await authorize();
    return result;
  };
}

import type { ExecutionLease, NativeExecutionState } from "./execution-lease-store.js";

type NativeRead = (
  method: "thread/turns/list",
  params: {
    threadId: string;
    limit: number;
    sortDirection: "desc";
    itemsView: "notLoaded";
  },
  signal: AbortSignal,
) => Promise<unknown>;

/** The request port MUST connect directly to the attested native/Host authority.
 * It may initialize a read connection, but must never resume, subscribe, steer,
 * acquire tools or change interaction ownership. Read failure stays unknown. */
export function createNativeExecutionTurnInspector(request: NativeRead, timeoutMs = 1500) {
  return async (lease: ExecutionLease): Promise<NativeExecutionState> => {
    if (!lease.turnId || !lease.engineIncarnation) return "unknown";
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const cancelled = new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Execution inspection timed out")), { once: true }),
      );
      const value = await Promise.race([
        Promise.resolve().then(() =>
          request(
            "thread/turns/list",
            {
              threadId: lease.threadId,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            },
            signal,
          ),
        ),
        cancelled,
      ]);
      if (!value || typeof value !== "object") return "unknown";
      const data = (value as { data?: unknown }).data;
      if (!Array.isArray(data) || data.length !== 1) return "unknown";
      const latest = data[0];
      if (
        !latest ||
        typeof latest.id !== "string" ||
        !["inProgress", "completed", "interrupted", "failed"].includes(latest.status)
      )
        return "unknown";
      if (latest.id !== lease.turnId) return "finished";
      return latest.status === "inProgress" ? "active" : "finished";
    } catch {
      return "unknown";
    }
  };
}

import type { AppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

type ConnectionRuntime = Pick<AppServerWorkbenchRuntime, "getSnapshot" | "subscribe" | "connect" | "reconnect">;

/** Observe the resident Host; its runtime remains the only automatic retry owner. */
export function observeEmbeddedConnection(
  runtime: ConnectionRuntime,
  publish: (detail: { phase: string; failureCode: string | null }) => void,
) {
  let disposed = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const update = () => {
    if (disposed) return;
    const snapshot = runtime.getSnapshot();
    publish({ phase: snapshot.phase, failureCode: snapshot.transport.failure?.code ?? null });
    if (snapshot.phase === "ready") resolveReady();
  };
  const stop = runtime.subscribe(update);
  update();
  void runtime.connect().catch(() => undefined);
  return {
    ready,
    async reconnect() {
      if (disposed) return;
      const phase = runtime.getSnapshot().phase;
      if (phase === "idle" || phase === "connecting" || phase === "reconnecting") await runtime.connect();
      else await runtime.reconnect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      rejectReady(new Error("Embedded connection observer disposed"));
    },
  };
}

import type { RfbDesktopAdapter } from "./rfb";

/** Discovery and authorization stay synchronous in the backend. Load media/input
 * only when an authorized viewer connects, not when registering its toolbar. */
export function createDeferredRfbDesktopAdapter(
  load: () => Promise<RfbDesktopAdapter> = async () => (await import("./rfb")).createRfbDesktopAdapter(),
): RfbDesktopAdapter {
  let adapter: RfbDesktopAdapter | undefined;
  let loading: Promise<RfbDesktopAdapter> | undefined;
  const resolve = () => loading ??= Promise.resolve().then(load).then(value => {
    adapter = value;
    return value;
  }).catch(error => {
    loading = undefined;
    throw error;
  });
  return {
    async connect(session, signal) {
      let closed = false;
      let delegated = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { session.close(); } catch { /* Retire the caller even if transport cleanup fails. */ }
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        signal.throwIfAborted();
        const media = await resolve();
        signal.throwIfAborted();
        // Transfer lifetime ownership exactly once. The real adapter watches
        // cancellation during decoder loading and owns the resulting connection.
        signal.removeEventListener("abort", close);
        delegated = true;
        return await media.connect(session, signal);
      } catch (error) {
        if (!delegated) close();
        throw error;
      } finally {
        signal.removeEventListener("abort", close);
      }
    },
    surfaces: {
      mount(element, connection) {
        if (!adapter) throw new Error("Desktop media is unavailable");
        return adapter.surfaces.mount(element, connection);
      },
    },
  };
}

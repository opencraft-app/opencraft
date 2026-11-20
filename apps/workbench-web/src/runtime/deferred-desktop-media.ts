import type { RfbDesktopAdapter, DesktopRfbSession } from "@opencraft/plugin-cloud-desktop/rfb";

/** Capability/attachment owners remain synchronous. Load only the media/input
 * implementation on connect, before any socket opens or surface can mount. */
export function createDeferredDesktopMedia(
  load: () => Promise<RfbDesktopAdapter> = async () =>
    (await import("@opencraft/plugin-cloud-desktop/rfb")).createRfbDesktopAdapter(),
): RfbDesktopAdapter {
  let media: RfbDesktopAdapter | undefined;
  let loading: Promise<RfbDesktopAdapter> | undefined;
  return {
    async connect(session: DesktopRfbSession, signal: AbortSignal) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { session.close(); } catch { /* Teardown cannot replace the admission failure. */ }
      };
      const ownedSession: DesktopRfbSession = {
        openChannel: () => session.openChannel(), close,
        ...(session.control ? { control: session.control } : {}),
        ...(session.getTermination ? { getTermination: () => session.getTermination!() } : {}),
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        signal.throwIfAborted();
        // Retrying a failed module load must not poison later attachments.
        loading ??= load().then(value => (media = value), error => { loading = undefined; throw error; });
        const adapter = await loading;
        signal.throwIfAborted();
        return await adapter.connect(ownedSession, signal);
      } catch (error) {
        close();
        throw error;
      } finally {
        signal.removeEventListener("abort", close);
      }
    },
    surfaces: { mount(element, connection) {
      if (!media) throw new Error("Desktop media is not connected");
      return media.surfaces.mount(element, connection);
    } },
  };
}

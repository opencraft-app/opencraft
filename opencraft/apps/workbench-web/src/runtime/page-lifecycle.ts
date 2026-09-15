/** The bootstrap that created the application owns its React root.
 * Unmount consumers before their effect cleanup releases Host providers.
 */
export function bindPageLifecycle(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  unmount: () => void,
): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    target.removeEventListener("pagehide", onHide);
    unmount();
  };
  const onHide = (event: PageTransitionEvent) => {
    if (!event.persisted) stop();
  };
  target.addEventListener("pagehide", onHide);
  return stop;
}

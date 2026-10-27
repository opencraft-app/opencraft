import { createContext, useContext, useEffect, useRef } from "react";

export const VisibleTurnReceiptContext = createContext<((turnId: string) => void) | undefined>(undefined);

/** A terminal result must actually intersect the foreground scrollport. Route
 * selection, background tabs and content covered by a drawer are not receipts. */
export function VisibleTurnReceipt({ turnId }: { readonly turnId: string }) {
  const callback = useContext(VisibleTurnReceiptContext);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const marker = ref.current;
    const root = marker?.closest(".thread-scroll");
    if (!marker || !root || !callback) return;
    let intersects = false;
    let frame = 0;
    const check = () => {
      if (!intersects || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const box = marker.getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const x = Math.min(box.right - 1, Math.max(box.left + 1, (box.left + box.right) / 2));
      const y = box.top;
      if (box.width <= 0 || y < bounds.top || y >= bounds.bottom) return;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === marker || marker.parentElement?.contains(hit))) callback(turnId);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); };
    const observer = new IntersectionObserver(entries => {
      intersects = entries.some(entry => entry.isIntersecting);
      schedule();
    }, { root });
    observer.observe(marker);
    window.addEventListener("focus", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("pointerup", schedule);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("focus", schedule); window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule); document.removeEventListener("pointerup", schedule);
    };
  }, [turnId, callback]);
  return <span ref={ref} aria-hidden="true" data-terminal-turn-receipt={turnId} style={{ display: "block", height: 1 }} />;
}

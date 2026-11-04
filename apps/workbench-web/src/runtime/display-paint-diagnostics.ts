import { canReportDisplayEvent, reportDisplayEvent } from "./recovery-diagnostics";
import type { displayTimingCounts } from "./display-timing-diagnostics";

/** One measurement owns this cache: later paints must reread changed styles. */
export function measureDisplayPaint() {
  const times = document.querySelectorAll(".thread-user-message time, [data-assistant-message-sent-time]");
  const visibility = new Map<Element, boolean>();
  let visibleTimes = 0;
  for (const element of times) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const visited: Element[] = [];
    let visible = true;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const cached = visibility.get(node);
      if (cached !== undefined) { visible = cached; break; }
      visited.push(node);
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        visible = false;
        break;
      }
    }
    for (const node of visited) visibility.set(node, visible);
    if (visible) visibleTimes++;
  }
  return { renderedTimes: times.length, visibleTimes };
}

/** A scheduled frame rechecks the shared budget before touching the DOM. */
export function reportDisplayPaint(counts: ReturnType<typeof displayTimingCounts>) {
  if (!canReportDisplayEvent()) return;
  reportDisplayEvent("display-paint", { ...counts, ...measureDisplayPaint() });
}

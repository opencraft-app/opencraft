import { useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import type { ConversationNavigationSource } from "@opencraft/chat-navigation";
import { waitForSearchNavigationAnchor } from "../runtime/conversation-search-navigation";
import type { WebVirtualizedTurnListApi } from "./conversation/virtualized-conversation-turns";
import type { ConversationSearchTarget } from "./conversation-search";

/** Uses the same authoritative hydration and measured positioning as the rail. */
export function ConversationSearchPosition({ source, target, api, scrollElement }: {
  readonly source: ConversationNavigationSource;
  readonly target: ConversationSearchTarget;
  readonly api: WebVirtualizedTurnListApi;
  readonly scrollElement: HTMLDivElement | null;
}) {
  const intl = useIntl();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const completed = useRef<string | null>(null);
  useEffect(() => {
    if (completed.current === target.requestId) return;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    const inputs = ["wheel", "pointerdown", "touchstart", "keydown"] as const;
    for (const event of inputs) scrollElement?.addEventListener(event, cancel, { passive: true });
    const release = () => { for (const event of inputs) scrollElement?.removeEventListener(event, cancel); };
    setFailed(false);
    void (async () => {
      if (target.turnId === null || target.itemId === null) throw new Error("No visible message locator");
      // Let dialog focus restoration and the conversation's viewport attachment
      // commit before asking the measured list to change its position.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (abort.signal.aborted) return;
      const anchor = await waitForSearchNavigationAnchor(source,
        { turnId: target.turnId, itemId: target.itemId }, abort.signal);
      if (abort.signal.aborted) return;
      const prepared = await source.prepareTarget(anchor.id, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!prepared || prepared.generation !== source.getSnapshot().generation) throw new Error("Matching turn changed");
      // Hydrating a distant Turn changes the measured window. Verify that its
      // prompt remains in the actual viewport after that layout commits, and
      // let the existing virtualizer reconcile if measurements moved it. Wait
      // for stable visibility, including deferred row measurement commits.
      const deadline = performance.now() + 2500;
      let visibleFrames = 0;
      let needsPosition = true;
      while (performance.now() < deadline) {
        if (needsPosition) {
          const result = await api.positionTarget({ turnKey: prepared.turnKey, targetKey: prepared.itemId ?? undefined,
            align: "top", behavior: "instant", topAlignmentInsetPx: 16,
            minimumTimelineRevision: prepared.projectionRevision, signal: abort.signal });
          if (abort.signal.aborted) return;
          if (result !== "positioned") throw new Error("Matching message unavailable");
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (abort.signal.aborted) return;
        const item = [...(scrollElement?.querySelectorAll<HTMLElement>("[data-content-search-unit-key]") ?? [])]
          .find(element => element.dataset.contentSearchUnitKey === prepared.itemId);
        const rect = item?.getBoundingClientRect();
        const viewport = scrollElement?.getBoundingClientRect();
        if (rect && viewport && rect.top >= viewport.top - 1 && rect.top < viewport.bottom) {
          needsPosition = false;
          if (++visibleFrames >= 4) {
            completed.current = target.requestId;
            return;
          }
        } else {
          visibleFrames = 0;
          needsPosition = true;
        }
      }
      throw new Error("Matching prompt moved outside the viewport");
    })().catch(() => { if (!abort.signal.aborted) setFailed(true); }).finally(release);
    return () => { abort.abort(); release(); };
  }, [source, target, api, retry, scrollElement]);
  return failed ? <div className="conversation-search-position" role="status">
    {intl.formatMessage({ id: "sidebar.search.positionError", defaultMessage: "The conversation opened, but the matching message could not be shown." })}
    {target.turnId !== null ? <button type="button" onClick={() => setRetry(value => value + 1)}>{intl.formatMessage({ id: "sidebar.search.retry", defaultMessage: "Retry" })}</button> : null}
  </div> : null;
}

import type { WebConversationContentWindow } from "@opencraft/timeline-host-web";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ConversationEntryMotionContext } from "./entry-motion";

export const ConversationContentWindowContext = createContext<WebConversationContentWindow | null>(null);

/** A stable flow placeholder, never a second scrollport. Children are a factory
 * so an offscreen row does not construct its renderer/Markdown/Motion tree. */
export function ConversationContentBoundary({ id, className, activity = false, keepMounted = false, estimateHeightPx = 27, followRef, children }: {
  readonly id: string;
  readonly className: string;
  readonly activity?: boolean;
  readonly keepMounted?: boolean;
  readonly estimateHeightPx?: number;
  readonly followRef?: (element: HTMLDivElement | null) => (() => void) | undefined;
  readonly children: () => ReactNode;
}) {
  const owner = useContext(ConversationContentWindowContext);
  const entryMotion = useContext(ConversationEntryMotionContext);
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(keepMounted || owner === null);
  const rendered = owner === null || keepMounted || visible;
  const attach = useCallback((node: HTMLDivElement | null) => {
    element.current = node;
    return followRef?.(node);
  }, [followRef]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !owner) return;
    return owner.observe(node, id, setVisible);
  }, [owner, id]);
  useLayoutEffect(() => {
    if (element.current) owner?.rendered(element.current, rendered);
  }, [owner, rendered]);
  // Recovered rows are existing content, not new activity entrances. Their
  // stable outer geometry participates in the original Turn measurement.
  return <div className={className} ref={attach}
    data-conversation-row={activity ? "activity" : undefined}
    data-conversation-content-key={id} data-content-mounted={rendered || undefined}
    style={rendered ? undefined : { height: owner?.height(id, estimateHeightPx), overflow: "hidden" }}>
    {rendered ? <ConversationEntryMotionContext.Provider value={keepMounted && entryMotion}>
      {children()}
    </ConversationEntryMotionContext.Provider> : null}
  </div>;
}

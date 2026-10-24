import type { TimelineSnapshot } from "@opencraft/chat-core";
import { createContext, useLayoutEffect, useRef } from "react";

/** Entry is a live presentation transition, not evidence that work just began. */
export const ConversationEntryMotionContext = createContext(true);

/** The first committed authoritative snapshot is a baseline, even if preceded
 * by an empty/loading or paint-only snapshot. A different conversation or a
 * reconnect establishes a new baseline before live insertions may animate. */
export function useConversationEntryMotion(timeline: TimelineSnapshot | null): boolean {
  const previous = useRef<TimelineSnapshot | null>(null);
  const before = previous.current;
  const live = timeline?.authoritative === true && timeline.phase === "live";
  const allowEntry = live && before?.authoritative === true && before.phase === "live"
    && before.key.hostId === timeline.key.hostId
    && before.key.threadId === timeline.key.threadId;
  useLayoutEffect(() => { previous.current = timeline; }, [timeline]);
  return allowEntry;
}

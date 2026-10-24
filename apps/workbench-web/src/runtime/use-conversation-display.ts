import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TimelineSnapshot } from "@opencraft/chat-core";
import { selectConversationDisplay } from "@opencraft/workbench-runtime";
import type { BrowserDisplayContinuity } from "./workbench-application-services";

/** React adapts scoped I/O and lifecycle; shared runtime owns display policy. */
export function useConversationDisplay(
  continuity: BrowserDisplayContinuity,
  key: TimelineSnapshot["key"] | null,
  timeline: TimelineSnapshot | null,
) {
  const scope = useSyncExternalStore(continuity.subscribe, continuity.getScope, continuity.getScope);
  const hostId = key?.hostId ?? null;
  const threadId = key?.threadId ?? null;
  const [loaded, setLoaded] = useState<{ scope: string; timeline: TimelineSnapshot } | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded(null);
    if (hostId !== null && threadId !== null) {
      void continuity.load(hostId, threadId).then(value => {
        if (current) setLoaded(value === null ? null : { scope, timeline: value });
      });
    }
    return () => { current = false; };
  }, [hostId, threadId, scope, continuity]);
  useEffect(() => {
    if (timeline?.authoritative) void continuity.observe(timeline).catch(() => undefined);
  }, [continuity, timeline]);

  const submission = key === null ? null : continuity.peekSubmission(key.hostId, key.threadId);
  const memory = key === null ? null : continuity.peek(key.hostId, key.threadId);
  // This state is an async read receipt, not a second writable timeline owner.
  // A new observation in memory wins, and old account/key reads cannot paint.
  const cached = memory ?? (loaded?.scope === scope
    && loaded.timeline.key.hostId === hostId && loaded.timeline.key.threadId === threadId ? loaded.timeline : null);
  const selection = useMemo(() => selectConversationDisplay({ key, timeline, cached, submission }),
    [key, timeline, cached, submission]);
  return { selection, scope, hasSubmission: submission !== null };
}

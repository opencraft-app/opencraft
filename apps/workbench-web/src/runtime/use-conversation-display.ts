import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  const scopedTimeline = continuity.canObserve() ? timeline : null;
  const hostId = key?.hostId ?? null;
  const threadId = key?.threadId ?? null;
  const retained = useRef<{ scope: string; timeline: TimelineSnapshot } | null>(null);
  useLayoutEffect(() => {
    const prior = retained.current;
    if (prior && (prior.scope !== scope || prior.timeline.key.hostId !== hostId || prior.timeline.key.threadId !== threadId)) {
      retained.current = null;
    }
    if (scopedTimeline?.authoritative && scopedTimeline.key.hostId === hostId && scopedTimeline.key.threadId === threadId) {
      // Keep the mounted geometry through transport and history recovery.
      // The retained baseline carries no command or interaction authority.
      retained.current = { scope, timeline: { ...scopedTimeline, phase: "painted", authoritative: false,
        frames: scopedTimeline.frames.filter(frame => frame.type !== "user" || !frame.blocks.some(block =>
          block.type === "user-message" && block.deliveryStatus !== null && block.deliveryStatus !== "sent")),
      } };
    }
  }, [scope, hostId, threadId, scopedTimeline]);
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
    if (scopedTimeline?.authoritative) void continuity.observe(scopedTimeline).catch(() => undefined);
  }, [continuity, scopedTimeline]);

  const submission = key === null ? null : continuity.peekSubmission(key.hostId, key.threadId);
  const memory = key === null ? null : continuity.peek(key.hostId, key.threadId);
  // This state is an async read receipt, not a second writable timeline owner.
  // A new observation in memory wins, and old account/key reads cannot paint.
  const cached = memory ?? (loaded?.scope === scope
    && loaded.timeline.key.hostId === hostId && loaded.timeline.key.threadId === threadId ? loaded.timeline : null);
  const warm = retained.current?.scope === scope ? retained.current.timeline : null;
  const selection = useMemo(() => selectConversationDisplay({ key, timeline: scopedTimeline, cached, submission, retained: warm }),
    [key, scopedTimeline, cached, submission, warm]);
  return { selection, scope, hasSubmission: submission !== null };
}

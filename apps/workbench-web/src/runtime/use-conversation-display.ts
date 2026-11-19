import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TimelineSnapshot, ConversationDisplayHeader } from "@opencraft/chat-core";
import { selectConversationDisplay } from "@opencraft/workbench-runtime";
import type { BrowserDisplayContinuity } from "./workbench-application-services";

/** React adapts scoped I/O and lifecycle; shared runtime owns display policy. */
export function useConversationDisplay(
  continuity: BrowserDisplayContinuity,
  key: TimelineSnapshot["key"] | null,
  timeline: TimelineSnapshot | null,
  historyHasOlder?: boolean,
  header?: ConversationDisplayHeader,
) {
  const scope = useSyncExternalStore(continuity.subscribe, continuity.getScope, continuity.getScope);
  const hostId = key?.hostId ?? null;
  const threadId = key?.threadId ?? null;
  const [, refreshAfterRead] = useState(0);
  useEffect(() => {
    let current = true;
    if (hostId !== null && threadId !== null) {
      void continuity.load(hostId, threadId).then(() => {
        if (current) refreshAfterRead(revision => revision + 1);
      });
    }
    return () => { current = false; };
  }, [hostId, threadId, scope, continuity]);
  useEffect(() => {
    if (timeline?.authoritative && timeline.key.hostId === hostId && timeline.key.threadId === threadId) void continuity.observe(timeline, historyHasOlder, header).catch(() => undefined);
  }, [continuity, timeline, hostId, threadId, historyHasOlder, header?.title, header?.project]);

  const submission = key === null ? null : continuity.peekSubmission(key.hostId, key.threadId);
  // Reads populate the shared cache and only request a render here. Retaining
  // their payload as a fallback would bypass its invalidation, empty state and
  // expiry when live history temporarily disconnects.
  const cached = key === null ? null : continuity.peek(key.hostId, key.threadId);
  const selection = useMemo(() => selectConversationDisplay({ key, timeline, cached, submission, historyHasOlder }),
    [key, timeline, cached, submission, historyHasOlder]);
  return { selection, scope, header: cached?.displayHeader, hasSubmission: submission !== null };
}

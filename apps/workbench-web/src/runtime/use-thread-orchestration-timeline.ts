import { useCallback, useMemo, useSyncExternalStore } from "react";
import { applyThreadOrchestrationView, type TimelineSnapshot } from "@opencraft/chat-core";
import type { ThreadOrchestrationResource } from "@opencraft/workbench-runtime";

/** The active View reads display facts; the Host resource owns refresh/reconnect. */
export function useThreadOrchestrationTimeline(timeline:TimelineSnapshot|null,resource:ThreadOrchestrationResource,enabled:boolean):TimelineSnapshot|null {
  const threadId = timeline?.key.threadId ?? "";
  const identity = JSON.stringify(timeline?.frames.flatMap(frame => frame.blocks.flatMap(block =>
    block.type === "subagent" && block.controlCall ? [block.controlCall] : [])) ?? []);
  const calls = useMemo(() => JSON.parse(identity) as {turnId:string;itemId:string}[],[identity]);
  const subscribe = useCallback((listener:()=>void) => enabled && threadId && calls.length
    ? resource.subscribe(threadId,calls,listener) : () => {},[resource,threadId,calls,enabled]);
  const read = useCallback(() => enabled ? resource.getSnapshot(threadId) : null,[resource,threadId,enabled]);
  const view = useSyncExternalStore(subscribe,read,read);
  return useMemo(() => applyThreadOrchestrationView(timeline,view),[timeline,view]);
}

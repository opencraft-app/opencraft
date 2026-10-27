import type { ThreadOrchestrationView } from "@opencraft/appserver-protocol/collaboration";
import type { TimelineSnapshot } from "./timeline";

/** The Native/cache timeline and control ledger are independent read authorities. */
export function applyThreadOrchestrationView(timeline:TimelineSnapshot|null,view:ThreadOrchestrationView|null):TimelineSnapshot|null {
  if (!timeline || !view || view.threadId !== timeline.key.threadId) return timeline;
  const calls = new Map(view.calls.map(call => [JSON.stringify([call.turnId,call.itemId]),call]));
  return {...timeline,frames:timeline.frames.map(frame => ({...frame,blocks:frame.blocks.map(block => {
    if (block.type !== "subagent" || !block.controlCall) return block;
    const call = calls.get(JSON.stringify([block.controlCall.turnId,block.controlCall.itemId]));
    if (!call) return block;
    return {...block,toolCallStatus:call.toolCallStatus,status:call.toolCallStatus,deliveryStatus:call.deliveryStatus,
      childRuntimeStatus:call.childRuntimeStatus,receiverThreadIds:call.receiverThreadIds,agentId:call.receiverThreadIds[0] ?? null,
      agentStates:Object.fromEntries(Object.entries((block.agentStates ?? {}) as Record<string,unknown>).filter(([id]) => call.receiverThreadIds.includes(id)))};
  })}))};
}

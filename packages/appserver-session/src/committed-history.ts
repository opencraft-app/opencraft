import type { AppServerTurn, ThreadHistoryVersion, ThreadHistoryUpdate } from "@opencraft/appserver-protocol";
import { mergeTurns, reconcileRecoveryWindow } from "./merge-turns";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const terminal = (value: unknown) => value === "completed" || value === "failed" || value === "interrupted";

export function historyVersion(value: unknown): ThreadHistoryVersion | undefined {
  if (!record(value) || typeof value.epoch !== "string" || !value.epoch || value.epoch.length > 4096
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return;
  return {epoch:value.epoch,revision:Number(value.revision)};
}
export function sameHistoryVersion(a: ThreadHistoryVersion | undefined, b: ThreadHistoryVersion | undefined): boolean {
  return a !== undefined && b !== undefined && a.epoch === b.epoch && a.revision === b.revision;
}
export function validHistoryUpdate(value: unknown): value is ThreadHistoryUpdate {
  return record(value) && Array.isArray(value.turns) && value.turns.every(delta => record(delta)
    && record(delta.turn) && typeof delta.turn.id === "string" && Array.isArray(delta.turn.items)
    && delta.turn.items.every(item => record(item) && typeof item.id === "string")
    && Array.isArray(delta.completedItemIds) && delta.completedItemIds.every(id => typeof id === "string")
    && typeof delta.latest === "boolean" && (delta.itemOrder === undefined || Array.isArray(delta.itemOrder) && delta.itemOrder.every(id => typeof id === "string")))
    && Array.isArray(value.removedTurnIds) && value.removedTurnIds.every(id => typeof id === "string")
    && Array.isArray(value.removedItems) && value.removedItems.every(item => record(item) && typeof item.turnId === "string" && typeof item.itemId === "string")
    && (value.turnOrder === undefined || Array.isArray(value.turnOrder) && value.turnOrder.every(id => typeof id === "string"))
    && (value.metadata === undefined || record(value.metadata));
}

/** The reply owns durable membership and lifecycle through its receive cut.
 * Retained live bodies remain a transient overlay on active Items; observations
 * received after that cut are merged by the ordinary immutable-view fence. */
export function reconcileVersionedHistory(
  current: readonly AppServerTurn[], incoming: readonly AppServerTurn[], receipt: readonly AppServerTurn[],
  liveItems: ReadonlySet<string>, unresolved: readonly string[] = [],
): readonly AppServerTurn[] {
  const atReceipt = new Map(receipt.map(turn => [turn.id,turn]));
  const protectedHistory = incoming.map(turn => {
    if (terminal(turn.status)) return turn;
    const live = atReceipt.get(turn.id);
    if (!live) return turn;
    const items = new Map(live.items?.map(item => [item.id,item]));
    return {...turn,items:turn.items?.map(item => {
      if (terminal(item.status)) return item;
      const known = items.get(item.id);
      if (!known || !liveItems.has(JSON.stringify([turn.id,item.id]))) return item;
      // A cold suffix is not a known full prefix. Prefer a longer canonical
      // message when the retained text cannot extend that canonical prefix.
      if (typeof item.text === "string" && typeof known.text === "string" && !known.text.startsWith(item.text)) return item;
      return {...item,...known};
    })};
  });
  return reconcileRecoveryWindow(current,protectedHistory,receipt,unresolved);
}

/** Committed display facts are sparse updates, never a replacement history range.
 * An active source snapshot may trail already projected token deltas. Only an
 * explicit completed Item (or terminal Turn) may replace that existing body. */
export function applyCommittedHistory(current: readonly AppServerTurn[], value: unknown, liveItems: ReadonlySet<string> = new Set()): readonly AppServerTurn[] {
  if (!record(value) || !Array.isArray(value.turns) || !Array.isArray(value.removedTurnIds) || !Array.isArray(value.removedItems)) return current;
  const removedItems=value.removedItems;
  const removed = new Set(value.removedTurnIds);
  let result = current.filter(turn => !removed.has(turn.id)).map(turn => {
    const ids = new Set(removedItems.filter((item: unknown) => record(item) && item.turnId === turn.id).map((item: any) => item.itemId));
    return ids.size ? {...turn,items:turn.items?.filter(item=>!ids.has(item.id))}:turn;
  });
  for (const delta of value.turns) {
    if (!record(delta) || !record(delta.turn) || typeof delta.turn.id !== "string" || !Array.isArray(delta.turn.items)
      || !Array.isArray(delta.completedItemIds)) continue;
    const incoming=delta.turn as unknown as AppServerTurn, previous=result.find(turn=>turn.id===incoming.id);
    // An unrelated old-page import must not mount history the user hasn't loaded.
    if (!previous && delta.latest !== true) continue;
    const completed=new Set(delta.completedItemIds), oldItems=new Map(previous?.items?.map(item=>[item.id,item]));
    const items=incoming.items!.filter(item=>typeof item?.id === "string" && (!oldItems.has(item.id) || !liveItems.has(JSON.stringify([incoming.id,item.id])) || completed.has(item.id)));
    const header=previous && terminal(previous.status) && !terminal(incoming.status) ? {...incoming,status:previous.status}:incoming;
    result=[...mergeTurns(result,[{...header,items}])];
    if(Array.isArray(delta.itemOrder)) {
      const positions=new Map(delta.itemOrder.map((id,index)=>[id,index]));
      result=result.map(turn=>turn.id===incoming.id ? {...turn,items:turn.items && [...turn.items].sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity))}:turn);
    }
  }
  if(Array.isArray(value.turnOrder)) {
    const positions=new Map(value.turnOrder.map((id,index)=>[id,index]));
    result.sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity));
  }
  return result.length===current.length && result.every((turn,index)=>turn===current[index]) ? current:result;
}

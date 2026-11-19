import type {
  AssistantMemoryItem,
  PersonalAssistantBinding,
} from "@opencraft/appserver-protocol";
import type { ChannelRpc } from "./channel-client";
export interface MemoryDraft {
  base: AssistantMemoryItem;
  value: string;
  pending?: { signature: string; requestId: string };
}
// Session-only, scoped to the exact authenticated transport and owner binding. Never localStorage.
const listening = new WeakSet<ChannelRpc>();
const cache = new WeakMap<
  ChannelRpc,
  Map<string, { at: number; draft: MemoryDraft }>
>();
const key = (b: PersonalAssistantBinding) =>
  JSON.stringify([
    b.serverId,
    b.botId,
    b.assignmentId,
    b.owner.kind,
    b.owner.id,
  ]);
export function memoryDraft(
  rpc: ChannelRpc,
  binding: PersonalAssistantBinding,
  value?: MemoryDraft | null,
): MemoryDraft | null {
  if (!listening.has(rpc)) {
    listening.add(rpc);
    rpc.onDisconnect(() => cache.delete(rpc));
  }
  let entries = cache.get(rpc);
  if (!entries) {
    entries = new Map();
    cache.set(rpc, entries);
  }
  const now = Date.now();
  for (const [k, v] of entries) if (now - v.at > 600000) entries.delete(k);
  const k = key(binding);
  if (value === null) entries.delete(k);
  else if (value) {
    if (entries.size >= 8 && !entries.has(k))
      entries.delete(entries.keys().next().value!);
    entries.set(k, { at: now, draft: structuredClone(value) });
  }
  return entries.get(k)?.draft ?? null;
}
export function clearMemoryDrafts(rpc: ChannelRpc) {
  cache.delete(rpc);
}

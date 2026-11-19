import { useCallback, useMemo, useSyncExternalStore } from "react";
import { independentConversationOwnership } from "@opencraft/chat-core";
import type { SideChatService } from "@opencraft/workbench-runtime";
import { ordinaryConversationCatalog } from "./ordinary-conversation-catalog";

export function useOrdinaryConversationCatalog<T extends { readonly connectionHostId: string; readonly id: string }>(
  threads: readonly T[],
  sideChats: SideChatService | null | undefined,
): readonly T[] {
  const subscribe = useCallback((listener: () => void) => sideChats?.subscribe(listener) ?? (() => {}), [sideChats]);
  const readRevision = useCallback(() => sideChats?.getRevision() ?? 0, [sideChats]);
  const revision = useSyncExternalStore(subscribe, readRevision, readRevision);
  return useMemo(
    () =>
      ordinaryConversationCatalog(threads, (key) => sideChats?.ownershipOf(key) ?? independentConversationOwnership),
    [threads, sideChats, revision],
  );
}

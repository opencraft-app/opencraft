"use client";

import { useEffect, useMemo } from "react";
import type { WebChatModel } from "../../adapters/toWebBlocks";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
} from "../../conversation-runtime/model";
import {
  useConversationScrollController,
  type ConversationScrollControllerDebug,
} from "../../conversation-runtime/scroll/useConversationScrollController";
import { Conversation } from "../../primitives/conversation/Conversation";
import { VelaTurnList } from "./VelaTurnList";

export function VelaConversation({
  webModel,
  canLoadOlder = false,
  isLoadingOlder = false,
  onLoadOlder,
  onScrollDebugChange,
}: {
  webModel: WebChatModel;
  canLoadOlder?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  onScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
}) {
  const items = useMemo(
    () => buildConversationStreamItems(webModel.turns),
    [webModel.turns],
  );
  const dependency = useMemo(
    () => items.map((item) => `${item.key}:${item.live}:${item.fingerprint}`).join("|"),
    [items],
  );
  const runtimePolicy = useMemo(
    () => conversationRuntimePolicyForHost(webModel.host.kind),
    [webModel.host.kind],
  );
  const segments = useMemo(
    () => buildConversationRuntimeSegments(items, runtimePolicy),
    [items, runtimePolicy],
  );
  const scroll = useConversationScrollController(dependency, {
    hasOlderHistory: canLoadOlder,
    historyStartKey: webModel.sessionId,
    isLoadingOlderHistory: isLoadingOlder,
    onNearHistoryStart: onLoadOlder,
  });

  useEffect(() => {
    onScrollDebugChange?.(scroll.debug);
  }, [onScrollDebugChange, scroll.debug]);

  return (
    <Conversation scrollRef={scroll.scrollRef}>
      <VelaTurnList
        contentRef={scroll.contentRef}
        hostKind={webModel.host.kind}
        isLoadingOlderHistory={isLoadingOlder}
        scrollRef={scroll.scrollRef}
        segments={segments}
      />
    </Conversation>
  );
}

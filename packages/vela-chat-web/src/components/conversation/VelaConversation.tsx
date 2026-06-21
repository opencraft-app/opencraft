"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo } from "react";
import type { WebChatModel } from "../../adapters/toWebBlocks";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
  deriveConversationScrollSignals,
} from "../../conversation-runtime/model";
import {
  useConversationScrollController,
  type ConversationScrollControllerDebug,
} from "../../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationViewportHandle } from "../../conversation-runtime/scroll/viewportHandle";
import { Conversation } from "../../primitives/conversation/Conversation";
import { VelaTurnList } from "./VelaTurnList";

export const VelaConversation = forwardRef<ConversationViewportHandle, {
  webModel: WebChatModel;
  canLoadOlder?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  onScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
}>(function VelaConversation({
  webModel,
  canLoadOlder = false,
  isLoadingOlder = false,
  onLoadOlder,
  onScrollDebugChange,
}, ref) {
  const items = useMemo(
    () => buildConversationStreamItems(webModel.turns),
    [webModel.turns],
  );
  const scrollSignals = useMemo(
    () => deriveConversationScrollSignals(items),
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
  const scroll = useConversationScrollController(scrollSignals, {
    hasOlderHistory: canLoadOlder,
    historyStartKey: webModel.sessionId,
    isLoadingOlderHistory: isLoadingOlder,
    onNearHistoryStart: onLoadOlder,
  });

  useEffect(() => {
    onScrollDebugChange?.(scroll.debug);
  }, [onScrollDebugChange, scroll.debug]);

  useImperativeHandle(
    ref,
    () => ({
      requestBottomAnchor: scroll.requestBottomAnchor,
      prepareForViewportChange: scroll.prepareForViewportChange,
    }),
    [scroll.prepareForViewportChange, scroll.requestBottomAnchor],
  );

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
});

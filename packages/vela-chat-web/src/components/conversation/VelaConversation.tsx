"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
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
  messageFollowToken?: number;
  onLoadOlder?: () => void;
  onScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
}>(function VelaConversation({
  webModel,
  canLoadOlder = false,
  isLoadingOlder = false,
  messageFollowToken,
  onLoadOlder,
  onScrollDebugChange,
}, ref) {
  const previousMessageFollowTokenRef = useRef(messageFollowToken);
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

  useEffect(() => {
    if (messageFollowToken === undefined) return;
    if (previousMessageFollowTokenRef.current === messageFollowToken) return;
    previousMessageFollowTokenRef.current = messageFollowToken;
    scroll.requestBottomAnchor("message_sent");
  }, [messageFollowToken, scroll.requestBottomAnchor]);

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

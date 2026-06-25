"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { VelaClientStateStore } from "../../../../vela-chat-host-state/src";
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
  type ConversationScrollLifecycleEvent,
} from "../../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationViewportHandle } from "../../conversation-runtime/scroll/viewportHandle";
import { useConversationScrollbarOverlay } from "../../conversation-runtime/scrollbar/useConversationScrollbarOverlay";
import { Conversation } from "../../primitives/conversation/Conversation";
import styles from "../../styles/desktop.module.css";
import { VelaTurnList } from "./VelaTurnList";

export const VelaConversation = forwardRef<ConversationViewportHandle, {
  webModel: WebChatModel;
  canLoadOlder?: boolean;
  clientStateStore?: VelaClientStateStore | null;
  followOutputToken?: number;
  isHistoryReady?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  onScrollLifecycleEvent?: (event: ConversationScrollLifecycleEvent) => void;
  onScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
}>(function VelaConversation({
  webModel,
  canLoadOlder = false,
  clientStateStore = null,
  followOutputToken,
  isHistoryReady = true,
  isLoadingOlder = false,
  onLoadOlder,
  onScrollLifecycleEvent,
  onScrollDebugChange,
}, ref) {
  const previousFollowOutputTokenRef = useRef(followOutputToken);
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
    clientStateStore,
    hasOlderHistory: canLoadOlder,
    historyStartKey: webModel.sessionId,
    isHistoryReady,
    isLoadingOlderHistory: isLoadingOlder,
    onLifecycleEvent: onScrollLifecycleEvent,
    onNearHistoryStart: onLoadOlder,
    transportKey: segments.boundary.hasVirtualizedHistory
      ? "web-partial-virtualized"
      : "web-scroll",
  });
  const scrollbarOverlay = useConversationScrollbarOverlay(scroll.scrollRef, {
    contentRef: scroll.contentRef,
    onScrollCommit: scroll.commitScrollResumeNow,
    onUserScrollIntent: scroll.markUserScrollIntent,
  });

  useEffect(() => {
    onScrollDebugChange?.(scroll.debug);
  }, [onScrollDebugChange, scroll.debug]);

  useEffect(() => {
    if (followOutputToken === undefined) return;
    if (previousFollowOutputTokenRef.current === followOutputToken) return;
    previousFollowOutputTokenRef.current = followOutputToken;
    scroll.requestBottomAnchor("follow_output");
  }, [followOutputToken, scroll.requestBottomAnchor]);

  useImperativeHandle(
    ref,
    () => ({
      requestBottomAnchor: scroll.requestBottomAnchor,
      prepareForViewportChange: scroll.prepareForViewportChange,
    }),
    [scroll.prepareForViewportChange, scroll.requestBottomAnchor],
  );

  return (
    <div className={styles.conversationShell}>
      <Conversation scrollRef={scroll.scrollRef}>
        <VelaTurnList
          contentRef={scroll.contentRef}
          hostKind={webModel.host.kind}
          initialScrollTop={scroll.initialScrollTop}
          isLoadingOlderHistory={isLoadingOlder}
          scrollRef={scroll.scrollRef}
          segments={segments}
        />
      </Conversation>
      {scrollbarOverlay}
    </div>
  );
});

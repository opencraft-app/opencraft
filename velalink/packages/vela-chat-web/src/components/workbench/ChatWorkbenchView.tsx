"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  QueuedComposerInputClientState,
  VelaClientStateStore,
} from "../../../../vela-chat-host-state/src";
import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../../vela-chat-render-model/src";
import type { VoiceInputHost } from "../../../../vela-desktop-shell/src";
import { toWebChatModel } from "../../adapters/toWebBlocks";
import type { ComposerSkill } from "../../composer-skills/model";
import type { ComposerControlsModel } from "../composer-controls/model";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";
import { VelaComposer } from "../composer/VelaComposer";
import { VelaConversation } from "../conversation/VelaConversation";
import { RequestDock, type RequestDockResponse } from "../requests/RequestDock";
import { ConversationHistoryHydrationView } from "./ConversationHistoryHydrationView";
import { ConversationScrollInspector } from "./ConversationScrollInspector";
import type { ConversationScrollControllerDebug } from "../../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationScrollLifecycleEvent } from "../../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationViewportHandle } from "../../conversation-runtime/scroll/viewportHandle";
import styles from "../../styles/desktop.module.css";

const frameWithoutTopbarStyle = {
  gridTemplateRows: "minmax(0, 1fr)",
} satisfies CSSProperties;

export type ConversationRevealState = "measuring" | "revealed";

export interface ConversationRevealStateEvent {
  sessionId: string;
  historyPhase: ChatWorkbenchViewProps["historyPhase"];
  revealState: ConversationRevealState;
  bottomAnchorBlockedReason: ConversationScrollControllerDebug["bottomAnchorBlockedReason"];
  bottomAnchorLastFulfilledReason: ConversationScrollControllerDebug["bottomAnchorLastFulfilledReason"];
  bottomAnchorMode: ConversationScrollControllerDebug["bottomAnchorMode"] | "unknown";
  bottomAnchorPendingWork: boolean;
  bottomAnchorPendingReason: ConversationScrollControllerDebug["bottomAnchorPendingReason"];
  routeInitialized: boolean;
  routeKey: string | null;
  routeResumeScrollTop: number | null;
  routeResumeStatus: ConversationScrollControllerDebug["routeResumeStatus"] | "unknown";
}

export interface ChatWorkbenchViewProps {
  model: ChatRenderModel;
  draft: string;
  error?: string | null;
  canLoadOlder?: boolean;
  clientStateStore?: VelaClientStateStore | null;
  layout?: "viewport" | "contained";
  historyPhase: "unselected" | "hydrating_history" | "ready";
  isLoadingOlder?: boolean;
  composerControls?: ComposerControlsModel;
  followOutputToken?: number;
  isUpdatingComposerControls?: boolean;
  isRespondingToRequest?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  queuedInputs?: QueuedComposerInputClientState[];
  skills?: ComposerSkill[];
  showScrollInspector?: boolean;
  voiceInput?: VoiceInputHost;
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onLoadOlder?: () => void;
  onConversationRevealStateChange?: (event: ConversationRevealStateEvent) => void;
  onConversationScrollLifecycleEvent?: (event: ConversationScrollLifecycleEvent) => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRemoveQueuedInput?: (queuedInputId: string) => void;
  onRespondToRequest?: (response: RequestDockResponse) => void;
  onStop?: () => void;
  onSubmit: () => void;
  onSubmitText?: (text: string) => void | Promise<void>;
}

export function ChatWorkbenchView({
  model,
  draft,
  error,
  canLoadOlder = false,
  clientStateStore = null,
  layout = "viewport",
  historyPhase,
  isLoadingOlder = false,
  composerControls,
  followOutputToken,
  isUpdatingComposerControls = false,
  isRespondingToRequest = false,
  pendingAttachments,
  queuedInputs,
  skills,
  showScrollInspector = false,
  voiceInput,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationRevealStateChange,
  onConversationScrollLifecycleEvent,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onRemoveQueuedInput,
  onRespondToRequest,
  onStop,
  onSubmit,
  onSubmitText,
}: ChatWorkbenchViewProps) {
  const webModel = useMemo(() => toWebChatModel(model), [model]);
  const conversationRef = useRef<ConversationViewportHandle | null>(null);
  const lastConversationRevealStateSignatureRef = useRef("");
  const [composerHeight, setComposerHeight] = useState(154);
  const [conversationScrollDebugState, setConversationScrollDebugState] =
    useState<{
      debug: ConversationScrollControllerDebug;
      sessionId: string;
    } | null>(null);
  const frameStyle = useMemo(
    () =>
      ({
        ...frameWithoutTopbarStyle,
        "--vela-composer-height": `${Math.ceil(composerHeight)}px`,
      }) as CSSProperties,
    [composerHeight],
  );
  const handleSubmit = useCallback(() => {
    conversationRef.current?.requestBottomAnchor("message_sent");
    onSubmit();
  }, [onSubmit]);
  const handleSubmitText = useCallback(
    (text: string) => {
      conversationRef.current?.requestBottomAnchor("message_sent");
      void onSubmitText?.(text);
    },
    [onSubmitText],
  );
  const handleComposerHeightChange = useCallback((height: number) => {
    setComposerHeight((current) => (Math.abs(current - height) < 1 ? current : height));
    conversationRef.current?.prepareForViewportChange();
  }, []);
  const handleConversationScrollDebugChange = useCallback(
    (debug: ConversationScrollControllerDebug) => {
      setConversationScrollDebugState({
        debug,
        sessionId: webModel.sessionId,
      });
      onConversationScrollDebugChange?.(debug);
    },
    [onConversationScrollDebugChange, webModel.sessionId],
  );
  const isHydratingHistory = historyPhase === "hydrating_history";
  const conversationScrollDebug =
    conversationScrollDebugState?.sessionId === webModel.sessionId &&
    conversationScrollDebugState.debug.routeKey === webModel.sessionId
      ? conversationScrollDebugState.debug
      : null;
  const isConversationScrollSettled =
    conversationScrollDebug !== null &&
    conversationScrollDebug.routeInitialized &&
    conversationScrollDebug.routeResumeStatus !== "pending";
  const isMeasuringReadyConversation =
    historyPhase === "ready" && !isConversationScrollSettled;
  const conversationRevealState =
    isMeasuringReadyConversation ? "measuring" : "revealed";
  useEffect(() => {
    const event: ConversationRevealStateEvent = {
      sessionId: webModel.sessionId,
      historyPhase,
      revealState: conversationRevealState,
      bottomAnchorBlockedReason:
        conversationScrollDebug?.bottomAnchorBlockedReason ?? null,
      bottomAnchorLastFulfilledReason:
        conversationScrollDebug?.bottomAnchorLastFulfilledReason ?? null,
      bottomAnchorMode: conversationScrollDebug?.bottomAnchorMode ?? "unknown",
      bottomAnchorPendingWork:
        conversationScrollDebug?.bottomAnchorPendingWork ?? false,
      bottomAnchorPendingReason:
        conversationScrollDebug?.bottomAnchorPendingReason ?? null,
      routeInitialized: conversationScrollDebug?.routeInitialized ?? false,
      routeKey: conversationScrollDebug?.routeKey ?? null,
      routeResumeScrollTop: conversationScrollDebug?.routeResumeScrollTop ?? null,
      routeResumeStatus: conversationScrollDebug?.routeResumeStatus ?? "unknown",
    };
    const signature = JSON.stringify(event);
    if (lastConversationRevealStateSignatureRef.current === signature) return;
    lastConversationRevealStateSignatureRef.current = signature;
    onConversationRevealStateChange?.(event);
  }, [
    conversationRevealState,
    conversationScrollDebug?.bottomAnchorBlockedReason,
    conversationScrollDebug?.bottomAnchorLastFulfilledReason,
    conversationScrollDebug?.bottomAnchorMode,
    conversationScrollDebug?.bottomAnchorPendingWork,
    conversationScrollDebug?.bottomAnchorPendingReason,
    conversationScrollDebug?.routeInitialized,
    conversationScrollDebug?.routeKey,
    conversationScrollDebug?.routeResumeScrollTop,
    conversationScrollDebug?.routeResumeStatus,
    historyPhase,
    onConversationRevealStateChange,
    webModel.sessionId,
  ]);

  return (
    <main className={styles.shell} data-layout={layout}>
      <div className={styles.frame} data-history-phase={historyPhase} style={frameStyle}>
        <div
          aria-hidden={isMeasuringReadyConversation ? "true" : undefined}
          className={styles.conversationReveal}
          data-bottom-anchor-blocked-reason={
            conversationScrollDebug?.bottomAnchorBlockedReason ?? "none"
          }
          data-bottom-anchor-mode={conversationScrollDebug?.bottomAnchorMode ?? "unknown"}
          data-bottom-anchor-pending-work={
            conversationScrollDebug?.bottomAnchorPendingWork ?? "false"
          }
          data-bottom-anchor-pending-reason={
            conversationScrollDebug?.bottomAnchorPendingReason ?? "none"
          }
          data-conversation-reveal-state={conversationRevealState}
          data-route-initialized={conversationScrollDebug?.routeInitialized ?? "false"}
          data-route-key={conversationScrollDebug?.routeKey ?? "none"}
          data-route-resume-status={conversationScrollDebug?.routeResumeStatus ?? "unknown"}
          data-route-resume-scroll-top={
            conversationScrollDebug?.routeResumeScrollTop ?? "none"
          }
        >
          <VelaConversation
            canLoadOlder={canLoadOlder}
            clientStateStore={clientStateStore}
            isHistoryReady={historyPhase === "ready"}
            isLoadingOlder={isLoadingOlder}
            followOutputToken={followOutputToken}
            onLoadOlder={onLoadOlder}
            onScrollLifecycleEvent={onConversationScrollLifecycleEvent}
            onScrollDebugChange={handleConversationScrollDebugChange}
            ref={conversationRef}
            webModel={webModel}
          />
        </div>
        {isHydratingHistory ? (
          <div className={styles.historyHydrationOverlay}>
            <ConversationHistoryHydrationView />
          </div>
        ) : null}
        <RequestDock
          requests={model.requests}
          isResponding={isRespondingToRequest}
          onRespondToRequest={onRespondToRequest}
        />
        {error ? <div className={styles.error}>{error}</div> : null}
        {showScrollInspector ? (
          <ConversationScrollInspector
            debug={conversationScrollDebug}
            historyPhase={historyPhase}
          />
        ) : null}
        <div aria-hidden="true" className={styles.composerBackdrop} />
        <VelaComposer
          canSend={webModel.composer.canSend}
          controls={composerControls}
          draft={draft}
          isRunning={webModel.composer.isRunning}
          isUpdatingControls={isUpdatingComposerControls}
          onAttachImages={onAttachImages}
          onAgentConfigChange={onAgentConfigChange}
          onDraftChange={onDraftChange}
          onHeightChange={handleComposerHeightChange}
          onRemoveAttachment={onRemoveAttachment}
          onRemoveQueuedInput={onRemoveQueuedInput}
          onStop={onStop}
          onSubmit={handleSubmit}
          onSubmitText={handleSubmitText}
          pendingAttachments={pendingAttachments}
          placeholder={webModel.composer.placeholder}
          queuedInputs={queuedInputs}
          skills={skills}
          voiceInput={voiceInput}
        />
      </div>
    </main>
  );
}

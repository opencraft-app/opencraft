"use client";

import type { CSSProperties } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  QueuedComposerInputClientState,
  VelaClientStateStore,
} from "../../../../vela-chat-host-state/src";
import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../../vela-chat-render-model/src";
import type { VoiceInputHost } from "../../../../vela-desktop-shell/src";
import { toWebChatModel } from "../../adapters/toWebBlocks";
import type { ComposerControlsModel } from "../composer-controls/model";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";
import { VelaComposer } from "../composer/VelaComposer";
import { VelaConversation } from "../conversation/VelaConversation";
import { RequestDock, type RequestDockResponse } from "../requests/RequestDock";
import { ConversationHistoryHydrationView } from "./ConversationHistoryHydrationView";
import { ConversationScrollInspector } from "./ConversationScrollInspector";
import type { ConversationScrollControllerDebug } from "../../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationViewportHandle } from "../../conversation-runtime/scroll/viewportHandle";
import styles from "../../styles/desktop.module.css";

const frameWithoutTopbarStyle = {
  gridTemplateRows: "minmax(0, 1fr)",
} satisfies CSSProperties;

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
  isUpdatingComposerControls?: boolean;
  isRespondingToRequest?: boolean;
  messageFollowToken?: number;
  pendingAttachments?: PromptInputAttachment[];
  queuedInputs?: QueuedComposerInputClientState[];
  showScrollInspector?: boolean;
  voiceInput?: VoiceInputHost;
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onLoadOlder?: () => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRemoveQueuedInput?: (queuedInputId: string) => void;
  onRespondToRequest?: (response: RequestDockResponse) => void;
  onStop?: () => void;
  onSubmit: () => void;
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
  isUpdatingComposerControls = false,
  isRespondingToRequest = false,
  messageFollowToken,
  pendingAttachments,
  queuedInputs,
  showScrollInspector = false,
  voiceInput,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onRemoveQueuedInput,
  onRespondToRequest,
  onStop,
  onSubmit,
}: ChatWorkbenchViewProps) {
  const webModel = useMemo(() => toWebChatModel(model), [model]);
  const conversationRef = useRef<ConversationViewportHandle | null>(null);
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
    conversationScrollDebugState?.sessionId === webModel.sessionId
      ? conversationScrollDebugState.debug
      : null;
  const isConversationScrollSettled =
    conversationScrollDebug !== null &&
    conversationScrollDebug.routeResumeStatus !== "pending";
  const conversationRevealState =
    historyPhase === "unselected" ||
    (historyPhase === "ready" && isConversationScrollSettled)
      ? "revealed"
      : "measuring";

  return (
    <main className={styles.shell} data-layout={layout}>
      <div className={styles.frame} data-history-phase={historyPhase} style={frameStyle}>
        <div
          aria-hidden={conversationRevealState === "measuring" ? "true" : undefined}
          className={styles.conversationReveal}
          data-conversation-reveal-state={conversationRevealState}
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
            onLoadOlder={onLoadOlder}
            onScrollDebugChange={handleConversationScrollDebugChange}
            ref={conversationRef}
            messageFollowToken={messageFollowToken}
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
          pendingAttachments={pendingAttachments}
          placeholder={webModel.composer.placeholder}
          queuedInputs={queuedInputs}
          voiceInput={voiceInput}
        />
      </div>
    </main>
  );
}

"use client";

import type { CSSProperties } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { VelaClientStateStore } from "../../../../vela-chat-host-state/src";
import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../../vela-chat-render-model/src";
import { toWebChatModel } from "../../adapters/toWebBlocks";
import type { ComposerControlsModel } from "../composer-controls/model";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";
import { VelaComposer } from "../composer/VelaComposer";
import { VelaConversation } from "../conversation/VelaConversation";
import { RequestDock, type RequestDockResponse } from "../requests/RequestDock";
import { ConversationHistoryHydrationView } from "./ConversationHistoryHydrationView";
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
  historyPhase: "unselected" | "hydrating_history" | "ready";
  isLoadingOlder?: boolean;
  composerControls?: ComposerControlsModel;
  isUpdatingComposerControls?: boolean;
  isRespondingToRequest?: boolean;
  messageFollowToken?: number;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onLoadOlder?: () => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
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
  historyPhase,
  isLoadingOlder = false,
  composerControls,
  isUpdatingComposerControls = false,
  isRespondingToRequest = false,
  messageFollowToken,
  pendingAttachments,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onRespondToRequest,
  onStop,
  onSubmit,
}: ChatWorkbenchViewProps) {
  const webModel = useMemo(() => toWebChatModel(model), [model]);
  const conversationRef = useRef<ConversationViewportHandle | null>(null);
  const [composerHeight, setComposerHeight] = useState(154);
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

  if (historyPhase === "hydrating_history") {
    return (
      <main className={styles.shell}>
        <div className={styles.frame} style={frameWithoutTopbarStyle}>
          <ConversationHistoryHydrationView />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <div className={styles.frame} style={frameStyle}>
        <VelaConversation
          canLoadOlder={canLoadOlder}
          clientStateStore={clientStateStore}
          isLoadingOlder={isLoadingOlder}
          onLoadOlder={onLoadOlder}
          onScrollDebugChange={onConversationScrollDebugChange}
          ref={conversationRef}
          messageFollowToken={messageFollowToken}
          webModel={webModel}
        />
        <RequestDock
          requests={model.requests}
          isResponding={isRespondingToRequest}
          onRespondToRequest={onRespondToRequest}
        />
        {error ? <div className={styles.error}>{error}</div> : null}
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
          onStop={onStop}
          onSubmit={handleSubmit}
          pendingAttachments={pendingAttachments}
          placeholder={webModel.composer.placeholder}
        />
      </div>
    </main>
  );
}

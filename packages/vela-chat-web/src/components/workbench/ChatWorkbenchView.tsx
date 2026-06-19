"use client";

import type { CSSProperties } from "react";
import { useMemo } from "react";
import type { AgentConfigPatchWire } from "../../../../vela-chat-client/src";
import type { ChatRenderModel } from "../../../../vela-chat-render-model/src";
import { toWebChatModel } from "../../adapters/toWebBlocks";
import type { ComposerControlsModel } from "../composer-controls/model";
import type { PromptInputAttachment } from "../../primitives/prompt-input/PromptInput";
import { VelaComposer } from "../composer/VelaComposer";
import { VelaConversation } from "../conversation/VelaConversation";
import type { ConversationScrollControllerDebug } from "../../conversation-runtime/scroll/useConversationScrollController";
import styles from "../../styles/desktop.module.css";

const frameWithoutTopbarStyle = {
  gridTemplateRows: "minmax(0, 1fr)",
} satisfies CSSProperties;

export interface ChatWorkbenchViewProps {
  model: ChatRenderModel;
  draft: string;
  error?: string | null;
  canLoadOlder?: boolean;
  isLoadingOlder?: boolean;
  composerControls?: ComposerControlsModel;
  isUpdatingComposerControls?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onLoadOlder?: () => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onSubmit: () => void;
}

export function ChatWorkbenchView({
  model,
  draft,
  error,
  canLoadOlder = false,
  isLoadingOlder = false,
  composerControls,
  isUpdatingComposerControls = false,
  pendingAttachments,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onSubmit,
}: ChatWorkbenchViewProps) {
  const webModel = useMemo(() => toWebChatModel(model), [model]);

  return (
    <main className={styles.shell}>
      <div className={styles.frame} style={frameWithoutTopbarStyle}>
        <VelaConversation
          canLoadOlder={canLoadOlder}
          isLoadingOlder={isLoadingOlder}
          onLoadOlder={onLoadOlder}
          onScrollDebugChange={onConversationScrollDebugChange}
          webModel={webModel}
        />
        {error ? <div className={styles.error}>{error}</div> : null}
        <VelaComposer
          canSend={webModel.composer.canSend}
          controls={composerControls}
          draft={draft}
          isUpdatingControls={isUpdatingComposerControls}
          onAttachImages={onAttachImages}
          onAgentConfigChange={onAgentConfigChange}
          onDraftChange={onDraftChange}
          onRemoveAttachment={onRemoveAttachment}
          onSubmit={onSubmit}
          pendingAttachments={pendingAttachments}
          placeholder={webModel.composer.placeholder}
        />
      </div>
    </main>
  );
}

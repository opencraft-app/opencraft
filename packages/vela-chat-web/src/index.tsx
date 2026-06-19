import type { AgentConfigPatchWire } from "../../vela-chat-client/src";
import type { ChatRenderModel } from "../../vela-chat-render-model/src";
import type { ComposerControlsModel } from "./components/composer-controls/model";
import type { PromptInputAttachment } from "./primitives/prompt-input/PromptInput";
import type { ConversationScrollControllerDebug } from "./conversation-runtime/scroll/useConversationScrollController";
import { ChatWorkbenchView } from "./components/workbench/ChatWorkbenchView";

export interface VelaChatWebProps {
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
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onLoadOlder?: () => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onSubmit: () => void;
}

export function VelaChatWeb({
  model,
  draft,
  error,
  canLoadOlder,
  isLoadingOlder,
  composerControls,
  isUpdatingComposerControls,
  pendingAttachments,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onSubmit,
}: VelaChatWebProps) {
  return (
    <ChatWorkbenchView
      canLoadOlder={canLoadOlder}
      composerControls={composerControls}
      draft={draft}
      error={error}
      isLoadingOlder={isLoadingOlder}
      isUpdatingComposerControls={isUpdatingComposerControls}
      model={model}
      onAttachImages={onAttachImages}
      onAgentConfigChange={onAgentConfigChange}
      onConversationScrollDebugChange={onConversationScrollDebugChange}
      onDraftChange={onDraftChange}
      onLoadOlder={onLoadOlder}
      onRemoveAttachment={onRemoveAttachment}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
    />
  );
}

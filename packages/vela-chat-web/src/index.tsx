import type { AgentConfigPatchWire } from "../../vela-chat-client/src";
import type { ChatRenderModel } from "../../vela-chat-render-model/src";
import type { ComposerControlsModel } from "./components/composer-controls/model";
import type { RequestDockResponse } from "./components/requests/RequestDock";
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
  isRespondingToRequest?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onLoadOlder?: () => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRespondToRequest?: (response: RequestDockResponse) => void;
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
  isRespondingToRequest,
  pendingAttachments,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onRespondToRequest,
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
      isRespondingToRequest={isRespondingToRequest}
      model={model}
      onAttachImages={onAttachImages}
      onAgentConfigChange={onAgentConfigChange}
      onConversationScrollDebugChange={onConversationScrollDebugChange}
      onDraftChange={onDraftChange}
      onLoadOlder={onLoadOlder}
      onRemoveAttachment={onRemoveAttachment}
      onRespondToRequest={onRespondToRequest}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
    />
  );
}

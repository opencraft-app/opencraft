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
  messageFollowToken?: number;
  pendingAttachments?: PromptInputAttachment[];
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onLoadOlder?: () => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRespondToRequest?: (response: RequestDockResponse) => void;
  onStop?: () => void;
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
      messageFollowToken={messageFollowToken}
      model={model}
      onAttachImages={onAttachImages}
      onAgentConfigChange={onAgentConfigChange}
      onConversationScrollDebugChange={onConversationScrollDebugChange}
      onDraftChange={onDraftChange}
      onLoadOlder={onLoadOlder}
      onRemoveAttachment={onRemoveAttachment}
      onRespondToRequest={onRespondToRequest}
      onStop={onStop}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
    />
  );
}

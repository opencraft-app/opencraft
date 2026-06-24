import type { AgentConfigPatchWire } from "../../../vela-chat-client/src";
import type { VelaClientStateStore } from "../../../vela-chat-host-state/src";
import type { ChatRenderModel } from "../../../vela-chat-render-model/src";
import type { ComposerControlsModel } from "../components/composer-controls/model";
import type { RequestDockResponse } from "../components/requests/RequestDock";
import { ChatWorkbenchView } from "../components/workbench/ChatWorkbenchView";
import type { ConversationScrollControllerDebug } from "../conversation-runtime/scroll/useConversationScrollController";
import type { PromptInputAttachment } from "../primitives/prompt-input/PromptInput";

export interface ChatSurfaceProps {
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
  showScrollInspector?: boolean;
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

export function ChatSurface({
  model,
  draft,
  error,
  canLoadOlder,
  clientStateStore,
  layout = "viewport",
  historyPhase,
  isLoadingOlder,
  composerControls,
  isUpdatingComposerControls,
  isRespondingToRequest,
  messageFollowToken,
  pendingAttachments,
  showScrollInspector,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationScrollDebugChange,
  onLoadOlder,
  onRemoveAttachment,
  onRespondToRequest,
  onStop,
  onSubmit,
}: ChatSurfaceProps) {
  return (
    <ChatWorkbenchView
      canLoadOlder={canLoadOlder}
      clientStateStore={clientStateStore}
      composerControls={composerControls}
      draft={draft}
      error={error}
      historyPhase={historyPhase}
      layout={layout}
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
      showScrollInspector={showScrollInspector}
    />
  );
}

import type { AgentConfigPatchWire } from "../../../vela-chat-client/src";
import type {
  QueuedComposerInputClientState,
  VelaClientStateStore,
} from "../../../vela-chat-host-state/src";
import type { ChatRenderModel } from "../../../vela-chat-render-model/src";
import type { VoiceInputHost } from "../../../vela-desktop-shell/src";
import type { ComposerControlsModel } from "../components/composer-controls/model";
import type { RequestDockResponse } from "../components/requests/RequestDock";
import {
  ChatWorkbenchView,
  type ConversationRevealStateEvent,
} from "../components/workbench/ChatWorkbenchView";
import type { ConversationScrollControllerDebug } from "../conversation-runtime/scroll/useConversationScrollController";
import type { ConversationScrollLifecycleEvent } from "../conversation-runtime/scroll/useConversationScrollController";
import type { PromptInputAttachment } from "../primitives/prompt-input/PromptInput";

export type { ConversationScrollLifecycleEvent } from "../conversation-runtime/scroll/useConversationScrollController";
export type { ConversationScrollControllerDebug } from "../conversation-runtime/scroll/useConversationScrollController";
export type { ConversationRevealStateEvent } from "../components/workbench/ChatWorkbenchView";

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
  followOutputToken?: number;
  isUpdatingComposerControls?: boolean;
  isRespondingToRequest?: boolean;
  pendingAttachments?: PromptInputAttachment[];
  queuedInputs?: QueuedComposerInputClientState[];
  showScrollInspector?: boolean;
  voiceInput?: VoiceInputHost;
  onDraftChange: (value: string) => void;
  onAttachImages?: (files: File[]) => void;
  onAgentConfigChange?: (patch: AgentConfigPatchWire) => void;
  onConversationRevealStateChange?: (event: ConversationRevealStateEvent) => void;
  onConversationScrollDebugChange?: (debug: ConversationScrollControllerDebug) => void;
  onConversationScrollLifecycleEvent?: (event: ConversationScrollLifecycleEvent) => void;
  onLoadOlder?: () => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onRemoveQueuedInput?: (queuedInputId: string) => void;
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
  followOutputToken,
  isUpdatingComposerControls,
  isRespondingToRequest,
  pendingAttachments,
  queuedInputs,
  showScrollInspector,
  voiceInput,
  onDraftChange,
  onAttachImages,
  onAgentConfigChange,
  onConversationRevealStateChange,
  onConversationScrollDebugChange,
  onConversationScrollLifecycleEvent,
  onLoadOlder,
  onRemoveAttachment,
  onRemoveQueuedInput,
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
      followOutputToken={followOutputToken}
      historyPhase={historyPhase}
      layout={layout}
      isLoadingOlder={isLoadingOlder}
      isUpdatingComposerControls={isUpdatingComposerControls}
      isRespondingToRequest={isRespondingToRequest}
      model={model}
      onAttachImages={onAttachImages}
      onAgentConfigChange={onAgentConfigChange}
      onConversationRevealStateChange={onConversationRevealStateChange}
      onConversationScrollDebugChange={onConversationScrollDebugChange}
      onConversationScrollLifecycleEvent={onConversationScrollLifecycleEvent}
      onDraftChange={onDraftChange}
      onLoadOlder={onLoadOlder}
      onRemoveAttachment={onRemoveAttachment}
      onRemoveQueuedInput={onRemoveQueuedInput}
      onRespondToRequest={onRespondToRequest}
      onStop={onStop}
      onSubmit={onSubmit}
      pendingAttachments={pendingAttachments}
      queuedInputs={queuedInputs}
      showScrollInspector={showScrollInspector}
      voiceInput={voiceInput}
    />
  );
}

"use client";

import { useMemo } from "react";
import {
  createVeladClient,
  type VeladClient,
} from "../../vela-chat-client/src";
import {
  DEFAULT_VELAD_BASE_URL,
  useVelaChatSession,
  type VelaConversationHistoryPolicy,
} from "../../vela-chat-controller/src";
import {
  createBrowserVelaClientStateStore,
  type VelaClientStateStore,
} from "../../vela-chat-host-state/src";
import { VelaChatWeb } from "../../vela-chat-web/src";

export interface VelaNextChatProps {
  sessionId: string;
  baseUrl?: string;
  client?: VeladClient;
  clientStateStore?: VelaClientStateStore | null;
  fetchBackends?: boolean;
  historyPolicy?: VelaConversationHistoryPolicy;
  hostId?: string;
}

export function VelaNextChat({
  sessionId,
  baseUrl = DEFAULT_VELAD_BASE_URL,
  client,
  clientStateStore,
  fetchBackends = true,
  historyPolicy,
  hostId = "next",
}: VelaNextChatProps) {
  const defaultClient = useMemo(() => createVeladClient({ baseUrl }), [baseUrl]);
  const resolvedClient = client ?? defaultClient;
  const browserClientStateStore = useMemo(() => {
    if (clientStateStore !== undefined) return clientStateStore;
    return createBrowserVelaClientStateStore({ hostId });
  }, [clientStateStore, hostId]);
  const controller = useVelaChatSession({
    baseUrl,
    client: resolvedClient,
    clientStateStore: browserClientStateStore,
    fetchBackends,
    historyPolicy,
    sessionId,
  });

  return (
    <VelaChatWeb
      canLoadOlder={controller.canLoadOlder}
      clientStateStore={browserClientStateStore}
      composerControls={controller.composerControls}
      draft={controller.draft}
      error={controller.error}
      historyPhase={controller.historyPhase}
      isLoadingOlder={controller.isLoadingOlder}
      isRespondingToRequest={controller.isRespondingToRequest}
      isUpdatingComposerControls={controller.isUpdatingAgentConfig}
      layout="contained"
      messageFollowToken={controller.messageFollowToken}
      model={controller.model}
      onAgentConfigChange={controller.updateAgentConfig}
      onAttachImages={controller.attachImages}
      onConversationScrollDebugChange={controller.setConversationScrollDebug}
      onDraftChange={controller.setDraft}
      onLoadOlder={controller.loadOlderConversation}
      onRemoveAttachment={controller.removeAttachment}
      onRespondToRequest={controller.respondToRequest}
      onStop={controller.stop}
      onSubmit={controller.send}
      pendingAttachments={controller.pendingAttachments}
    />
  );
}

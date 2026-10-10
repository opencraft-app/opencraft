import type { AppServerNotification } from "@opencraft/appserver-protocol";

export interface EmbeddedWorkbenchTurnCompletedDetail {
  readonly chatId: string;
  readonly turnId: string;
}

export function embeddedTurnCompletionDetail(
  notification: AppServerNotification,
): EmbeddedWorkbenchTurnCompletedDetail | null {
  if (notification.method !== "turn/completed") return null;
  const params = notification.params as { threadId?: unknown; turn?: { id?: unknown; status?: unknown } } | null;
  if (typeof params?.threadId !== "string" || typeof params.turn?.id !== "string") return null;
  if (params.turn.status !== "completed" && params.turn.status !== "failed") return null;
  return { chatId: params.threadId, turnId: params.turn.id };
}

interface NotificationClient {
  subscribeNotification(listener: (notification: AppServerNotification) => void): () => void;
}

interface NotificationClientRegistry {
  get(hostId: string): NotificationClient | null;
  subscribeEvent(listener: (event: { readonly hostId: string }) => void): () => void;
}

export function observeEmbeddedTurnCompletions(
  clients: NotificationClientRegistry,
  hostId: string,
  onCompleted: (detail: EmbeddedWorkbenchTurnCompletedDetail) => void,
): () => void {
  let stopClient: (() => void) | null = null;
  const attachClient = () => {
    stopClient?.();
    stopClient = clients.get(hostId)?.subscribeNotification((notification) => {
      const detail = embeddedTurnCompletionDetail(notification);
      if (detail !== null) onCompleted(detail);
    }) ?? null;
  };
  const stopRegistry = clients.subscribeEvent((event) => {
    if (event.hostId === hostId) attachClient();
  });
  attachClient();
  return () => { stopRegistry(); stopClient?.(); };
}

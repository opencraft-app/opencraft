import {
  isVelaStreamEventForSession,
  streamReadModelRefreshPlanForCursors,
  type ConversationWireView,
  type PendingRequestsWireView,
  type StreamRefreshScheduler,
  type VelaStreamEventWire,
} from "../../../packages/vela-chat-client/src";

export function handleWorkbenchStreamEvent({
  activeSessionId,
  streamEvent,
  currentConversation,
  currentRequests,
  conversationRefreshScheduler,
  forceConversationRefresh,
  requestsRefreshScheduler,
  sessionRefreshScheduler,
  backendsRefreshScheduler,
}: {
  activeSessionId: string;
  streamEvent: VelaStreamEventWire;
  currentConversation: ConversationWireView | null;
  currentRequests: PendingRequestsWireView | null;
  conversationRefreshScheduler: StreamRefreshScheduler;
  forceConversationRefresh: boolean;
  requestsRefreshScheduler: StreamRefreshScheduler;
  sessionRefreshScheduler: StreamRefreshScheduler;
  backendsRefreshScheduler: StreamRefreshScheduler;
}) {
  if (!isVelaStreamEventForSession(activeSessionId, streamEvent)) return;

  const refreshPlan = streamReadModelRefreshPlanForCursors(streamEvent, {
    conversation: currentConversation?.cursor,
    requests: currentRequests?.cursor,
  });
  if (forceConversationRefresh) conversationRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.conversation) conversationRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.requests) requestsRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.session) sessionRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.backends) backendsRefreshScheduler.notifyStreamEvent();
}

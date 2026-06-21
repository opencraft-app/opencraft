import {
  applyTranscriptLiveOverlay,
  isVelaStreamEventForSession,
  needsTranscriptRefreshAfterLiveOverlay,
  streamReadModelRefreshPlanForCursors,
  type ActivityWireView,
  type ChatTranscriptWireView,
  type PendingRequestsWireView,
  type StreamRefreshScheduler,
  type VelaStreamEventWire,
} from "../../../packages/vela-chat-client/src";

export function handleWorkbenchStreamEvent({
  activeSessionId,
  streamEvent,
  currentTranscript,
  currentActivity,
  currentRequests,
  commitTranscript,
  transcriptRefreshScheduler,
  activityRefreshScheduler,
  requestsRefreshScheduler,
  sessionRefreshScheduler,
  backendsRefreshScheduler,
}: {
  activeSessionId: string;
  streamEvent: VelaStreamEventWire;
  currentTranscript: ChatTranscriptWireView | null;
  currentActivity: ActivityWireView | null;
  currentRequests: PendingRequestsWireView | null;
  commitTranscript: (nextTranscript: ChatTranscriptWireView) => void;
  transcriptRefreshScheduler: StreamRefreshScheduler;
  activityRefreshScheduler: StreamRefreshScheduler;
  requestsRefreshScheduler: StreamRefreshScheduler;
  sessionRefreshScheduler: StreamRefreshScheduler;
  backendsRefreshScheduler: StreamRefreshScheduler;
}) {
  if (!isVelaStreamEventForSession(activeSessionId, streamEvent)) return;

  const forceTranscriptRefresh = currentTranscript
    ? needsTranscriptRefreshAfterLiveOverlay(currentTranscript, streamEvent)
    : false;
  if (currentTranscript) {
    commitTranscript(applyTranscriptLiveOverlay(currentTranscript, streamEvent));
  }
  const refreshPlan = streamReadModelRefreshPlanForCursors(streamEvent, {
    transcript: currentTranscript?.cursor,
    activity: currentActivity?.cursor,
    requests: currentRequests?.cursor,
  });
  if (forceTranscriptRefresh) transcriptRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.transcript) transcriptRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.activity) activityRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.requests) requestsRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.session) sessionRefreshScheduler.notifyStreamEvent();
  if (refreshPlan.backends) backendsRefreshScheduler.notifyStreamEvent();
}

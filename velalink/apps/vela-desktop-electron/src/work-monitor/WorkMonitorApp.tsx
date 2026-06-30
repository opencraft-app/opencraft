import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
  resolveVeladFetch,
} from "../../../../packages/vela-chat-client/src";
import { useVelaChatSession } from "../../../../packages/vela-chat-controller/src";
import { type ChatHostPolicy } from "../../../../packages/vela-chat-render-model/src";
import type { ConversationScrollControllerDebug } from "../../../../packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController";
import { VelaLocalTracer } from "../../../../packages/vela-observability-client/src";
import { type RuntimeHostInfo } from "../desktopBridge";
import {
  SessionPreviewStatus,
  SessionPreviewWindowContent,
} from "../session-preview";
import { useWorkMonitorInteraction } from "./work-monitor-interaction";

const WORK_MONITOR_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;

export interface WorkMonitorAppProps {
  hostInfo: RuntimeHostInfo;
  sessionId: string;
}

export function WorkMonitorApp({ hostInfo, sessionId }: WorkMonitorAppProps) {
  const scrollDebugSignatureRef = useRef<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState(sessionId);
  const interaction = useWorkMonitorInteraction();
  const observability = useMemo(
    () =>
      new VelaLocalTracer({
        endpoint: hostInfo.otelBaseUrl,
        serviceName: "vela-desktop-work-monitor",
        tracerName: "vela.work_monitor",
      }),
    [hostInfo.otelBaseUrl],
  );
  const veladFetch = useMemo(() => resolveVeladFetch(), []);
  const client = useMemo(
    () => createVeladClient({ baseUrl: hostInfo.apiBaseUrl, fetch: veladFetch, observability }),
    [hostInfo.apiBaseUrl, observability, veladFetch],
  );
  const eventStreamTransport = useMemo(
    () => createFetchVelaEventStreamTransport(veladFetch, { observability }),
    [observability, veladFetch],
  );
  useEffect(() => {
    let cancelled = false;
    setSessionTitle(sessionId);
    void client.getSession(sessionId).then(
      ({ session }) => {
        if (!cancelled) setSessionTitle(session.title.trim() || sessionId);
      },
      () => {
        if (!cancelled) setSessionTitle(sessionId);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sessionId]);
  const controller = useVelaChatSession({
    client,
    baseUrl: hostInfo.apiBaseUrl,
    eventStreamTransport,
    fetchBackends: false,
    historyPolicy: "tail_only",
    hostPolicy: WORK_MONITOR_HOST_POLICY,
    observability,
    sessionId,
  });
  const followOutputToken = controller.followOutputToken;
  const setConversationScrollDebug = controller.setConversationScrollDebug;
  const handleConversationScrollDebugChange = useCallback(
    (debug: ConversationScrollControllerDebug) => {
      setConversationScrollDebug(debug);
      const signature = workMonitorScrollDebugSignature(debug, followOutputToken);
      if (scrollDebugSignatureRef.current === signature) return;
      scrollDebugSignatureRef.current = signature;
      void observability.emitLog({
        attributes: {
          "vela.follow_output.token": followOutputToken,
          "vela.session_id": sessionId,
          "vela.work_monitor.bottom_anchor.mode": debug.bottomAnchorMode,
          "vela.work_monitor.bottom_anchor.blocked_reason":
            debug.bottomAnchorBlockedReason ?? "",
          "vela.work_monitor.bottom_anchor.pending_reason":
            debug.bottomAnchorPendingReason ?? "",
          "vela.work_monitor.bottom_anchor.last_fulfilled_reason":
            debug.bottomAnchorLastFulfilledReason ?? "",
          "vela.work_monitor.follow_output": debug.followOutput,
          "vela.work_monitor.route_resume_status": debug.routeResumeStatus,
        },
        body: "work monitor conversation scroll debug changed",
        severityText: "INFO",
      });
    },
    [followOutputToken, observability, sessionId, setConversationScrollDebug],
  );
  return (
    controller.error ? (
      <SessionPreviewStatus
        isCloseVisible={interaction.isCloseVisible}
        isDragging={interaction.isDragging}
        label="Monitor failed"
        value={controller.error}
        onCloseMonitor={interaction.onClose}
        {...interaction.interactionProps}
      />
    ) : (
      <SessionPreviewWindowContent
        followOutputToken={followOutputToken}
        isCloseVisible={interaction.isCloseVisible}
        isDragging={interaction.isDragging}
        model={controller.model}
        title={sessionTitle}
        onConversationScrollDebugChange={handleConversationScrollDebugChange}
        onCloseMonitor={interaction.onClose}
        {...interaction.interactionProps}
      />
    )
  );
}

function workMonitorScrollDebugSignature(
  debug: ConversationScrollControllerDebug,
  followOutputToken: number,
) {
  return [
    followOutputToken,
    debug.followOutput,
    debug.bottomAnchorMode,
    debug.bottomAnchorBlockedReason ?? "",
    debug.bottomAnchorPendingReason ?? "",
    debug.bottomAnchorLastFulfilledReason ?? "",
    debug.routeResumeStatus,
    debug.routeResumeScrollTop ?? "",
    debug.lastScrollWrite?.reason ?? "",
    debug.lastScrollWrite?.nextScrollTop ?? "",
  ].join("|");
}

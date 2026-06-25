import { useMemo, useRef, type PointerEvent } from "react";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
} from "../../../../packages/vela-chat-client/src";
import { useVelaChatSession } from "../../../../packages/vela-chat-controller/src";
import { type ChatHostPolicy } from "../../../../packages/vela-chat-render-model/src";
import { ConversationPreviewSurface } from "../../../../packages/vela-chat-web/src";
import { VelaLocalTracer } from "../../../../packages/vela-observability-client/src";
import {
  focusDesktopSession,
  moveWorkMonitorBy,
  type RuntimeHostInfo,
} from "../desktopBridge";
import styles from "./work-monitor.module.css";

const WORK_MONITOR_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;
const WORK_MONITOR_DRAG_THRESHOLD_PX = 4;

interface DragState {
  lastScreenX: number;
  lastScreenY: number;
  originScreenX: number;
  originScreenY: number;
  pointerId: number;
}

export interface WorkMonitorAppProps {
  hostInfo: RuntimeHostInfo;
  sessionId: string;
}

export function WorkMonitorApp({ hostInfo, sessionId }: WorkMonitorAppProps) {
  const dragStateRef = useRef<DragState | null>(null);
  const suppressNextOpenRef = useRef(false);
  const observability = useMemo(
    () =>
      new VelaLocalTracer({
        endpoint: hostInfo.otelBaseUrl,
        serviceName: "vela-desktop-work-monitor",
        tracerName: "vela.work_monitor",
      }),
    [hostInfo.otelBaseUrl],
  );
  const client = useMemo(
    () => createVeladClient({ baseUrl: hostInfo.apiBaseUrl, observability }),
    [hostInfo.apiBaseUrl, observability],
  );
  const eventStreamTransport = useMemo(
    () => createFetchVelaEventStreamTransport(fetch, { observability }),
    [observability],
  );
  const controller = useVelaChatSession({
    client,
    baseUrl: hostInfo.apiBaseUrl,
    eventStreamTransport,
    fetchBackends: false,
    historyPolicy: "tail_only",
    hostPolicy: WORK_MONITOR_HOST_POLICY,
    sessionId,
  });
  const openSession = () => {
    void focusDesktopSession(sessionId);
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStateRef.current = {
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      originScreenX: event.screenX,
      originScreenY: event.screenY,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.screenX - dragState.lastScreenX;
    const deltaY = event.screenY - dragState.lastScreenY;
    if (deltaX === 0 && deltaY === 0) return;

    const totalDistance = Math.hypot(
      event.screenX - dragState.originScreenX,
      event.screenY - dragState.originScreenY,
    );
    if (totalDistance >= WORK_MONITOR_DRAG_THRESHOLD_PX) {
      suppressNextOpenRef.current = true;
      void moveWorkMonitorBy(deltaX, deltaY);
      event.preventDefault();
    }

    dragState.lastScreenX = event.screenX;
    dragState.lastScreenY = event.screenY;
  };
  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (suppressNextOpenRef.current) {
      window.setTimeout(() => {
        suppressNextOpenRef.current = false;
      }, 200);
    }
  };
  const handleOpenClick = () => {
    if (suppressNextOpenRef.current) {
      suppressNextOpenRef.current = false;
      return;
    }
    openSession();
  };

  return (
    <main className={styles.workMonitorApp}>
      {controller.error ? (
        <button
          className={styles.workMonitorError}
          type="button"
          onClick={handleOpenClick}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
        >
          <span>Monitor failed</span>
          <strong>{controller.error}</strong>
        </button>
      ) : (
        <ConversationPreviewSurface
          model={controller.model}
          scale={0.25}
          onOpenSession={handleOpenClick}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
        />
      )}
    </main>
  );
}

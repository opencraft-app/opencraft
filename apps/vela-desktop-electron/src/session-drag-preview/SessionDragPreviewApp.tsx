import { useEffect, useMemo, useState } from "react";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
  resolveVeladFetch,
} from "../../../../packages/vela-chat-client/src";
import { useVelaChatSession } from "../../../../packages/vela-chat-controller/src";
import { type ChatHostPolicy } from "../../../../packages/vela-chat-render-model/src";
import { VelaLocalTracer } from "../../../../packages/vela-observability-client/src";
import type { RuntimeHostInfo } from "../desktopBridge";
import {
  SessionPreviewStatus,
  SessionPreviewWindowContent,
} from "../session-preview";

const SESSION_DRAG_PREVIEW_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;

export interface SessionDragPreviewAppProps {
  hostInfo: RuntimeHostInfo;
  sessionId: string;
}

export function SessionDragPreviewApp({ hostInfo, sessionId }: SessionDragPreviewAppProps) {
  const [sessionTitle, setSessionTitle] = useState(sessionId);
  const observability = useMemo(
    () =>
      new VelaLocalTracer({
        endpoint: hostInfo.otelBaseUrl,
        serviceName: "vela-desktop-session-drag-preview",
        tracerName: "vela.session_drag_preview",
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
    hostPolicy: SESSION_DRAG_PREVIEW_HOST_POLICY,
    observability,
    sessionId,
  });

  return (
    controller.error ? (
      <SessionPreviewStatus
        label="Preview failed"
        role="alert"
        value={controller.error}
      />
    ) : (
      <SessionPreviewWindowContent
        followOutputToken={controller.followOutputToken}
        model={controller.model}
        title={sessionTitle}
      />
    )
  );
}

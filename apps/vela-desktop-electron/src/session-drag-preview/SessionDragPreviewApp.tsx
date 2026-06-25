import { useMemo } from "react";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
  resolveVeladFetch,
} from "../../../../packages/vela-chat-client/src";
import { useVelaChatSession } from "../../../../packages/vela-chat-controller/src";
import { type ChatHostPolicy } from "../../../../packages/vela-chat-render-model/src";
import { ConversationPreviewSurface } from "../../../../packages/vela-chat-web/src";
import { VelaLocalTracer } from "../../../../packages/vela-observability-client/src";
import type { RuntimeHostInfo } from "../desktopBridge";
import styles from "./session-drag-preview.module.css";

const SESSION_DRAG_PREVIEW_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;

export interface SessionDragPreviewAppProps {
  hostInfo: RuntimeHostInfo;
  sessionId: string;
}

export function SessionDragPreviewApp({ hostInfo, sessionId }: SessionDragPreviewAppProps) {
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
    <main className={styles.sessionDragPreviewApp}>
      {controller.error ? (
        <div className={styles.sessionDragPreviewStatus} role="alert">
          <span>Preview failed</span>
          <strong>{controller.error}</strong>
        </div>
      ) : (
        <ConversationPreviewSurface
          followOutputToken={controller.followOutputToken}
          model={controller.model}
          scale={0.34}
        />
      )}
    </main>
  );
}

import type {
  VeladClient,
  VelaEventStreamSubscription,
  VelaEventStreamTransport,
  VelaStreamEventWire,
} from "../../vela-chat-client/src";

const VELA_SESSION_STREAM_LOG_PREFIX = "[vela-session-stream]";

const stringifyLogPayload = (payload: unknown) => {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      stringify_error: error instanceof Error ? error.message : String(error),
    });
  }
};

export interface RecoveringSessionEventStreamOptions {
  client: VeladClient;
  eventStreamTransport: VelaEventStreamTransport;
  getAfterId: () => string | null;
  onConnectedChange: (connected: boolean) => void;
  onEvent: (event: VelaStreamEventWire) => void;
  sessionId: string;
}

export interface RecoveringSessionEventStream {
  close: () => void;
}

export function subscribeRecoveringSessionEventStream({
  client,
  eventStreamTransport,
  getAfterId,
  onConnectedChange,
  onEvent,
  sessionId,
}: RecoveringSessionEventStreamOptions): RecoveringSessionEventStream {
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | "microtask" | null = null;
  let subscription: VelaEventStreamSubscription | null = null;

  const log = (event: string, context: Record<string, unknown> = {}, error?: unknown) => {
    console.log(`${VELA_SESSION_STREAM_LOG_PREFIX} ${event}`, stringifyLogPayload({
      context: {
        reconnectAttempt,
        sessionId,
        ...context,
      },
      error:
        error instanceof Error
          ? {
              cause: error.cause,
              message: error.message,
              name: error.name,
              stack: error.stack,
            }
          : error === undefined
            ? null
            : { message: String(error) },
    }));
  };

  const closeCurrentSubscription = () => {
    subscription?.close();
    subscription = null;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    onConnectedChange(false);
    closeCurrentSubscription();
    const delayMs = eventStreamReconnectDelayMs(reconnectAttempt);
    log("reconnect scheduled", {
      afterId: getAfterId(),
      delayMs,
    });
    reconnectAttempt += 1;
    const reconnect = () => {
      reconnectTimer = null;
      connect();
    };
    if (delayMs === 0) {
      reconnectTimer = "microtask";
      queueMicrotask(reconnect);
    } else {
      reconnectTimer = setTimeout(reconnect, delayMs);
    }
  };

  const handleEvent = (event: VelaStreamEventWire) => {
    reconnectAttempt = 0;
    onEvent(event);
  };

  const connect = () => {
    if (disposed) return;
    closeCurrentSubscription();
    const url = client.sessionEventStreamUrl(sessionId, getAfterId());
    try {
      log("subscribing", {
        afterId: url.searchParams.get("after_id"),
        pathname: url.pathname,
      });
      subscription = eventStreamTransport.subscribe(url, {
        onClose: scheduleReconnect,
        onError: (error) => {
          log("stream error", {
            afterId: url.searchParams.get("after_id"),
            pathname: url.pathname,
          }, error);
          scheduleReconnect();
        },
        onEvent: handleEvent,
        onOpen: () => {
          log("stream open", {
            afterId: url.searchParams.get("after_id"),
            pathname: url.pathname,
          });
          onConnectedChange(true);
        },
      });
    } catch (error) {
      log("subscribe threw", {
        afterId: url.searchParams.get("after_id"),
        pathname: url.pathname,
      }, error);
      scheduleReconnect();
    }
  };

  connect();

  return {
    close() {
      disposed = true;
      if (reconnectTimer && reconnectTimer !== "microtask") {
        clearTimeout(reconnectTimer);
      }
      closeCurrentSubscription();
      onConnectedChange(false);
    },
  };
}

export function eventStreamReconnectDelayMs(attempt: number) {
  if (attempt <= 0) return 0;
  return Math.min(5000, 250 * 2 ** Math.min(attempt - 1, 5));
}

import type {
  VeladClient,
  VelaEventStreamSubscription,
  VelaEventStreamTransport,
  VelaStreamEventWire,
} from "../../vela-chat-client/src";

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

  const closeCurrentSubscription = () => {
    subscription?.close();
    subscription = null;
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    onConnectedChange(false);
    closeCurrentSubscription();
    const delayMs = eventStreamReconnectDelayMs(reconnectAttempt);
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
      subscription = eventStreamTransport.subscribe(url, {
        onClose: scheduleReconnect,
        onError: scheduleReconnect,
        onEvent: handleEvent,
        onOpen: () => onConnectedChange(true),
      });
    } catch {
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

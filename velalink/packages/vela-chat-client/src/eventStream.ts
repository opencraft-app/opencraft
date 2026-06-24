import { createSseJsonFrameParser, type SseJsonFrame } from "./sse";
import {
  readVelaStreamEvent,
  readVelaStreamEventData,
  subscribeVelaEventSource,
} from "./stream";
import type { VelaStreamEventWire } from "./wire";

export interface VelaEventStreamHandlers {
  onEvent: (event: VelaStreamEventWire) => void;
  onClose?: () => void;
  onOpen?: () => void;
  onError?: (error?: unknown) => void;
}

export interface VelaEventStreamSubscription {
  close: () => void;
}

export interface VelaEventStreamTransport {
  subscribe: (
    url: URL,
    handlers: VelaEventStreamHandlers,
  ) => VelaEventStreamSubscription;
}

export function createBrowserVelaEventStreamTransport(): VelaEventStreamTransport {
  return {
    subscribe(url, handlers) {
      const EventSourceCtor = globalThis.EventSource;
      if (!EventSourceCtor) {
        throw new Error("EventSource is not available in this runtime");
      }

      const source = new EventSourceCtor(url);
      const unsubscribe = subscribeVelaEventSource(source, {
        onOpen: () => handlers.onOpen?.(),
        onError: (event) => handlers.onError?.(event),
        onEvent: (event) => {
          const streamEvent = readVelaStreamEvent(event);
          if (streamEvent) handlers.onEvent(streamEvent);
        },
      });

      return {
        close() {
          unsubscribe();
          source.close();
        },
      };
    },
  };
}

export function createFetchVelaEventStreamTransport(
  doFetch: typeof fetch,
): VelaEventStreamTransport {
  return {
    subscribe(url, handlers) {
      const controller = new AbortController();
      let closed = false;

      void readFetchEventStream({
        doFetch,
        handlers,
        isClosed: () => closed,
        signal: controller.signal,
        url,
      });

      return {
        close() {
          closed = true;
          controller.abort();
        },
      };
    },
  };
}

interface ReadFetchEventStreamInput {
  doFetch: typeof fetch;
  handlers: VelaEventStreamHandlers;
  isClosed: () => boolean;
  signal: AbortSignal;
  url: URL;
}

async function readFetchEventStream({
  doFetch,
  handlers,
  isClosed,
  signal,
  url,
}: ReadFetchEventStreamInput) {
  const parser = createSseJsonFrameParser();
  try {
    const response = await doFetch(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (isClosed()) return;
    if (!response.ok) {
      throw new Error(`velad event stream failed with HTTP ${response.status}`);
    }

    handlers.onOpen?.();

    if (!response.body) {
      emitFrames(parser.push(await response.text()), handlers);
      emitFrames(parser.finish(), handlers);
      if (!isClosed()) {
        handlers.onClose?.();
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();
      if (isClosed()) return;
      if (done) break;
      emitFrames(parser.push(decoder.decode(value, { stream: true })), handlers);
    }

    const tail = decoder.decode();
    if (tail) emitFrames(parser.push(tail), handlers);
    emitFrames(parser.finish(), handlers);
    if (!isClosed()) {
      handlers.onClose?.();
    }
  } catch (error) {
    if (!isClosed() && !isAbortError(error)) {
      handlers.onError?.(error);
    }
  }
}

function emitFrames(frames: SseJsonFrame[], handlers: VelaEventStreamHandlers) {
  for (const frame of frames) {
    const streamEvent = readVelaStreamEventData(frame.data, frame.event);
    if (streamEvent) handlers.onEvent(streamEvent);
  }
}

function isAbortError(error: unknown) {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

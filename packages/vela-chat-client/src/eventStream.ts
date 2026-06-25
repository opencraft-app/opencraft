import { createSseJsonFrameParser, type SseJsonFrame } from "./sse";
import {
  readVelaStreamEvent,
  readVelaStreamEventData,
  subscribeVelaEventSource,
} from "./stream";
import { resolveVeladFetch } from "./veladFetch";
import type {
  VelaStreamEventWire,
  VeladFetch,
  VeladClientObservability,
  VeladObservedSpan,
} from "./wire";

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

export type VelaEventStreamObservability = VeladClientObservability;

export interface VelaEventStreamTransportOptions {
  observability?: VelaEventStreamObservability;
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
  doFetch: VeladFetch,
  options: VelaEventStreamTransportOptions = {},
): VelaEventStreamTransport {
  const resolvedFetch = resolveVeladFetch(doFetch);
  return {
    subscribe(url, handlers) {
      const controller = new AbortController();
      let closed = false;
      const span = options.observability?.startSpan("velad.session.events.stream", {
        attributes: {
          "http.method": "GET",
          "http.url": url.toString(),
        },
      });

      void readFetchEventStream({
        doFetch: resolvedFetch,
        handlers,
        isClosed: () => closed,
        observability: options.observability,
        span,
        signal: controller.signal,
        url,
      });

      return {
        close() {
          closed = true;
          span?.setAttribute("velad.stream.closed_by_client", true);
          span?.setStatus({ code: 1 });
          span?.end();
          controller.abort();
        },
      };
    },
  };
}

interface ReadFetchEventStreamInput {
  doFetch: VeladFetch;
  handlers: VelaEventStreamHandlers;
  isClosed: () => boolean;
  observability?: VelaEventStreamObservability;
  span?: VeladObservedSpan;
  signal: AbortSignal;
  url: URL;
}

async function readFetchEventStream({
  doFetch,
  handlers,
  isClosed,
  observability,
  span,
  signal,
  url,
}: ReadFetchEventStreamInput) {
  const parser = createSseJsonFrameParser();
  try {
    const headers = new Headers({ Accept: "text/event-stream" });
    if (span && observability) {
      headers.set("traceparent", observability.traceparent(span));
    }
    const response = await doFetch(url, {
      headers,
      signal,
    });
    if (isClosed()) return;
    span?.setAttribute("http.status_code", response.status);
    if (!response.ok) {
      throw new Error(`velad event stream failed with HTTP ${response.status}`);
    }

    handlers.onOpen?.();

    if (!response.body) {
      emitFrames(parser.push(await response.text()), handlers);
      emitFrames(parser.finish(), handlers);
      if (!isClosed()) {
        span?.setStatus({ code: 1 });
        span?.end();
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
      span?.setStatus({ code: 1 });
      span?.end();
      handlers.onClose?.();
    }
  } catch (error) {
    if (!isClosed() && !isAbortError(error)) {
      if (span && observability) {
        observability.recordError(span, error);
        void observability.emitLog?.({
          severityText: "ERROR",
          body: errorMessage(error),
          span,
          attributes: {
            "http.method": "GET",
            "http.url": url.toString(),
            "vela.operation": "velad.session.events.stream",
          },
        });
        span.end();
      }
      handlers.onError?.(error);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

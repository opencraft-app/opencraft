import type { TestWebSocket, WorkerRuntime } from "./worker-runtime.ts";

/** Polls `read` until `done`, scaled by the runtime's patience; returns the last value. */
export async function until<T>(
  runtime: Pick<WorkerRuntime, "patience">,
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs * runtime.patience;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type MessageListener = (event: { data: string | ArrayBuffer }) => void;
type CloseListener = (event: { code: number; reason: string }) => void;
interface RawSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

/**
 * Wraps an accepted socket so no frame or close is lost between the upgrade
 * resolving and the scenario attaching its listeners: events are queued until
 * the first listener of their type arrives.
 */
export function bufferedSocket(raw: RawSocket): TestWebSocket {
  const messages: MessageListener[] = [];
  const closes: CloseListener[] = [];
  const pendingMessages: { data: string | ArrayBuffer }[] = [];
  let pendingClose: { code: number; reason: string } | undefined;
  raw.addEventListener("message", (event: { data: unknown }) => {
    const data =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? event.data
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength).slice().buffer
            : String(event.data);
    if (messages.length) for (const listener of messages) listener({ data });
    else pendingMessages.push({ data });
  });
  raw.addEventListener("close", (event: { code: number; reason: string }) => {
    const close = { code: event.code, reason: event.reason };
    if (closes.length) for (const listener of closes) listener(close);
    else pendingClose = close;
  });
  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    addEventListener(type: "message" | "close", listener: MessageListener | CloseListener) {
      if (type === "message") {
        messages.push(listener as MessageListener);
        for (const event of pendingMessages.splice(0)) (listener as MessageListener)(event);
      } else {
        closes.push(listener as CloseListener);
        if (pendingClose) {
          const close = pendingClose;
          pendingClose = undefined;
          (listener as CloseListener)(close);
        }
      }
    },
  } as TestWebSocket;
}

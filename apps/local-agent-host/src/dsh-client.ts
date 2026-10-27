import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export interface DshEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

export interface DshHistoryEntry {
  readonly event: DshEvent;
  readonly view?: unknown;
}

export interface DshStreamEnvelope {
  readonly rpcId?: string;
  readonly payload: Record<string, unknown>;
}

interface DshResponseEnvelope {
  readonly result?: {
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: { readonly code?: string; readonly message?: string; readonly retryable?: boolean };
  };
}

export class DshClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DshClientError";
  }
}

export class DshClient {
  constructor(public baseUrl: string, private readonly requestTimeoutMs = 30_000) {}

  async respond(rpcId: string, result: unknown): Promise<{ accepted: boolean; reason?: string }> {
    const response = await fetch(new URL("/api/respond", this.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DshClientError("DSH_HTTP_ERROR", `respond failed with HTTP ${response.status}`);
    return await response.json() as { accepted: boolean; reason?: string };
  }

  async call<TResult>(
    method: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
    rpcId = `opencraft-${randomUUID()}`,
  ): Promise<TResult> {
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method,
        payload,
      }),
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });
    if (!response.ok) {
      throw new DshClientError("DSH_HTTP_ERROR", `${method} failed with HTTP ${response.status}`, response.status >= 500);
    }
    const envelope = await response.json() as DshResponseEnvelope;
    if (envelope.result?.ok !== true) {
      const error = envelope.result?.error;
      throw new DshClientError(
        error?.code ?? "DSH_REQUEST_FAILED",
        error?.message ?? `${method} failed`,
        error?.retryable ?? false,
      );
    }
    return envelope.result.value as TResult;
  }

  async stream(
    path: "/api/events.mux" | "/api/events.host",
    onFrame: (frame: DshStreamEnvelope) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      let opened = false;
      const abort = () => socket.close(1000, "OpenCraft host generation ended");
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        opened = true;
        onOpen?.();
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "DSH event streams must be text");
          return;
        }
        try {
          const envelope = JSON.parse(data.toString("utf8")) as { rpcId?: string; payload?: unknown };
          if (typeof envelope.payload === "object" && envelope.payload !== null) {
            onFrame({ rpcId: envelope.rpcId, payload: envelope.payload as Record<string, unknown> });
          }
        } catch (error) {
          console.error(`[opencraft local host] malformed DSH frame on ${path}`, error);
        }
      });
      socket.once("error", (error) => reject(new DshClientError(
        "DSH_STREAM_FAILED",
        `${path} WebSocket failed: ${error.message}`,
        true,
      )));
      socket.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted || code === 1000) resolve();
        else reject(new DshClientError(
          "DSH_STREAM_CLOSED",
          `${path} WebSocket closed${opened ? "" : " before opening"} (${code})`,
          true,
        ));
      });
      if (signal.aborted) abort();
    });
  }
}

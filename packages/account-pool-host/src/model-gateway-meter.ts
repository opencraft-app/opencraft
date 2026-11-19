import { ModelGatewayStore, type ModelGatewayTokenUsage } from "./model-gateway-store.js";

function usage(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const input = row.input_tokens,
    output = row.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || Number(input) < 0 || Number(output) < 0)
    return null;
  const total = Number(input) + Number(output);
  if (
    !Number.isSafeInteger(total) ||
    total > 1_000_000_000_000 ||
    (row.total_tokens !== undefined && row.total_tokens !== total)
  )
    return null;
  return total;
}

/** Bounded receipt observer. Text in an assistant message is never interpreted
 * as usage. A truncated SSE event or EOF without a receipt is unknown. */
export class ModelGatewayUsageReceipt {
  private decoder = new TextDecoder();
  private line = "";
  private data: string[] = [];
  private size = 0;
  private oversized = false;
  private afterCR = false;
  private json = "";
  private jsonSize = 0;
  private jsonOversized = false;
  actual: number | null = null;
  counts: ModelGatewayTokenUsage | undefined;
  constructor(private readonly sse: boolean) {}
  private parse(raw: string, event: boolean) {
    try {
      const value = JSON.parse(raw);
      if (event && !["response.completed", "response.incomplete"].includes(value?.type)) return;
      const response = event ? value.response : value;
      if (
        !response ||
        typeof response.id !== "string" ||
        !response.id ||
        (!(event && response.status === undefined) && !["completed", "incomplete"].includes(response.status))
      )
        return;
      const total = usage(response.usage);
      if (total !== null) {
        this.actual = total;
        const details = response.usage?.input_tokens_details;
        const read = details?.cached_tokens,
          write = details?.cache_write_tokens;
        const valid = (n: unknown): n is number =>
          Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= response.usage.input_tokens;
        this.counts = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: valid(read) ? read : null,
          cacheWriteTokens: valid(write) ? write : null,
        };
      }
    } catch {
      /* No authoritative receipt. */
    }
  }
  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      this.jsonSize += text.length;
      if (this.jsonSize > 1024 * 1024) {
        this.jsonOversized = true;
        this.json = "";
      } else if (!this.jsonOversized) this.json += text;
    }
    // Native Responses endpoints sometimes omit/mislabel Content-Type. Inspect
    // protocol records independently, as the existing response bridge does.
    for (const char of text) {
      if (this.afterCR) {
        this.afterCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        this.afterCR = char === "\r";
        if (!this.line) {
          if (!this.oversized && this.data.length) this.parse(this.data.join("\n"), true);
          this.data = [];
          this.size = 0;
          this.oversized = false;
        } else if (!this.oversized && this.line.startsWith("data:"))
          this.data.push(this.line.slice(5).replace(/^ /u, ""));
        this.line = "";
      } else {
        if (++this.size > 1024 * 1024) {
          this.oversized = true;
          this.line = "!";
          this.data = [];
        } else if (!this.oversized) this.line += char;
      }
    }
  }
  end() {
    if (!this.sse && !this.jsonOversized) this.parse(this.json + this.decoder.decode(), false);
  }
}

/** Owns a reservation until a terminal usage receipt or an explicitly unknown
 * outcome. The upstream callback must run immediately before dispatch. */
export async function meteredModelRequest(options: {
  path: string;
  thread: string;
  turn?: string | null;
  model: string;
  signal: AbortSignal;
  send: (dispatch: (credential?: string) => void) => Promise<Response>;
}): Promise<Response> {
  const store = new ModelGatewayStore(options.path);
  let reservation;
  try {
    options.signal.throwIfAborted();
    reservation = store.reserve(options.thread, options.model, options.turn);
  } catch (error) {
    store.close();
    throw error;
  }
  let finished = false;
  const finish = (actual: number | null, usage?: ModelGatewayTokenUsage) => {
    if (finished) return;
    finished = true;
    options.signal.removeEventListener("abort", abort);
    try {
      store.finish(reservation.id, actual, usage);
    } finally {
      store.close();
    }
  };
  const abort = () => {
    try {
      finish(null);
    } catch {
      /* Durable reservation remains held. */
    }
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await options.send((credential) => {
      options.signal.throwIfAborted();
      store.dispatched(reservation.id, credential ?? options.model);
    });
    options.signal.throwIfAborted();
    if (!result.ok || !result.body) {
      finish(null);
      return result;
    }
    const receipt = new ModelGatewayUsageReceipt(
      result.headers.get("content-type")?.includes("text/event-stream") === true,
    );
    const reader = result.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            receipt.end();
            finish(receipt.actual, receipt.counts);
            reader.releaseLock();
            controller.close();
            return;
          }
          receipt.push(next.value);
          if (receipt.actual !== null) finish(receipt.actual, receipt.counts);
          controller.enqueue(next.value);
        } catch (error) {
          try {
            finish(null);
          } finally {
            void reader.cancel().catch(() => undefined);
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        try {
          finish(receipt.actual, receipt.counts);
        } finally {
          await reader.cancel(reason);
        }
      },
    });
    return new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers });
  } catch (error) {
    finish(null);
    throw error;
  }
}

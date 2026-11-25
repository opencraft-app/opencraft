import type { ModelGatewayTokenUsage } from "./model-gateway.js";

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

/**
 * Forwards a successful provider response while reading its terminal usage
 * receipt. A partial or canceled response settles with only the usage already
 * observed. The owner can commit over a private RPC, so terminal bytes wait
 * for its settlement and a failed commit keeps the original hold.
 */
export function observeModelGatewayResponse(
  response: Response,
  settle: (actual: number | null, usage?: ModelGatewayTokenUsage) => void | Promise<void>,
): Response {
  if (!response.body) return response;
  const receipt = new ModelGatewayUsageReceipt(
    response.headers.get("content-type")?.includes("text/event-stream") === true,
  );
  const reader = response.body.getReader();
  let settlement: Promise<void> | undefined;
  let canceled = false;
  function finish(actual: number | null, usage?: ModelGatewayTokenUsage): Promise<void> {
    if (settlement) return settlement;
    try {
      settlement = Promise.resolve(settle(actual, usage));
    } catch (error) {
      settlement = Promise.reject(error);
    }
    return settlement;
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (canceled) return;
        if (next.done) {
          receipt.end();
          await finish(receipt.actual, receipt.counts);
          if (canceled) return;
          reader.releaseLock();
          controller.close();
          return;
        }
        receipt.push(next.value);
        if (receipt.actual !== null) await finish(receipt.actual, receipt.counts);
        if (!canceled) controller.enqueue(next.value);
      } catch (error) {
        if (canceled) return;
        await finish(null).catch(() => undefined);
        if (canceled) return;
        // Cancellation can involve an upstream handshake. Start it without
        // delaying the error on the downstream stream.
        void reader
          .cancel(error)
          .catch(() => undefined)
          .finally(() => reader.releaseLock());
        controller.error(error);
      }
    },
    async cancel(reason) {
      canceled = true;
      try {
        await finish(receipt.actual, receipt.counts);
      } finally {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

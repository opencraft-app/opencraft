/** Recognize complete SSE data records, never text occurring inside model output. */
class ResponsesCompletion {
  private readonly decoder = new TextDecoder();
  private line = "";
  private hasLine = false;
  private data: string[] = [];
  private size = 0;
  private oversized = false;
  private afterCR = false;
  private completedAfterCR = false;

  push(chunk: Uint8Array): boolean {
    for (const char of this.decoder.decode(chunk, { stream: true })) {
      if (this.afterCR) {
        this.afterCR = false;
        // Native streaming parsers need the byte after CR to disambiguate CRLF.
        // Forward that byte before ending HTTP, including across chunk boundaries.
        if (this.completedAfterCR) return true;
        if (char === "\n") continue;
      }
      this.afterCR = char === "\r";
      if (char === "\r" || char === "\n") {
        if (!this.hasLine) {
          let completed = false;
          if (!this.oversized && this.data.length > 0) {
            try {
              const value: unknown = JSON.parse(this.data.join("\n"));
              completed = value !== null && typeof value === "object"
                && "type" in value && value.type === "response.completed"
                && "response" in value && value.response !== null && typeof value.response === "object"
                && "id" in value.response && typeof value.response.id === "string";
            } catch { /* Malformed data is not a completion receipt. */ }
          }
          this.data = []; this.size = 0; this.oversized = false;
          if (completed) {
            if (this.afterCR) this.completedAfterCR = true;
            else return true;
          }
        } else if (!this.oversized && this.line.startsWith("data:")) {
          this.data.push(this.line.slice(5).replace(/^ /u, ""));
        }
        this.line = ""; this.hasLine = false;
      } else {
        this.hasLine = true;
        if (this.oversized) continue;
        // Observation is bounded even for giant tool output or malformed SSE.
        this.size += char.length;
        if (this.size > 1024 * 1024) {
          this.oversized = true; this.line = ""; this.data = [];
        } else this.line += char;
      }
    }
    return false;
  }
}

/** Responses ends at response.completed; native consumers need not await HTTP EOF. */
export async function* completedResponsesBody(body: ReadableStream<Uint8Array>, observe?: (event: "completion" | "eof" | "read-failed") => void): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const completion = new ResponsesCompletion();
  let eof = false;
  try {
    while (true) {
      const next = await reader.read().catch(error => { observe?.("read-failed"); throw error; });
      if (next.done) { eof = true; observe?.("eof"); return; }
      const completed = completion.push(next.value);
      if (completed) observe?.("completion");
      yield next.value;
      if (completed) return;
    }
  } finally {
    // Release the provider socket even if it keeps the HTTP stream open after
    // the protocol terminal event, or the downstream has already disconnected.
    // Cancellation may wait for the provider's socket cleanup. HTTP completion
    // must not wait for that cleanup after a terminal record was forwarded.
    try { if (!eof) void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
  }
}

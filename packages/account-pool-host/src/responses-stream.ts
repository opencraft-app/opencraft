/** Recognize complete SSE data records, never text occurring inside model output. */
class ResponsesCompletion {
  private readonly decoder = new TextDecoder();
  private line = "";
  private hasLine = false;
  private data: string[] = [];
  private size = 0;
  private oversized = false;
  private afterCR = false;

  push(chunk: Uint8Array): boolean {
    for (const char of this.decoder.decode(chunk, { stream: true })) {
      if (this.afterCR && char === "\n") { this.afterCR = false; continue; }
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
          if (completed) return true;
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
export async function* completedResponsesBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const completion = new ResponsesCompletion();
  let eof = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { eof = true; return; }
      const completed = completion.push(next.value);
      yield next.value;
      if (completed) return;
    }
  } finally {
    // Release the provider socket even if it keeps the HTTP stream open after
    // the protocol terminal event, or the downstream has already disconnected.
    try { if (!eof) await reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
  }
}

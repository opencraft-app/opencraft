type Terminal = "completion" | "failure";
type Frame = { kind: "object" | "array"; phase: string; tag: "root" | "response" | "other"; key?: string };

/** Validate JSON incrementally, retaining only the two envelope fields we need.
 * Large output strings/arrays never become an observation buffer. */
class TerminalEnvelope {
  private stack: Frame[] = [];
  private root = false;
  private done = false;
  private invalid = false;
  private token?: "string" | "number" | "literal";
  private tokenKey = false;
  private capture = false;
  private text = "";
  private escaped = false;
  private unicode = 0;
  private selected?: "type" | "id";
  private type?: string;
  private response = false;
  private id = false;

  push(char: string): void {
    if (this.invalid) return;
    if (this.token === "string") {
      if (this.unicode) { if (!/[0-9a-f]/iu.test(char)) this.invalid = true; this.unicode--; }
      else if (this.escaped) {
        if (char === "u") this.unicode = 4;
        else if (!'"\\/bfnrt'.includes(char)) this.invalid = true;
        this.escaped = false;
      } else if (char === "\\") this.escaped = true;
      else if (char === '"') {
        if (this.capture) this.text += char;
        let value: string | undefined;
        if (this.capture) { try { value = JSON.parse(this.text); } catch { this.invalid = true; } }
        if (this.tokenKey) { const frame = this.stack.at(-1)!; frame.key = value; frame.phase = "colon"; }
        else if (this.selected === "type") this.type = value;
        else if (this.selected === "id") this.id = true;
        this.token = undefined; this.text = ""; return;
      } else if (char.charCodeAt(0) < 32) this.invalid = true;
      if (this.capture) {
        this.text += char;
        // Envelope keys/type are small. Oversized fields cannot match a terminal.
        if (this.text.length > 1024) { this.capture = false; this.text = ""; }
      }
      return;
    }
    if (this.token) {
      if (!/[\s,\]}]/u.test(char)) {
        if (this.text.length >= 1024) this.invalid = true;
        else this.text += char;
        return;
      }
      if (this.token === "number" ? !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(this.text)
        : !["true", "false", "null"].includes(this.text)) this.invalid = true;
      this.token = undefined; this.text = "";
    }
    if (/^[ \t\r\n]$/u.test(char)) return;
    const frame = this.stack.at(-1);
    if (frame?.kind === "object") {
      if (["key", "key-or-end"].includes(frame.phase)) {
        if (char === "}" && frame.phase === "key-or-end") { this.stack.pop(); return; }
        if (char !== '"') { this.invalid = true; return; }
        this.string(true); return;
      }
      if (frame.phase === "colon") { if (char !== ":") this.invalid = true; else frame.phase = "value"; return; }
      if (frame.phase === "comma-or-end") {
        if (char === "}") this.stack.pop();
        else if (char === ",") frame.phase = "key";
        else this.invalid = true;
        return;
      }
    } else if (frame?.kind === "array") {
      if (char === "]" && frame.phase === "value-or-end") { this.stack.pop(); return; }
      if (frame.phase === "comma-or-end") {
        if (char === "]") this.stack.pop();
        else if (char === ",") frame.phase = "value";
        else this.invalid = true;
        return;
      }
    } else if (this.done) { this.invalid = true; return; }
    this.selected = frame?.tag === "root" && frame.key === "type" ? "type"
      : frame?.tag === "response" && frame.key === "id" ? "id" : undefined;
    if (this.selected === "type") this.type = undefined;
    if (this.selected === "id") this.id = false;
    const response = frame?.tag === "root" && frame.key === "response";
    if (response) { this.response = char === "{"; this.id = false; }
    if (frame) frame.phase = "comma-or-end";
    else { this.done = true; this.root = char === "{"; }
    if (char === "{" || char === "[") {
      if (this.stack.length >= 256) { this.invalid = true; return; }
      this.stack.push({ kind: char === "{" ? "object" : "array", phase: char === "{" ? "key-or-end" : "value-or-end",
        tag: !frame ? "root" : response && char === "{" ? "response" : "other" });
    } else if (char === '"') this.string(false);
    else if (char === "-" || /[0-9]/u.test(char)) { this.token = "number"; this.text = char; }
    else if ("tfn".includes(char)) { this.token = "literal"; this.text = char; }
    else this.invalid = true;
  }
  private string(key: boolean) {
    this.token = "string"; this.tokenKey = key; this.capture = key || this.selected === "type";
    this.text = this.capture ? '"' : ""; this.escaped = false; this.unicode = 0;
  }
  terminal(): Terminal | undefined {
    if (this.token && this.token !== "string") this.push(" ");
    if (this.invalid || this.token || this.stack.length || !this.done || !this.root || !this.response || !this.id) return;
    if (this.type === "response.completed") return "completion";
    if (this.type === "response.failed" || this.type === "response.incomplete") return "failure";
  }
}

/** Recognize complete SSE records, independent of provider MIME labels. */
class ResponsesCompletion {
  private readonly decoder = new TextDecoder();
  private envelope = new TerminalEnvelope();
  private prefix = "";
  private hasLine = false;
  private dataLine = false;
  private dataStart = false;
  private hasData = false;
  private afterCR = false;
  private terminalAfterCR?: Terminal;
  push(chunk: Uint8Array): Terminal | undefined {
    for (const char of this.decoder.decode(chunk, { stream: true })) {
      if (this.afterCR) {
        this.afterCR = false;
        // Native consumers need the byte after CR to disambiguate CRLF.
        if (this.terminalAfterCR) return this.terminalAfterCR;
        if (char === "\n") continue;
      }
      this.afterCR = char === "\r";
      if (char === "\r" || char === "\n") {
        if (!this.hasLine) {
          const terminal = this.hasData ? this.envelope.terminal() : undefined;
          this.envelope = new TerminalEnvelope(); this.hasData = false;
          if (terminal) { if (this.afterCR) this.terminalAfterCR = terminal; else return terminal; }
        } else if (this.dataLine) this.envelope.push("\n");
        this.prefix = ""; this.hasLine = false; this.dataLine = false; this.dataStart = false;
      } else {
        this.hasLine = true;
        if (this.prefix.length < 5) {
          this.prefix += char;
          if (this.prefix === "data:") { this.dataLine = true; this.dataStart = true; this.hasData = true; }
        } else if (this.dataLine) {
          if (this.dataStart) { this.dataStart = false; if (char === " ") continue; }
          this.envelope.push(char);
        }
      }
    }
  }
}

/** End at a validated upstream business terminal; never wait for provider EOF. */
export async function* completedResponsesBody(body: ReadableStream<Uint8Array>, observe?: (event: Terminal | "eof" | "read-failed") => void): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const completion = new ResponsesCompletion();
  let eof = false;
  try {
    while (true) {
      const next = await reader.read().catch(error => { observe?.("read-failed"); throw error; });
      if (next.done) { eof = true; observe?.("eof"); return; }
      const terminal = completion.push(next.value);
      if (terminal) observe?.(terminal);
      yield next.value;
      if (terminal) return;
    }
  } finally {
    try { if (!eof) void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
  }
}

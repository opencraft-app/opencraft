const historyMethods = new Set(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]);
/** Keep a history RPC failure below the connection's message limit. No truncation
 * and no execution replay: an oversized result is an explicit request error. */
export function serializeHistoryReply(frame: Record<string, unknown>, method: string, maxBytes = 8 * 1024 * 1024): string {
  const serialized = JSON.stringify(frame);
  if (!historyMethods.has(method) || !("result" in frame)) return serialized;
  let bytes = 0;
  for (let i = 0; i < serialized.length && bytes <= maxBytes; i++) {
    const code = serialized.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && serialized.charCodeAt(i + 1) >= 0xdc00 && serialized.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  if (bytes <= maxBytes) return serialized;
  const { result: _result, ...identity } = frame;
  return JSON.stringify({ ...identity, error: { code: -32072,
    message: "History response is too large; use a smaller history page",
    data: { code: "HISTORY_RESPONSE_TOO_LARGE", retryable: false } } });
}

// Only the fixed platform Thread/authorization pipe carries terminal failure
// classification. Never serialize provider text, stack, paths or arbitrary data.
const threadMethods = new Set([
  "platform/opencraft/personal-assistant/authorize",
  "platform/opencraft/personal-assistant/threads/command",
]);
const terminalStatuses = new Set([400, 401, 403, 409]);
const deniedCodes = new Set([
  "assistant_thread_grant_revoked",
  "assistant_thread_source_unavailable",
  "assistant_thread_denied",
  "assistant_thread_user_control",
  "personal_assistant_unclaimed",
  "personal_assistant_revoked",
]);
const refusedCodes = new Set([
  "assistant_thread_not_running",
  "assistant_thread_turn_changed",
  "assistant_thread_profile_required",
  "assistant_thread_profile_unavailable",
  "assistant_thread_host_unsupported",
  "invalid_thread_argument",
  "idempotency_conflict",
]);
function failureStatus(method, error) {
  if (!threadMethods.has(method)) return;
  if (Number.isInteger(error?.status))
    return terminalStatuses.has(error.status) ? error.status : undefined;
  for (const code of [error?.code, error?.message]) {
    if (deniedCodes.has(code)) return 403;
    if (refusedCodes.has(code)) return 409;
  }
}
function readFailure(packet) {
  const error = Error("Assistant operation unavailable");
  if (terminalStatuses.has(packet?.data?.status))
    error.status = packet.data.status;
  return error;
}

/** Private pipe JSON-RPC 2.0, versioned at initialize. No authority is granted by this envelope. */
export function createStdioPeer({
  input,
  output,
  handle,
  onNotification = () => {},
  onClose = () => {},
  maxBytes = 1024 * 1024,
  timeoutMs = 15000,
}) {
  let buffer = Buffer.alloc(0),
    next = 0,
    closed = false,
    inflight = 0;
  const pending = new Map();
  function close() {
    if (closed) return;
    closed = true;
    input.off("data", receive);
    input.off("end", close);
    for (const finish of pending.values())
      finish(Error("Assistant transport closed"));
    onClose();
  }
  function send(packet) {
    if (closed) throw Error("Assistant transport closed");
    const line = JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n";
    if (
      Buffer.byteLength(line) > maxBytes ||
      output.writableLength > maxBytes * 2
    ) {
      close();
      throw Error("Assistant transport capacity exceeded");
    }
    output.write(line);
  }
  async function accept(p) {
    if (
      !p ||
      p.jsonrpc !== "2.0" ||
      (p.id !== undefined &&
        !(
          Number.isSafeInteger(p.id) ||
          (typeof p.id === "string" && p.id.length <= 128)
        ))
    )
      throw Error("Invalid envelope");
    if (typeof p.method === "string") {
      if (p.id === undefined) {
        onNotification(p.method, p.params);
        return;
      }
      if (inflight >= 32) {
        send({ id: p.id, error: { code: -32000, message: "Request limit" } });
        return;
      }
      inflight++;
      try {
        const result = await handle(p.method, p.params);
        if (!closed) send({ id: p.id, result: result ?? null });
      } catch (error) {
        const status = failureStatus(p.method, error);
        if (!closed)
          send({
            id: p.id,
            error: {
              code: -32000,
              message: "Assistant operation unavailable",
              ...(status === undefined ? {} : { data: { status } }),
            },
          });
      } finally {
        inflight--;
      }
    } else if (p.id !== undefined)
      pending.get(p.id)?.(p.error ? readFailure(p.error) : null, p.result);
    else throw Error("Invalid envelope");
  }
  function receive(chunk) {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    let at;
    while (!closed && (at = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, at);
      buffer = buffer.subarray(at + 1);
      if (line.length > maxBytes) {
        close();
        return;
      }
      try {
        void accept(JSON.parse(line.toString("utf8"))).catch(close);
      } catch {
        close();
        return;
      }
    }
    if (buffer.length > maxBytes) close();
  }
  input.on("data", receive);
  input.on("end", close);
  input.on("error", close);
  output.on("error", close);
  return {
    close,
    notify(method, params = {}) {
      if (!closed) send({ method, params });
    },
    request(method, params = {}, options = {}) {
      if (closed || options.signal?.aborted)
        return Promise.reject(Error("Assistant transport unavailable"));
      if (pending.size >= 32)
        return Promise.reject(Error("Assistant request limit"));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const finish = (error, value) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(Error("Assistant request aborted"));
        const timer = setTimeout(
          () => finish(Error("Assistant request timed out")),
          options.timeoutMs ?? timeoutMs,
        );
        pending.set(id, finish);
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          send({ id, method, params });
        } catch (error) {
          finish(error);
        }
      });
    },
  };
}

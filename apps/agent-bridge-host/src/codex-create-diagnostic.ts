/** Only exhaustively recognized native start failures prove absence of a thread.
 * Native message parameters and error.data can contain workspace paths or secrets. */
export interface NativeCreateDiagnostic {
  readonly code: number | null;
  readonly reason: string;
  readonly notAllocated: boolean;
}

export function nativeCreateDiagnostic(code: unknown, message: string): NativeCreateDiagnostic {
  const rpcCode = typeof code === "number" && Number.isSafeInteger(code) ? code : null;
  const diagnostic = (reason: string, notAllocated = false) => ({ code: rpcCode, reason, notAllocated });
  // These are protocol dispatch errors, before a native handler is invoked.
  if (rpcCode === -32602) return diagnostic("invalid-parameters", true);
  if (rpcCode === -32601 && /^method not found$/iu.test(message)) return diagnostic("method-not-found", true);
  if (rpcCode === -32600) {
    // Known checks before start_thread. Generic invalid-request codes are also
    // used after dispatch, so the code alone does not prove no allocation.
    if (message === "`permissions` cannot be combined with `sandbox`")
      return diagnostic("incompatible-permission-options", true);
    if (message === "paginated threads require thread/turns/list and thread/items/list support")
      return diagnostic("history-mode-unavailable", true);
    if (message === "projectId must not be empty" || message.startsWith("project not found: "))
      return diagnostic("project-unavailable", true);
    if (message.startsWith("failed to load configuration: ")) return diagnostic("configuration-load-failed", true);
  }
  if (message.startsWith("error creating thread: ")) return diagnostic("native-thread-initialization-failed");
  return diagnostic("unclassified-native-rejection");
}

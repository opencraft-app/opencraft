import { connect } from "node:net";
import { dirname, join } from "node:path";
import WebSocket, { type ClientOptions } from "ws";

/**
 * Where native Codex and the AppServer relay in front of it are reached.
 *
 * POSIX: both are Unix sockets in the control endpoint's private directory.
 * Windows: native Codex has no named-pipe listener, so it listens on loopback
 * WebSocket with a capability token (`--ws-auth capability-token`); the relay
 * that every client uses is a named pipe derived from the control endpoint.
 */

/** A Windows named pipe path (`\\.\pipe\…` or `\\?\pipe\…`). */
export function isNamedPipe(path: string): boolean {
  return /^\\\\[.?]\\pipe\\/iu.test(path);
}

/** The relay clients connect to, next to an AppServer control endpoint. */
export function codexNativeSocket(appServerEndpoint: string): string {
  return isNamedPipe(appServerEndpoint)
    ? `${appServerEndpoint}-native`
    : join(dirname(appServerEndpoint), "native.sock");
}

/** Where native Codex itself listens: a Unix socket, or on Windows a loopback WebSocket URL. */
export function codexNativeListener(appServerEndpoint: string, loopbackPort?: number): string {
  if (!isNamedPipe(appServerEndpoint)) return join(dirname(appServerEndpoint), "native-internal.sock");
  if (!Number.isSafeInteger(loopbackPort) || loopbackPort! < 1 || loopbackPort! > 65535)
    throw new Error("A Windows native listener needs a loopback port");
  return `ws://127.0.0.1:${loopbackPort}`;
}

/** `--listen` arguments for native Codex; a WebSocket listener requires its capability token file. */
export function codexNativeListenArgs(listener: string, tokenFile?: string): string[] {
  if (!listener.startsWith("ws://")) return ["--listen", `unix://${listener}`];
  if (!tokenFile) throw new Error("A WebSocket native listener requires a capability token");
  return ["--listen", listener, "--ws-auth", "capability-token", "--ws-token-file", tokenFile];
}

/** Capability tokens of the WebSocket listeners this process started, by listener URL. */
const nativeTokens = new Map<string, string>();
export function rememberCodexNativeToken(listener: string, token: string): void {
  nativeTokens.set(listener, token);
}

/**
 * Open a WebSocket to a native endpoint: a Unix socket, a Windows named pipe,
 * or a loopback WebSocket URL with its capability token. `path` is the request
 * path and query (default `/`).
 */
export function openCodexNativeSocket(
  endpoint: string,
  options: ClientOptions = {},
  extra: { path?: string; token?: string } = {},
): WebSocket {
  const path = extra.path ?? "/";
  if (endpoint.startsWith("ws://")) {
    const url = new URL(path, endpoint);
    if (url.hostname !== "127.0.0.1") throw new Error("Native WebSocket endpoints are loopback only");
    return new WebSocket(url, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${extra.token ?? nativeTokens.get(endpoint) ?? ""}` },
    });
  }
  // `ws+unix:` URLs cannot carry a Windows pipe path; connect the pipe directly.
  if (isNamedPipe(endpoint))
    return new WebSocket(new URL(path, "ws://localhost"), { ...options, createConnection: () => connect(endpoint) });
  return new WebSocket(`ws+unix://${endpoint}:${path}`, options);
}

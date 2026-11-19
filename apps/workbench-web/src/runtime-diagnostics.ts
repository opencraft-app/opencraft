import { isLocalDiagnosticsEnabled, subscribeLocalDiagnostics, getLocalDiagnosticsState } from "./runtime/local-diagnostics";
import type { RuntimeErrorReport } from "./runtime-error-reporting";

export const RUNTIME_DIAGNOSTIC_ERROR_LIMIT = 100;
export const RUNTIME_DIAGNOSTIC_NETWORK_LIMIT = 50;

export interface RuntimeDiagnosticErrorEntry {
  readonly kind: "error";
  readonly at: number;
  readonly source: RuntimeErrorReport["source"] | "console.error" | "console.warn";
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly componentStack?: string;
}

export interface RuntimeDiagnosticNetworkEntry {
  readonly kind: "network";
  readonly at: number;
  readonly channel: "fetch" | "websocket";
  readonly event: "http-error" | "network-error" | "error" | "close";
  readonly path: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly code?: number;
  readonly reason?: string;
}

export type RuntimeDiagnosticEntry = RuntimeDiagnosticErrorEntry | RuntimeDiagnosticNetworkEntry;

export interface RuntimeEnvironmentSnapshot {
  readonly userAgent: string;
  readonly iosVersion?: string;
  readonly safariVersion?: string;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewport?: {
    readonly width: number;
    readonly height: number;
    readonly offsetTop: number;
    readonly offsetLeft: number;
    readonly scale: number;
  };
  readonly devicePixelRatio: number;
  readonly safeAreaInsets: {
    readonly top: string;
    readonly right: string;
    readonly bottom: string;
    readonly left: string;
  };
  readonly touchInteraction: boolean;
  readonly colorScheme: string;
  readonly language: string;
  readonly buildId?: string;
  readonly sourceRevision?: string;
  readonly path: string;
}

export interface CssSupportProbe {
  readonly id: string;
  readonly label: string;
  readonly supported: boolean | null;
}

const errors: RuntimeDiagnosticErrorEntry[] = [];
const network: RuntimeDiagnosticNetworkEntry[] = [];
const listeners = new Set<() => void>();
let snapshot = { errors: [] as readonly RuntimeDiagnosticErrorEntry[], network: [] as readonly RuntimeDiagnosticNetworkEntry[] };
let collectionStarted = false;
const socketCleanups = new Set<() => void>();
const RUNTIME_BYTES = 256 * 1024;
function boundRuntimeBuffers() {
  while (new TextEncoder().encode(JSON.stringify({ errors, network })).length > RUNTIME_BYTES) {
    if (errors.length && (!network.length || errors[0]!.at <= network[0]!.at)) errors.shift();
    else network.shift();
  }
}
let nativeFetch: typeof fetch | null = null;
let NativeWebSocket: typeof WebSocket | null = null;
let nativeConsoleError: typeof console.error | null = null;
let nativeConsoleWarn: typeof console.warn | null = null;

function notify(): void {
  boundRuntimeBuffers();
  snapshot = { errors: errors.slice(), network: network.slice() };
  for (const listener of listeners) listener();
}

function pushLimited<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function describeConsoleArgument(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 2048);
  if (typeof value === "string") return value.slice(0, 2048);
  try {
    return JSON.stringify(value)?.slice(0, 2048) ?? String(value).slice(0, 2048);
  } catch {
    return String(value).slice(0, 2048);
  }
}

function requestPath(input: RequestInfo | URL): string {
  try {
    const base = typeof window === "undefined" ? "https://local.invalid" : window.location.origin;
    const url = typeof input === "string" || input instanceof URL
      ? new URL(String(input), base)
      : new URL(input.url, base);
    return url.pathname;
  } catch {
    return "/";
  }
}

function websocketPath(url: string): string {
  try {
    const parsed = new URL(url, typeof window === "undefined" ? undefined : window.location.href);
    return parsed.pathname;
  } catch {
    return url.replace(/\?.*$/u, "").replace(/#.*$/u, "");
  }
}

export function recordRuntimeDiagnosticError(report: Pick<RuntimeErrorReport, "source" | "message" | "name" | "stack" | "componentStack">): void {
  if (!isLocalDiagnosticsEnabled()) return;
  pushLimited(errors, {
    kind: "error",
    at: Date.now(),
    source: report.source,
    message: report.message.slice(0, 2048),
    ...(report.name ? { name: report.name.slice(0, 128) } : {}),
    ...(report.stack ? { stack: report.stack.slice(0, 4096) } : {}),
    ...(report.componentStack ? { componentStack: report.componentStack.slice(0, 4096) } : {}),
  }, RUNTIME_DIAGNOSTIC_ERROR_LIMIT);
  notify();
}

export function recordRuntimeDiagnosticConsole(
  level: "console.error" | "console.warn",
  args: readonly unknown[],
): void {
  const error = args.find((value): value is Error => value instanceof Error);
  if (!isLocalDiagnosticsEnabled()) return;
  pushLimited(errors, {
    kind: "error",
    at: Date.now(),
    source: level,
    message: args.slice(0, 16).map(describeConsoleArgument).join(" ").slice(0, 2048),
    ...(error?.name ? { name: error.name.slice(0, 128) } : {}),
    ...(error?.stack ? { stack: error.stack.slice(0, 4096) } : {}),
  }, RUNTIME_DIAGNOSTIC_ERROR_LIMIT);
  notify();
}

export function recordRuntimeDiagnosticNetwork(entry: Omit<RuntimeDiagnosticNetworkEntry, "kind" | "at">): void {
  if (!isLocalDiagnosticsEnabled()) return;
  pushLimited(network, {
    kind: "network",
    at: Date.now(),
    ...entry, path: entry.path.slice(0, 1024),
    ...(entry.reason ? { reason: entry.reason.slice(0, 2048) } : {}),
  }, RUNTIME_DIAGNOSTIC_NETWORK_LIMIT);
  notify();
}

export function getRuntimeDiagnosticErrors(): readonly RuntimeDiagnosticErrorEntry[] {
  return snapshot.errors;
}

export function getRuntimeDiagnosticNetwork(): readonly RuntimeDiagnosticNetworkEntry[] {
  return snapshot.network;
}

export function getRuntimeDiagnosticsSnapshot(): typeof snapshot {
  return snapshot;
}

export function clearRuntimeDiagnostics(): void {
  errors.splice(0, errors.length);
  network.splice(0, network.length);
  notify();
}

export function subscribeRuntimeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function wrapConsole(): void {
  if (nativeConsoleError || typeof console === "undefined") return;
  const originalError = console.error, originalWarn = console.warn;
  nativeConsoleError = originalError;
  nativeConsoleWarn = originalWarn;
  console.error = (...args: unknown[]) => {
    recordRuntimeDiagnosticConsole("console.error", args);
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    recordRuntimeDiagnosticConsole("console.warn", args);
    originalWarn.apply(console, args);
  };
}

function wrapFetch(): void {
  if (nativeFetch || typeof globalThis.fetch !== "function") return;
  const original = globalThis.fetch;
  nativeFetch = original;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    const path = requestPath(input);
    const session = getLocalDiagnosticsState().session;
    return original.call(globalThis, input, init).then((response) => {
      if (session !== getLocalDiagnosticsState().session) return response;
      if (response.status < 200 || response.status > 299) {
        const ended = typeof performance === "undefined" ? Date.now() : performance.now();
        recordRuntimeDiagnosticNetwork({
          channel: "fetch",
          event: "http-error",
          path,
          status: response.status,
          durationMs: Math.round(ended - started),
        });
      }
      return response;
    }, (error: unknown) => {
      if (session !== getLocalDiagnosticsState().session) throw error;
      const ended = typeof performance === "undefined" ? Date.now() : performance.now();
      recordRuntimeDiagnosticNetwork({
        channel: "fetch",
        event: "network-error",
        path,
        durationMs: Math.round(ended - started),
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };
}

function wrapWebSocket(): void {
  if (NativeWebSocket || typeof WebSocket === "undefined") return;
  const BaseWebSocket = WebSocket;
  NativeWebSocket = BaseWebSocket;
  function DiagnosticWebSocket(url: string | URL, protocols?: string | string[]) {
    const socket = protocols === undefined ? new BaseWebSocket(url) : new BaseWebSocket(url, protocols);
    if (!isLocalDiagnosticsEnabled()) return socket;
    const path = websocketPath(String(url));
    const session = getLocalDiagnosticsState().session;
    const onError = () => {
      if (session === getLocalDiagnosticsState().session) recordRuntimeDiagnosticNetwork({ channel: "websocket", event: "error", path });
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      if (session !== getLocalDiagnosticsState().session) return;
      if (event.wasClean && event.code === 1000) return;
      recordRuntimeDiagnosticNetwork({
        channel: "websocket",
        event: "close",
        path,
        code: event.code,
        reason: event.reason || undefined,
      });
    };
    const cleanup = () => {
      socket.removeEventListener("error", onError); socket.removeEventListener("close", onClose);
      socketCleanups.delete(cleanup);
    };
    socket.addEventListener("error", onError); socket.addEventListener("close", onClose);
    socketCleanups.add(cleanup);
    return socket;
  }
  DiagnosticWebSocket.prototype = BaseWebSocket.prototype;
  Object.setPrototypeOf(DiagnosticWebSocket, BaseWebSocket);
  (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
    DiagnosticWebSocket as unknown as typeof WebSocket;
}

export function startRuntimeDiagnosticCollection(): void {
  if (collectionStarted) return;
  collectionStarted = true;
  const update = () => {
    if (isLocalDiagnosticsEnabled()) { clearRuntimeDiagnostics(); wrapConsole(); wrapFetch(); wrapWebSocket(); return; }
    if (nativeFetch) { globalThis.fetch = nativeFetch; nativeFetch = null; }
    if (NativeWebSocket) { globalThis.WebSocket = NativeWebSocket; NativeWebSocket = null; }
    if (nativeConsoleError) { console.error = nativeConsoleError; nativeConsoleError = null; }
    if (nativeConsoleWarn) { console.warn = nativeConsoleWarn; nativeConsoleWarn = null; }
    for (const cleanup of socketCleanups) cleanup();
  };
  subscribeLocalDiagnostics(update);
  update();
}

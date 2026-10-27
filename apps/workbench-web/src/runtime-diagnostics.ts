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
let nativeFetch: typeof fetch | null = null;
let NativeWebSocket: typeof WebSocket | null = null;
let nativeConsoleError: typeof console.error | null = null;
let nativeConsoleWarn: typeof console.warn | null = null;

function notify(): void {
  snapshot = { errors: errors.slice(), network: network.slice() };
  for (const listener of listeners) listener();
}

function pushLimited<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function describeConsoleArgument(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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
  pushLimited(errors, {
    kind: "error",
    at: Date.now(),
    source: report.source,
    message: report.message,
    ...(report.name ? { name: report.name } : {}),
    ...(report.stack ? { stack: report.stack } : {}),
    ...(report.componentStack ? { componentStack: report.componentStack } : {}),
  }, RUNTIME_DIAGNOSTIC_ERROR_LIMIT);
  notify();
}

export function recordRuntimeDiagnosticConsole(
  level: "console.error" | "console.warn",
  args: readonly unknown[],
): void {
  const error = args.find((value): value is Error => value instanceof Error);
  pushLimited(errors, {
    kind: "error",
    at: Date.now(),
    source: level,
    message: args.map(describeConsoleArgument).join(" "),
    ...(error?.name ? { name: error.name } : {}),
    ...(error?.stack ? { stack: error.stack } : {}),
  }, RUNTIME_DIAGNOSTIC_ERROR_LIMIT);
  notify();
}

export function recordRuntimeDiagnosticNetwork(entry: Omit<RuntimeDiagnosticNetworkEntry, "kind" | "at">): void {
  pushLimited(network, {
    kind: "network",
    at: Date.now(),
    ...entry,
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
  nativeConsoleError = console.error.bind(console);
  nativeConsoleWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    recordRuntimeDiagnosticConsole("console.error", args);
    nativeConsoleError?.(...args);
  };
  console.warn = (...args: unknown[]) => {
    recordRuntimeDiagnosticConsole("console.warn", args);
    nativeConsoleWarn?.(...args);
  };
}

function wrapFetch(): void {
  if (nativeFetch || typeof globalThis.fetch !== "function") return;
  nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    const path = requestPath(input);
    return nativeFetch!(input, init).then((response) => {
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
    const path = websocketPath(String(url));
    socket.addEventListener("error", () => {
      recordRuntimeDiagnosticNetwork({ channel: "websocket", event: "error", path });
    });
    socket.addEventListener("close", (event) => {
      if (event.wasClean && event.code === 1000) return;
      recordRuntimeDiagnosticNetwork({
        channel: "websocket",
        event: "close",
        path,
        code: event.code,
        reason: event.reason || undefined,
      });
    });
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
  wrapConsole();
  wrapFetch();
  wrapWebSocket();
}

function readSafeAreaInset(side: "top" | "right" | "bottom" | "left"): string {
  if (typeof window === "undefined" || typeof document === "undefined") return "0px";
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.padding = `env(safe-area-inset-${side}, 0px)`;
  document.documentElement.appendChild(probe);
  const value = window.getComputedStyle(probe).paddingTop || "0px";
  probe.remove();
  return value;
}

export function parseAppleVersions(userAgent: string): { readonly iosVersion?: string; readonly safariVersion?: string } {
  const ios = /(?:iPhone|iPad|iPod).*?OS (\d+)[._](\d+)(?:[._](\d+))?/u.exec(userAgent)
    || (/\bMacintosh\b/u.test(userAgent) && /Mobile\/\w+/u.test(userAgent) ? /Version\/(\d+)\.(\d+)(?:\.(\d+))?/u.exec(userAgent) : null);
  const safari = /Version\/(\d+)\.(\d+)(?:\.(\d+))?.*Safari/u.exec(userAgent);
  const iosVersion = ios ? [ios[1], ios[2], ios[3]].filter(Boolean).join(".") : undefined;
  const safariVersion = safari ? [safari[1], safari[2], safari[3]].filter(Boolean).join(".") : undefined;
  return {
    ...(iosVersion ? { iosVersion } : {}),
    ...(safariVersion ? { safariVersion } : {}),
  };
}

export function captureRuntimeEnvironment(): RuntimeEnvironmentSnapshot {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const visual = typeof window === "undefined" ? undefined : window.visualViewport;
  const buildId = typeof document === "undefined"
    ? undefined
    : document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content?.trim() || undefined;
  const colorScheme = typeof document === "undefined"
    ? "unknown"
    : document.documentElement.dataset.theme
      || (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  return {
    userAgent,
    ...parseAppleVersions(userAgent),
    innerWidth: typeof window === "undefined" ? 0 : window.innerWidth,
    innerHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    ...(visual ? {
      visualViewport: {
        width: visual.width,
        height: visual.height,
        offsetTop: visual.offsetTop,
        offsetLeft: visual.offsetLeft,
        scale: visual.scale,
      },
    } : {}),
    devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    safeAreaInsets: {
      top: readSafeAreaInset("top"),
      right: readSafeAreaInset("right"),
      bottom: readSafeAreaInset("bottom"),
      left: readSafeAreaInset("left"),
    },
    touchInteraction: typeof document !== "undefined" && document.documentElement.dataset.touchInteraction === "true",
    colorScheme,
    language: typeof navigator === "undefined" ? "" : navigator.language,
    ...(buildId ? { buildId } : {}),
    ...(typeof document === "undefined"
      ? {}
      : (() => {
          const sourceRevision = document.querySelector<HTMLMetaElement>('meta[name="opencraft-source-revision"]')?.content?.trim();
          return sourceRevision ? { sourceRevision } : {};
        })()),
    path: typeof window === "undefined" ? "/" : window.location.pathname,
  };
}

export const CSS_SUPPORT_PROBES: readonly { readonly id: string; readonly label: string; readonly query: readonly [string] | readonly [string, string] }[] = [
  { id: "has", label: ":has()", query: ["selector(:has(*))"] },
  { id: "container", label: "container queries", query: ["container-type", "inline-size"] },
  { id: "dvh", label: "dvh", query: ["height", "1dvh"] },
  { id: "color-mix", label: "color-mix()", query: ["color", "color-mix(in srgb, red 50%, blue)"] },
  { id: "nesting", label: "CSS nesting", query: ["selector(&)"] },
  { id: "subgrid", label: "subgrid", query: ["grid-template-columns", "subgrid"] },
  { id: "oklch", label: "oklch()", query: ["color", "oklch(0.7 0.1 180)"] },
  { id: "aspect-ratio", label: "aspect-ratio", query: ["aspect-ratio", "1 / 1"] },
  { id: "view-transition", label: "view-transition-name", query: ["view-transition-name", "none"] },
  { id: "safe-area", label: "env(safe-area-inset)", query: ["padding-bottom", "env(safe-area-inset-bottom, 0px)"] },
];

export function probeCssSupports(
  supports: ((property: string, value?: string) => boolean) | null = typeof CSS === "undefined" ? null : CSS.supports.bind(CSS),
): readonly CssSupportProbe[] {
  return CSS_SUPPORT_PROBES.map((probe) => {
    if (!supports) return { id: probe.id, label: probe.label, supported: null };
    try {
      const supported = probe.query.length === 1
        ? supports(probe.query[0]!)
        : supports(probe.query[0]!, probe.query[1]);
      return { id: probe.id, label: probe.label, supported };
    } catch {
      return { id: probe.id, label: probe.label, supported: null };
    }
  });
}

export function formatDiagnosticsCopy(input: {
  readonly environment: RuntimeEnvironmentSnapshot;
  readonly css: readonly CssSupportProbe[];
  readonly errors: readonly RuntimeDiagnosticErrorEntry[];
  readonly network: readonly RuntimeDiagnosticNetworkEntry[];
}): string {
  const lines = [
    "# OpenCraft diagnostics",
    `path: ${input.environment.path}`,
    `ua: ${input.environment.userAgent}`,
    `ios: ${input.environment.iosVersion ?? "-"}`,
    `safari: ${input.environment.safariVersion ?? "-"}`,
    `viewport: ${input.environment.innerWidth}x${input.environment.innerHeight}`,
    `visualViewport: ${input.environment.visualViewport
      ? `${input.environment.visualViewport.width}x${input.environment.visualViewport.height} @${input.environment.visualViewport.scale}`
      : "-"}`,
    `dpr: ${input.environment.devicePixelRatio}`,
    `safe-area: ${input.environment.safeAreaInsets.top} ${input.environment.safeAreaInsets.right} ${input.environment.safeAreaInsets.bottom} ${input.environment.safeAreaInsets.left}`,
    `touch: ${input.environment.touchInteraction ? "yes" : "no"}`,
    `colorScheme: ${input.environment.colorScheme}`,
    `language: ${input.environment.language}`,
    ...(input.environment.buildId ? [`buildId: ${input.environment.buildId}`] : []),
    ...(input.environment.sourceRevision ? [`sourceRevision: ${input.environment.sourceRevision}`] : []),
    "",
    "## CSS.supports",
    ...input.css.map((probe) => `${probe.label}: ${probe.supported === null ? "unknown" : probe.supported ? "yes" : "no"}`),
    "",
    "## Errors",
    ...input.errors.map((entry) => {
      const stack = entry.stack ? `\n${entry.stack}` : "";
      const component = entry.componentStack ? `\ncomponentStack:${entry.componentStack}` : "";
      return `${new Date(entry.at).toISOString()} ${entry.source} ${entry.message}${stack}${component}`;
    }),
    "",
    "## Network",
    ...input.network.map((entry) => {
      const status = entry.status !== undefined ? ` ${entry.status}` : "";
      const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : "";
      const code = entry.code !== undefined ? ` code=${entry.code}` : "";
      return `${new Date(entry.at).toISOString()} ${entry.channel} ${entry.event} ${entry.path}${status}${duration}${code}`;
    }),
  ];
  return lines.join("\n");
}

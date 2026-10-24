import { pageUrlWithoutSearchAndHash } from "./internal-developer-mode";
import { recordRuntimeDiagnosticError } from "./runtime-diagnostics";
import { serverFetch } from "./runtime/server-context";
import { BrowserStorageError, type BrowserStorageDiagnostics } from "./runtime/browser-storage-error";

export interface RuntimeErrorReport {
  message: string;
  name?: string;
  stack?: string;
  componentStack?: string;
  resourceUrl?: string;
  storageDiagnostics?: BrowserStorageDiagnostics;
  source:
    | "error-boundary"
    | "window-error"
    | "unhandled-rejection"
    | "panel-runtime-bootstrap"
    | "application-bootstrap"
    | "host-profile-storage-recovery"
    | "application-disposal"
    | "sidebar-layout-persist"
    | "thread-catalog-load";
  url: string;
  userAgent?: string;
  viewport?: { readonly width: number; readonly height: number };
  sourceRevision?: string;
}

function describeUnknown(value: unknown): Pick<RuntimeErrorReport, "message" | "name" | "stack"> {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  return {
    message: typeof value === "string" ? value : JSON.stringify(value),
  };
}

function isResizeObserverDeliveryWarning(message: string): boolean {
  return message === "ResizeObserver loop completed with undelivered notifications."
    || message === "ResizeObserver loop limit exceeded";
}

function currentPageUrl(): string {
  if (typeof window === "undefined") return "";
  return pageUrlWithoutSearchAndHash(window.location.href, window.location.origin);
}

function currentViewport(): RuntimeErrorReport["viewport"] | undefined {
  if (typeof window === "undefined") return undefined;
  return { width: window.innerWidth, height: window.innerHeight };
}

function currentUserAgent(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const value = navigator.userAgent;
  return value ? value : undefined;
}

export function currentSourceRevision(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.querySelector<HTMLMetaElement>('meta[name="opencraft-source-revision"]')?.content?.trim();
  return value ? value : undefined;
}

export function reportRuntimeError(
  error: unknown,
  source: RuntimeErrorReport["source"],
  componentStack?: string,
  resourceUrl?: string,
): void {
  const description = describeUnknown(error);
  if (isResizeObserverDeliveryWarning(description.message)) return;
  const userAgent = currentUserAgent();
  const viewport = currentViewport();
  const sourceRevision = currentSourceRevision();
  const report: RuntimeErrorReport = {
    ...description,
    ...(error instanceof BrowserStorageError ? { storageDiagnostics: error.storageDiagnostics } : {}),
    componentStack,
    resourceUrl,
    source,
    url: currentPageUrl(),
    ...(userAgent ? { userAgent } : {}),
    ...(viewport ? { viewport } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
  };

  recordRuntimeDiagnosticError(report);

  void serverFetch("/__opencraft_runtime_error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => undefined);
}

export function bindSidebarLayoutPersistReporting(store: {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => { readonly phase: string; readonly error: string | null };
}): () => void {
  let lastError: string | null = null;
  const publish = () => {
    const snapshot = store.getSnapshot();
    if (snapshot.phase === "error" && snapshot.error && snapshot.error !== lastError) {
      lastError = snapshot.error;
      reportRuntimeError(new Error(snapshot.error), "sidebar-layout-persist");
      return;
    }
    if (snapshot.phase !== "error") lastError = null;
  };
  publish();
  return store.subscribe(publish);
}

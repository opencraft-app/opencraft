import type { BrowserUrl } from "@opencraft/browser-core";

import {
  decodeHostProxyUrl,
  encodeHostProxyUrl,
  HOST_PROXY_SERVICE_WORKER_SCOPE,
  HOST_PROXY_SERVICE_WORKER_URL,
  isLoopbackHttpUrl,
} from "./host-proxy-url";

const PROTOCOL_VERSION = 1;
interface ProxyFetchMessage {
  readonly type: "opencraft-host-proxy:fetch";
  readonly version: 1;
  readonly requestId: string;
  readonly hostId: string;
  readonly targetUrl: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: ArrayBuffer | null;
}

interface ProxyCancelMessage {
  readonly type: "opencraft-host-proxy:cancel";
  readonly version: 1;
  readonly requestId: string;
}

type ProxyWorkerMessage = ProxyFetchMessage | ProxyCancelMessage;

export type HostProxyFetch = (
  hostId: string,
  targetUrl: string,
  init: RequestInit,
) => Promise<Response>;

function randomBrokerId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function transferableChunk(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}

/**
 * Owns the page side of the Service Worker bridge. Host credentials and TAT
 * connections never cross this boundary; the worker only receives bytes.
 */
export class WebHostProxyBroker {
  readonly brokerId = randomBrokerId();
  private port: MessagePort | null = null;
  private readonly requests = new Map<string, AbortController>();
  private readonly allowedHostIds = new Set<string>();
  private removeControllerListener: (() => void) | null = null;
  private removeWorkerMessageListener: (() => void) | null = null;
  private ready = false;
  private disposed = false;
  private startOperation: Promise<boolean> | null = null;
  private readonly lifetime = new AbortController();

  constructor(private readonly fetchHost: HostProxyFetch) {}

  start(): Promise<boolean> {
    if (this.startOperation) return this.startOperation;
    const operation = this.initialize();
    this.startOperation = operation;
    void operation.then((ready) => {
      if (!ready && this.startOperation === operation) this.startOperation = null;
    }, () => {
      if (this.startOperation === operation) this.startOperation = null;
    });
    return operation;
  }

  /** Only remote loopback navigation depends on this optional capability. */
  prepareNavigation(url: BrowserUrl): Promise<void> | null {
    if (!isLoopbackHttpUrl(url) || (this.ready && !this.disposed)) return null;
    return this.start().then((ready) => {
      if (!ready || this.disposed) throw new Error("Host proxy is unavailable; remote loopback previews are disabled");
    });
  }

  private async initialize(): Promise<boolean> {
    if (this.disposed) throw new Error("Host proxy broker is disposed");
    if (!("serviceWorker" in navigator) || globalThis.isSecureContext !== true) return false;
    const registration = await navigator.serviceWorker.register(HOST_PROXY_SERVICE_WORKER_URL, {
      scope: HOST_PROXY_SERVICE_WORKER_SCOPE,
      updateViaCache: "none",
    });
    // The embedding document is outside this registration's scope. Container.ready
    // waits for the document's controller and may never resolve (or be another SW).
    const worker = await waitForProxyWorker(registration, this.lifetime.signal);
    if (this.disposed || worker === null) return false;
    this.bind(worker);
    void registration.update().catch(() => undefined);
    const controllerChanged = () => {
      if (registration.active?.state === "activated") this.bind(registration.active);
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    this.removeControllerListener = () =>
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    const workerMessage = (event: MessageEvent) => {
      const message = event.data as { readonly type?: unknown; readonly brokerId?: unknown } | null;
      if (message?.type !== "opencraft-host-proxy:rebind-needed"
        || message.brokerId !== this.brokerId) return;
      if (event.source === registration.active) controllerChanged();
    };
    navigator.serviceWorker.addEventListener("message", workerMessage);
    this.removeWorkerMessageListener = () =>
      navigator.serviceWorker.removeEventListener("message", workerMessage);
    this.ready = this.port !== null;
    return this.ready;
  }

  toPhysicalUrl(url: BrowserUrl, hostId: string): BrowserUrl {
    if (!isLoopbackHttpUrl(url)) return url;
    if (!this.ready || this.disposed) throw new Error("Host proxy is not ready");
    this.allowedHostIds.add(hostId);
    return encodeHostProxyUrl({
      appOrigin: window.location.origin,
      brokerId: this.brokerId,
      hostId,
      targetUrl: url,
    });
  }

  toLogicalUrl(url: string, hostId: string): string {
    const decoded = this.decodeOwnedUrl(url);
    return decoded?.brokerId === this.brokerId && decoded.hostId === hostId
      ? decoded.targetUrl
      : url;
  }

  isPhysicalProxyUrl(url: string): boolean {
    const decoded = this.decodeOwnedUrl(url);
    return decoded?.brokerId === this.brokerId;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.ready = false;
    this.removeControllerListener?.();
    this.removeControllerListener = null;
    this.removeWorkerMessageListener?.();
    this.removeWorkerMessageListener = null;
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.port?.close();
    this.port = null;
  }

  private bind(worker: ServiceWorker | null): void {
    if (worker === null || this.disposed) return;
    this.port?.close();
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent<ProxyWorkerMessage>) => {
      const message = event.data;
      if (message?.version !== PROTOCOL_VERSION) return;
      if (message.type === "opencraft-host-proxy:cancel") {
        this.requests.get(message.requestId)?.abort();
        return;
      }
      if (message.type === "opencraft-host-proxy:fetch") void this.handleFetch(message);
    };
    this.port.start();
    worker.postMessage({
      type: "opencraft-host-proxy:bind",
      version: PROTOCOL_VERSION,
      brokerId: this.brokerId,
    }, [channel.port2]);
    this.ready = true;
  }

  private decodeOwnedUrl(url: string) {
    try {
      if (new URL(url).origin !== window.location.origin) return null;
    } catch {
      return null;
    }
    return decodeHostProxyUrl(url);
  }

  private async handleFetch(message: ProxyFetchMessage): Promise<void> {
    if (this.disposed || this.requests.has(message.requestId)) return;
    if (!this.allowedHostIds.has(message.hostId) || !isLoopbackHttpUrl(message.targetUrl)) {
      this.port?.postMessage({
        type: "opencraft-host-proxy:error",
        version: PROTOCOL_VERSION,
        requestId: message.requestId,
        message: "The requested Host proxy route is not owned by this Workbench",
      });
      return;
    }
    const abort = new AbortController();
    this.requests.set(message.requestId, abort);
    try {
      const response = await this.fetchHost(message.hostId, message.targetUrl, {
        method: message.method,
        headers: message.headers.map(([name, value]): [string, string] => [name, value]),
        signal: abort.signal,
        ...(message.body === null ? {} : { body: message.body }),
      });
      const headers = [...response.headers.entries()].filter(([name]) =>
        !["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]
          .includes(name.toLowerCase()));
      this.port?.postMessage({
        type: "opencraft-host-proxy:head",
        version: PROTOCOL_VERSION,
        requestId: message.requestId,
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      if (response.body === null) {
        this.port?.postMessage({
          type: "opencraft-host-proxy:end",
          version: PROTOCOL_VERSION,
          requestId: message.requestId,
        });
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const body = transferableChunk(chunk.value);
        this.port?.postMessage({
          type: "opencraft-host-proxy:chunk",
          version: PROTOCOL_VERSION,
          requestId: message.requestId,
          body,
        }, [body]);
      }
      this.port?.postMessage({
        type: "opencraft-host-proxy:end",
        version: PROTOCOL_VERSION,
        requestId: message.requestId,
      });
    } catch (error) {
      this.port?.postMessage({
        type: "opencraft-host-proxy:error",
        version: PROTOCOL_VERSION,
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.requests.delete(message.requestId);
    }
  }
}

function waitForProxyWorker(registration: ServiceWorkerRegistration, signal: AbortSignal): Promise<ServiceWorker | null> {
  return new Promise((resolve) => {
    const watched = new Set<ServiceWorker>();
    const finish = (worker: ServiceWorker | null) => {
      clearTimeout(timer);
      registration.removeEventListener("updatefound", check);
      signal.removeEventListener("abort", aborted);
      for (const candidate of watched) candidate.removeEventListener("statechange", check);
      resolve(worker);
    };
    const aborted = () => finish(null);
    const check = () => {
      if (signal.aborted) { finish(null); return; }
      if (registration.active?.state === "activated") { finish(registration.active); return; }
      for (const candidate of [registration.installing, registration.waiting, registration.active]) {
        if (candidate && !watched.has(candidate)) {
          watched.add(candidate);
          candidate.addEventListener("statechange", check);
        }
      }
    };
    const timer = setTimeout(() => finish(null), 4_000);
    registration.addEventListener("updatefound", check);
    signal.addEventListener("abort", aborted, { once: true });
    check();
  });
}

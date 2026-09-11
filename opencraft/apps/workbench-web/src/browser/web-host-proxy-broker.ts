import type { BrowserUrl } from "@opencraft/browser-core";

import {
  decodeHostProxyUrl,
  encodeHostProxyUrl,
  isLoopbackHttpUrl,
} from "./host-proxy-url";

const PROTOCOL_VERSION = 1;
const SERVICE_WORKER_URL = "/opencraft-host-proxy-sw.js";

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

  constructor(private readonly fetchHost: HostProxyFetch) {}

  async start(): Promise<boolean> {
    if (this.disposed) throw new Error("Host proxy broker is disposed");
    if (!("serviceWorker" in navigator) || globalThis.isSecureContext !== true) return false;
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    });
    const readyRegistration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => globalThis.setTimeout(() => resolve(null), 4_000)),
    ]);
    await registration.update().catch(() => undefined);
    this.bind(
      navigator.serviceWorker.controller
      ?? readyRegistration?.active
      ?? registration.active
      ?? registration.waiting,
    );
    const controllerChanged = () => this.bind(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    this.removeControllerListener = () =>
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    const workerMessage = (event: MessageEvent) => {
      const message = event.data as { readonly type?: unknown; readonly brokerId?: unknown } | null;
      if (message?.type !== "opencraft-host-proxy:rebind-needed"
        || message.brokerId !== this.brokerId) return;
      this.bind(event.source instanceof ServiceWorker
        ? event.source
        : navigator.serviceWorker.controller);
    };
    navigator.serviceWorker.addEventListener("message", workerMessage);
    this.removeWorkerMessageListener = () =>
      navigator.serviceWorker.removeEventListener("message", workerMessage);
    this.ready = this.port !== null;
    return this.ready;
  }

  toPhysicalUrl(url: BrowserUrl, hostId: string): BrowserUrl {
    if (!this.ready || !isLoopbackHttpUrl(url)) return url;
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

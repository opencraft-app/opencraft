import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { isHermesWebTextResponse, rewriteTatWebTextPayload } from "@/lib/tat-hermes-web-proxy-rewrite";
import { createTatHermesWebFetch, createTatPortFetch, type TatHttpVirtualFetch } from "@/lib/tat-http-virtual-client";

type HermesWebStatus = "idle" | "registering" | "ready" | "error";

interface HermesProxyRequest {
  type: "tat-hermes-proxy-request";
  requestId: string;
  botId: string;
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer | null;
}

interface HermesProxyResponse {
  type: "tat-hermes-proxy-response";
  requestId: string;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  body?: ArrayBuffer;
  stream?: boolean;
  error?: string;
}

interface HermesProxyAckWaiter {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

export interface TatHermesProxyDiagnostic {
  pending: number;
  lastUrl: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSize: number | null;
  updatedAt: number | null;
}

const SERVICE_WORKER_URL = "/tat-hermes-web-proxy-sw.js";
const PROXY_PREFIX = "/__tat_hermes_proxy";
const SERVICE_WORKER_SCOPE = "/";
const BROKER_REGISTRATION_HEARTBEAT_MS = 60_000;

export type TatWebProxyTarget = "hermes" | "deepseek-harness";

const targetConfig = (target: TatWebProxyTarget, botId: string) => target === "deepseek-harness"
  ? { brokerId: `dsh--${botId}`, port: 3080 }
  : { brokerId: botId, port: 9119 };

const proxyBaseFor = (botId: string) => `${PROXY_PREFIX}/${encodeURIComponent(botId)}`;

const initialDiagnostic = (): TatHermesProxyDiagnostic => ({
  pending: 0,
  lastUrl: null,
  lastStatus: null,
  lastError: null,
  lastSize: null,
  updatedAt: null,
});

const isHermesProxyRequest = (value: unknown): value is HermesProxyRequest => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "tat-hermes-proxy-request" && typeof record.requestId === "string" && typeof record.botId === "string";
};

const responseHeadersToEntries = (headers: Headers) => {
  const excludedHeaders = new Set([
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const entries: [string, string][] = [];
  headers.forEach((value, key) => {
    if (!excludedHeaders.has(key.toLowerCase())) {
      entries.push([key, value]);
    }
  });
  return entries;
};

const clearHermesProxyAckWaiter = (waiter: HermesProxyAckWaiter | null) => {
  if (waiter) {
    window.clearTimeout(waiter.timer);
  }
};

const waitForServiceWorkerActivation = (registration: ServiceWorkerRegistration) => {
  const candidate = registration.active ?? registration.waiting ?? registration.installing;
  if (!candidate || candidate.state === "activated") {
    return Promise.resolve();
  }
  const worker = candidate;
  if (registration.waiting) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      worker.removeEventListener("statechange", handleStateChange);
      reject(new Error("Hermes WebUI proxy Service Worker activation timed out."));
    }, 10_000);
    function handleStateChange() {
      if (worker.state === "activated") {
        window.clearTimeout(timer);
        worker.removeEventListener("statechange", handleStateChange);
        resolve();
      }
    }
    worker.addEventListener("statechange", handleStateChange);
  });
};

const postHermesBrokerRegistration = (worker: ServiceWorker | null, botId: string, registered: boolean) => {
  worker?.postMessage({
    type: registered ? "tat-hermes-proxy-broker-register" : "tat-hermes-proxy-broker-unregister",
    botId,
  });
};

export const useTatHermesProxyBroker = (botId: string, target: TatWebProxyTarget = "hermes") => {
  const t = useT();
  const repositories = useRepositories();
  const tRef = useRef(t);
  const fetchRef = useRef<TatHttpVirtualFetch | null>(null);
  const responseCacheRef = useRef(new Map<string, { message: HermesProxyResponse; body?: ArrayBuffer }>());
  const pendingRequestsRef = useRef(new Map<string, Promise<HermesProxyResponse>>());
  const [status, setStatus] = useState<HermesWebStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [diagnostic, setDiagnostic] = useState<TatHermesProxyDiagnostic>(initialDiagnostic);

  const config = useMemo(() => targetConfig(target, botId), [botId, target]);
  const proxyBase = useMemo(() => proxyBaseFor(config.brokerId), [config.brokerId]);
  const frameUrl = useMemo(() => `${proxyBase}/`, [proxyBase]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const getHermesWebFetch = useCallback(async () => {
    if (fetchRef.current) {
      return fetchRef.current;
    }
    const bootstrap = await repositories.bots.getTerminalSession(botId);
    const tatFetch = target === "deepseek-harness"
      ? createTatPortFetch(bootstrap, config.port)
      : createTatHermesWebFetch(bootstrap);
    fetchRef.current = tatFetch;
    return tatFetch;
  }, [botId, config.port, repositories.bots, target]);

  useEffect(() => {
    return () => {
      fetchRef.current?.close();
      fetchRef.current = null;
    };
  }, []);

  useEffect(() => {
    fetchRef.current?.close();
    fetchRef.current = null;
    responseCacheRef.current.clear();
    pendingRequestsRef.current.clear();
    setDiagnostic(initialDiagnostic());
    setReloadKey((key) => key + 1);
  }, [botId, target]);

  useEffect(() => {
    let cancelled = false;
    let activeWorker: ServiceWorker | null = null;
    let heartbeatTimer: number | null = null;

    const register = async () => {
      if (!("serviceWorker" in navigator)) {
        setStatus("error");
        setError(tRef.current("当前浏览器不支持 Service Worker，无法直接展示 Hermes WebUI。"));
        return;
      }
      try {
        setStatus("registering");
        setError(null);
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          registrations
            .filter((registration) => registration.scope.endsWith(`${PROXY_PREFIX}/`))
            .map((registration) => registration.unregister()),
        );
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
          scope: SERVICE_WORKER_SCOPE,
        });
        await waitForServiceWorkerActivation(registration);
        activeWorker = registration.active ?? (await navigator.serviceWorker.ready).active;
        postHermesBrokerRegistration(activeWorker, config.brokerId, true);
        heartbeatTimer = window.setInterval(() => {
          postHermesBrokerRegistration(activeWorker, config.brokerId, true);
        }, BROKER_REGISTRATION_HEARTBEAT_MS);
        if (!cancelled) {
          setStatus("ready");
        }
      } catch (registerError) {
        if (!cancelled) {
          setStatus("error");
          setError(registerError instanceof Error ? registerError.message : tRef.current("Hermes WebUI 代理启动失败。"));
        }
      }
    };

    void register();
    return () => {
      cancelled = true;
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
      }
      postHermesBrokerRegistration(activeWorker, config.brokerId, false);
    };
  }, [config.brokerId]);

  useEffect(() => {
    const streamResponseBody = async (request: HermesProxyRequest, port: MessagePort, response: Response) => {
      if (!response.body) {
        port.postMessage({
          type: "tat-hermes-proxy-done",
          requestId: request.requestId,
        });
        return 0;
      }

      let cancelled = false;
      let sequence = 0;
      let sentBytes = 0;
      let waitingAck: HermesProxyAckWaiter | null = null;

      port.onmessage = (event) => {
        const message = event.data || {};
        if (message.requestId !== request.requestId) {
          return;
        }
        if (message.type === "tat-hermes-proxy-cancel") {
          cancelled = true;
          if (waitingAck) {
            window.clearTimeout(waitingAck.timer);
            waitingAck.reject(new Error("Hermes WebUI proxy stream cancelled"));
            waitingAck = null;
          }
          return;
        }
        if (message.type === "tat-hermes-proxy-ack" && waitingAck && message.sequence === waitingAck.sequence) {
          window.clearTimeout(waitingAck.timer);
          waitingAck.resolve();
          waitingAck = null;
        }
      };

      const waitForAck = (chunkSequence: number) =>
        new Promise<void>((resolve, reject) => {
          waitingAck = {
            sequence: chunkSequence,
            resolve,
            reject,
            timer: window.setTimeout(() => {
              waitingAck = null;
              reject(new Error("Hermes WebUI proxy stream ack timed out"));
            }, 30_000),
          };
        });

      const reader = response.body.getReader();
      try {
        while (true) {
          if (cancelled) {
            throw new Error("Hermes WebUI proxy stream cancelled");
          }
          const result = await reader.read();
          if (result.done) {
            break;
          }
          const ownedChunk = result.value.slice();
          const buffer = ownedChunk.buffer as ArrayBuffer;
          const chunkSequence = sequence;
          sequence += 1;
          sentBytes += ownedChunk.byteLength;
          port.postMessage(
            {
              type: "tat-hermes-proxy-chunk",
              requestId: request.requestId,
              sequence: chunkSequence,
              chunk: buffer,
            },
            [buffer],
          );
          await waitForAck(chunkSequence);
        }
        port.postMessage({
          type: "tat-hermes-proxy-done",
          requestId: request.requestId,
        });
        return sentBytes;
      } finally {
        clearHermesProxyAckWaiter(waitingAck);
        reader.releaseLock();
      }
    };

    const getProxyResponse = (request: HermesProxyRequest, port: MessagePort) => {
      const cached = responseCacheRef.current.get(request.requestId);
      if (cached) {
        return Promise.resolve(cached.message);
      }
      const pending = pendingRequestsRef.current.get(request.requestId);
      if (pending) {
        return pending;
      }

      const proxyPromise = (async (): Promise<HermesProxyResponse> => {
        setDiagnostic((current) => ({
          ...current,
          pending: current.pending + 1,
          lastUrl: request.url,
          lastError: null,
          updatedAt: Date.now(),
        }));
        try {
          const tatFetch = await getHermesWebFetch();
          const response = await tatFetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body ?? undefined,
          });
          const contentType = response.headers.get("content-type") ?? "";
          const headers = responseHeadersToEntries(response.headers);
          if (!isHermesWebTextResponse(contentType) && response.body) {
            const message: HermesProxyResponse = {
              type: "tat-hermes-proxy-response",
              requestId: request.requestId,
              status: response.status,
              statusText: response.statusText,
              headers,
              stream: true,
            };
            port.postMessage(message);
            const sentBytes = await streamResponseBody(request, port, response);
            setDiagnostic((current) => ({
              ...current,
              pending: Math.max(0, current.pending - 1),
              lastStatus: `${response.status} ${response.statusText}`.trim(),
              lastError: null,
              lastSize: sentBytes,
              updatedAt: Date.now(),
            }));
            return message;
          }

          let body = await response.arrayBuffer();
          if (isHermesWebTextResponse(contentType) && body.byteLength > 0) {
            const text = new TextDecoder().decode(body);
            const rewritten = rewriteTatWebTextPayload(text, contentType, proxyBase, config.port);
            body = new TextEncoder().encode(rewritten).buffer;
          }
          const message: HermesProxyResponse = {
            type: "tat-hermes-proxy-response",
            requestId: request.requestId,
            status: response.status,
            statusText: response.statusText,
            headers,
            body,
          };
          responseCacheRef.current.set(request.requestId, { message, body });
          setDiagnostic((current) => ({
            ...current,
            pending: Math.max(0, current.pending - 1),
            lastStatus: `${response.status} ${response.statusText}`.trim(),
            lastError: null,
            lastSize: body.byteLength,
            updatedAt: Date.now(),
          }));
          return message;
        } catch (proxyError) {
          const message: HermesProxyResponse = {
            type: "tat-hermes-proxy-response",
            requestId: request.requestId,
            error: proxyError instanceof Error ? proxyError.message : String(proxyError),
          };
          responseCacheRef.current.set(request.requestId, { message });
          setDiagnostic((current) => ({
            ...current,
            pending: Math.max(0, current.pending - 1),
            lastStatus: null,
            lastError: message.error ?? "unknown proxy error",
            lastSize: null,
            updatedAt: Date.now(),
          }));
          return message;
        } finally {
          pendingRequestsRef.current.delete(request.requestId);
        }
      })();

      pendingRequestsRef.current.set(request.requestId, proxyPromise);
      return proxyPromise;
    };

    const handleMessage = (event: MessageEvent) => {
      const port = event.ports[0];
      if (!port || !isHermesProxyRequest(event.data) || event.data.botId !== config.brokerId) {
        return;
      }
      port.postMessage({
        type: "tat-hermes-proxy-accepted",
        requestId: event.data.requestId,
      });
      void getProxyResponse(event.data, port).then((message) => {
        if (message.stream) {
          return;
        }
        port.postMessage(message);
      });
    };

    navigator.serviceWorker?.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
    };
  }, [config.brokerId, config.port, getHermesWebFetch, proxyBase]);

  const reload = useCallback(() => {
    responseCacheRef.current.clear();
    setDiagnostic((current) => ({
      ...current,
      pending: 0,
      lastError: null,
      updatedAt: Date.now(),
    }));
    setReloadKey((key) => key + 1);
  }, []);

  return {
    diagnostic,
    error,
    frameUrl,
    reload,
    reloadKey,
    status,
  };
};

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTatHermesProxyBroker } from "@/components/domain/use-tat-hermes-proxy-broker";
import { createTatHermesWebFetch, createTatPortFetch, type TatHttpVirtualFetch } from "@/lib/tat-http-virtual-client";

const getTerminalSession = vi.fn();
const tatFetch = Object.assign(vi.fn(), {
  close: vi.fn(),
  json: vi.fn(),
}) as unknown as TatHttpVirtualFetch & {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  close: { mockReset: () => void };
  json: { mockReset: () => void };
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      getTerminalSession,
    },
  }),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (value: string) => value,
}));

vi.mock("@/lib/tat-http-virtual-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tat-http-virtual-client")>("@/lib/tat-http-virtual-client");
  return {
    ...actual,
    createTatHermesWebFetch: vi.fn(),
    createTatPortFetch: vi.fn(),
  };
});

const bootstrap = {
  sandboxId: "sb-1",
  poolId: "pool-1",
  sessionId: "session-1",
  region: "ap-guangzhou",
  instanceId: "rins-web001",
  ownerUin: "10001",
  loginUin: "10002",
  appId: 1250000000,
  wsUrl: "wss://ap-guangzhou.forward.tat-tc.tencent.cn/ws",
  cols: 120,
  rows: 32,
  timeoutSeconds: 3600,
};

type ServiceWorkerMessageHandler = (event: MessageEvent) => void;

let handlers: ServiceWorkerMessageHandler[];

const encode = (value: string) => new TextEncoder().encode(value);

const nextPortMessage = (port: MessagePort) =>
  new Promise<unknown>((resolve) => {
    port.onmessage = (event) => {
      resolve(event.data);
    };
  });

const decodeBody = (body: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(body));

const makeStreamResponse = (chunks: Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
      },
    },
  );

const dispatchProxyRequest = async (request: Record<string, unknown>) => {
  const channel = new MessageChannel();
  await act(async () => {
    handlers[0]?.(new MessageEvent("message", { data: request, ports: [channel.port2] }));
  });
  return channel;
};

describe("useTatHermesProxyBroker", () => {
  let workerMessages: unknown[];

  beforeEach(() => {
    handlers = [];
    workerMessages = [];
    getTerminalSession.mockResolvedValue(bootstrap);
    tatFetch.mockReset();
    tatFetch.close.mockReset();
    tatFetch.json.mockReset();
    vi.mocked(createTatHermesWebFetch).mockReset();
    vi.mocked(createTatPortFetch).mockReset();
    vi.mocked(createTatHermesWebFetch).mockReturnValue(tatFetch);
    vi.mocked(createTatPortFetch).mockReturnValue(tatFetch);

    const worker = {
      state: "activated",
      postMessage: (message: unknown) => {
        workerMessages.push(message);
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: (_type: string, handler: ServiceWorkerMessageHandler) => {
          handlers.push(handler);
        },
        removeEventListener: (_type: string, handler: ServiceWorkerMessageHandler) => {
          handlers = handlers.filter((candidate) => candidate !== handler);
        },
        getRegistrations: vi.fn().mockResolvedValue([]),
        ready: Promise.resolve({ active: worker }),
        register: vi.fn().mockResolvedValue({
          active: worker,
          waiting: null,
          installing: null,
          scope: "http://localhost/",
        }),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams binary WebUI proxy responses through MessagePort chunks with ack backpressure", async () => {
    tatFetch.mockResolvedValue(makeStreamResponse([encode("abc"), encode("def")]));
    const { result, unmount } = renderHook(() => useTatHermesProxyBroker("ins-stream"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(workerMessages).toContainEqual({
      type: "tat-hermes-proxy-broker-register",
      botId: "ins-stream",
    });

    const channel = new MessageChannel();
    const request = {
      type: "tat-hermes-proxy-request",
      requestId: "req-stream",
      botId: "ins-stream",
      method: "GET",
      url: "/assets/app.bin",
      headers: [["accept", "*/*"]],
      body: null,
    };

    await act(async () => {
      handlers[0]?.(new MessageEvent("message", { data: request, ports: [channel.port2] }));
    });

    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-accepted",
      requestId: "req-stream",
    });
    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-response",
      requestId: "req-stream",
      status: 200,
      stream: true,
    });

    const firstChunk = (await nextPortMessage(channel.port1)) as Record<string, unknown>;
    expect(firstChunk).toMatchObject({
      type: "tat-hermes-proxy-chunk",
      requestId: "req-stream",
      sequence: 0,
    });
    expect(new TextDecoder().decode(new Uint8Array(firstChunk.chunk as ArrayBuffer))).toBe("abc");
    channel.port1.postMessage({
      type: "tat-hermes-proxy-ack",
      requestId: "req-stream",
      sequence: 0,
    });

    const secondChunk = (await nextPortMessage(channel.port1)) as Record<string, unknown>;
    expect(secondChunk).toMatchObject({
      type: "tat-hermes-proxy-chunk",
      requestId: "req-stream",
      sequence: 1,
    });
    expect(new TextDecoder().decode(new Uint8Array(secondChunk.chunk as ArrayBuffer))).toBe("def");
    channel.port1.postMessage({
      type: "tat-hermes-proxy-ack",
      requestId: "req-stream",
      sequence: 1,
    });

    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-done",
      requestId: "req-stream",
    });
    await waitFor(() => {
      expect(result.current.diagnostic.lastSize).toBe(6);
    });
    expect(tatFetch).toHaveBeenCalledTimes(1);
    expect(tatFetch).toHaveBeenCalledWith("/assets/app.bin", {
      method: "GET",
      headers: [["accept", "*/*"]],
      body: undefined,
    });

    unmount();
    expect(workerMessages).toContainEqual({
      type: "tat-hermes-proxy-broker-unregister",
      botId: "ins-stream",
    });
  });

  it("uses a dedicated broker identity and port for DeepSeek Harness", async () => {
    tatFetch.mockResolvedValue(new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } }));
    const { result, unmount } = renderHook(() => useTatHermesProxyBroker("ins-dsh", "deepseek-harness"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.frameUrl).toBe("/__tat_hermes_proxy/dsh--ins-dsh/");

    const channel = await dispatchProxyRequest({
      type: "tat-hermes-proxy-request",
      requestId: "req-dsh",
      botId: "dsh--ins-dsh",
      method: "GET",
      url: "/",
      headers: [],
      body: null,
    });
    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-accepted",
      requestId: "req-dsh",
    });
    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-response",
      requestId: "req-dsh",
      status: 200,
    });
    expect(createTatPortFetch).toHaveBeenCalledWith(bootstrap, 3080);
    expect(createTatHermesWebFetch).not.toHaveBeenCalled();
    expect(workerMessages).toContainEqual({
      type: "tat-hermes-proxy-broker-register",
      botId: "dsh--ins-dsh",
    });

    unmount();
    expect(workerMessages).toContainEqual({
      type: "tat-hermes-proxy-broker-unregister",
      botId: "dsh--ins-dsh",
    });
  });

  it("does not let a broker for another bot accept the WebUI proxy request", async () => {
    const { result } = renderHook(() => useTatHermesProxyBroker("ins-owned"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const channel = await dispatchProxyRequest({
      type: "tat-hermes-proxy-request",
      requestId: "req-other-bot",
      botId: "ins-other",
      method: "GET",
      url: "/",
      headers: [],
      body: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(tatFetch).not.toHaveBeenCalled();

    const portMessage = await Promise.race([
      nextPortMessage(channel.port1),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 10)),
    ]);
    expect(portMessage).toBeNull();
  });

  it("buffers and rewrites text WebUI responses instead of streaming them", async () => {
    tatFetch.mockResolvedValue(
      new Response('<html><head></head><body><script src="/assets/app.js"></script></body></html>', {
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": "77",
          "Connection": "keep-alive",
        },
      }),
    );
    const { result } = renderHook(() => useTatHermesProxyBroker("ins-text"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const channel = await dispatchProxyRequest({
      type: "tat-hermes-proxy-request",
      requestId: "req-text",
      botId: "ins-text",
      method: "GET",
      url: "/",
      headers: [["accept", "text/html"]],
      body: null,
    });

    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-accepted",
      requestId: "req-text",
    });
    const responseMessage = (await nextPortMessage(channel.port1)) as Record<string, unknown>;
    expect(responseMessage).toMatchObject({
      type: "tat-hermes-proxy-response",
      requestId: "req-text",
      status: 200,
    });
    expect(responseMessage.stream).toBeUndefined();
    expect(responseMessage.headers).toEqual([["content-type", "text/html; charset=utf-8"]]);
    const body = decodeBody(responseMessage.body as ArrayBuffer);
    expect(body).toContain("/__tat_hermes_proxy/ins-text/assets/app.js");
    expect(body).toContain('const base = "/__tat_hermes_proxy/ins-text/";');
    await waitFor(() => {
      expect(result.current.diagnostic.lastSize).toBeGreaterThan(77);
    });
  });

  it("returns the cached rewritten text response when the same request is replayed", async () => {
    tatFetch.mockResolvedValue(
      new Response('<html><body><a href="/dashboard">Dashboard</a></body></html>', {
        status: 200,
        statusText: "OK",
        headers: {
          "Content-Type": "text/html",
        },
      }),
    );
    const { result } = renderHook(() => useTatHermesProxyBroker("ins-cache"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const request = {
      type: "tat-hermes-proxy-request",
      requestId: "req-cache",
      botId: "ins-cache",
      method: "GET",
      url: "/index.html",
      headers: [],
      body: null,
    };
    const firstChannel = await dispatchProxyRequest(request);
    await nextPortMessage(firstChannel.port1);
    const firstResponse = (await nextPortMessage(firstChannel.port1)) as Record<string, unknown>;

    const secondChannel = await dispatchProxyRequest(request);
    await nextPortMessage(secondChannel.port1);
    const secondResponse = (await nextPortMessage(secondChannel.port1)) as Record<string, unknown>;

    expect(tatFetch).toHaveBeenCalledTimes(1);
    expect(decodeBody(secondResponse.body as ArrayBuffer)).toBe(decodeBody(firstResponse.body as ArrayBuffer));
    expect(decodeBody(secondResponse.body as ArrayBuffer)).toContain("/__tat_hermes_proxy/ins-cache/dashboard");
  });

  it("surfaces a stream cancellation as a proxy error and clears pending diagnostics", async () => {
    tatFetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode("first"));
            controller.enqueue(encode("second"));
          },
        }),
        {
          status: 200,
          statusText: "OK",
          headers: {
            "Content-Type": "application/octet-stream",
          },
        },
      ),
    );
    const { result } = renderHook(() => useTatHermesProxyBroker("ins-cancel"));

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    const channel = await dispatchProxyRequest({
      type: "tat-hermes-proxy-request",
      requestId: "req-cancel",
      botId: "ins-cancel",
      method: "GET",
      url: "/large.bin",
      headers: [],
      body: null,
    });

    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-accepted",
      requestId: "req-cancel",
    });
    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-response",
      requestId: "req-cancel",
      stream: true,
    });
    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-chunk",
      requestId: "req-cancel",
      sequence: 0,
    });

    channel.port1.postMessage({
      type: "tat-hermes-proxy-cancel",
      requestId: "req-cancel",
    });

    await expect(nextPortMessage(channel.port1)).resolves.toMatchObject({
      type: "tat-hermes-proxy-response",
      requestId: "req-cancel",
      error: "Hermes WebUI proxy stream cancelled",
    });
    await waitFor(() => {
      expect(result.current.diagnostic.pending).toBe(0);
      expect(result.current.diagnostic.lastError).toBe("Hermes WebUI proxy stream cancelled");
    });
  });
});

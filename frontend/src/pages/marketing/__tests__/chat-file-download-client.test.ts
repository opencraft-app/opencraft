import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTerminalSession } from "@/domain/types";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  fileInfo: vi.fn(async () => ({ type: "-", name: "result.csv", size: 3, owner: 1000, rights: "rw-------" })),
  downloadFile: vi.fn(async () => new Blob(["abc"])),
  downloadFileToSink: vi.fn(async (_path: string, sink: { write: (chunk: Uint8Array) => Promise<void> }) => {
    await sink.write(new Uint8Array([1, 2, 3]));
  }),
  close: vi.fn(),
}));

vi.mock("@/lib/tencent-tssh-file-client", () => ({
  TencentTsshFileClient: class {
    connect = mocks.connect;
    fileInfo = mocks.fileInfo;
    downloadFile = mocks.downloadFile;
    downloadFileToSink = mocks.downloadFileToSink;
    close = mocks.close;
  },
}));

import { ChatFileDownloader } from "../chat-file-download";

const translate = (value: string, options?: Record<string, unknown>) =>
  value.replace(/\{\{(\w+)\}\}/gu, (_, key: string) => String(options?.[key] ?? ""));

beforeEach(() => {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:test");
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.fileInfo.mockReset();
  mocks.fileInfo.mockResolvedValue({ type: "-", name: "result.csv", size: 3, owner: 1000, rights: "rw-------" });
  mocks.downloadFile.mockClear();
  mocks.downloadFileToSink.mockClear();
  mocks.connect.mockClear();
  mocks.close.mockClear();
});

describe("ChatFileDownloader", () => {
  const getSession = vi.fn(async () => ({} as BotTerminalSession));

  it("uses the TSSH file channel and saves a permitted file", async () => {
    const status = vi.fn();
    const downloader = new ChatFileDownloader("bot-1", getSession, status, translate);
    await downloader.download("/home/agentuser/output/result.csv");
    expect(getSession).toHaveBeenCalledWith("bot-1");
    expect(mocks.fileInfo).toHaveBeenCalledWith("/home/agentuser/output/result.csv");
    expect(mocks.downloadFile).toHaveBeenCalledWith("/home/agentuser/output/result.csv");
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith("done");
    downloader.dispose();
  });

  it("rejects traversal and unreadable files before downloading", async () => {
    const downloader = new ChatFileDownloader("bot-1", getSession, vi.fn(), translate);
    await expect(downloader.download("/home/agentuser/output/../secret")).rejects.toThrow("只能访问");
    mocks.fileInfo.mockResolvedValue({ type: "-", name: "secret", size: 3, owner: 2000, rights: "---------" });
    await expect(downloader.download("/home/agentuser/secret")).rejects.toThrow("没有可读权限");
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    downloader.dispose();
  });

  it("does not connect or save after the Chat surface is disposed", async () => {
    let resolveSession!: (session: BotTerminalSession) => void;
    const delayedSession = new Promise<BotTerminalSession>((resolve) => { resolveSession = resolve; });
    const downloader = new ChatFileDownloader("bot-1", () => delayedSession, vi.fn(), translate);
    const download = downloader.download("/home/agentuser/output/result.csv");
    downloader.dispose();
    resolveSession({} as BotTerminalSession);
    await download;
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("streams through the same service worker protocol as cloud storage", async () => {
    let onWorkerMessage: ((event: MessageEvent) => void) | undefined;
    class TestMessageChannel {
      port1 = { onmessage: null as ((event: MessageEvent) => void) | null, close: vi.fn() };
      port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data } as MessageEvent) };
    }
    vi.stubGlobal("MessageChannel", TestMessageChannel);
    const worker = {
      state: "activated",
      postMessage: (_message: unknown, ports: Array<{ postMessage: (data: unknown) => void }>) =>
        ports[0]?.postMessage({ type: "TAT_FILE_DOWNLOAD_READY", version: "tat-file-download-v6" }),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { onWorkerMessage = listener; },
        removeEventListener: vi.fn(),
        register: vi.fn(async () => ({ active: worker, update: async () => undefined })),
        ready: Promise.resolve({ active: worker }),
      },
    });
    const status = vi.fn();
    const downloader = new ChatFileDownloader("bot-1", getSession, status, translate);
    await downloader.download("/home/agentuser/output/result.csv");
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      close: vi.fn(),
      postMessage: vi.fn((message: { type: string; requestId: string; sequence?: number }) => {
        if (message.type === "tat-file-download-chunk") {
          queueMicrotask(() => port.onmessage?.({ data: {
            type: "tat-file-download-ack", requestId: message.requestId, sequence: message.sequence,
          } } as MessageEvent));
        }
      }),
    };
    onWorkerMessage?.({ data: {
      type: "tat-file-download-request", requestId: "request-1", botId: "bot-1", path: "/home/agentuser/output/result.csv",
    }, ports: [port] } as unknown as MessageEvent);
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("done"));
    expect(mocks.downloadFileToSink).toHaveBeenCalledWith("/home/agentuser/output/result.csv", expect.any(Object));
    expect(port.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "tat-file-download-accepted", "tat-file-download-chunk", "tat-file-download-done",
    ]);
    expect(mocks.close).toHaveBeenCalled();
    downloader.dispose();
  });
});

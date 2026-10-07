import type { BotTerminalSession } from "@/domain/types";
import type { TranslateFn } from "@/i18n/t";
import { TencentTsshFileClient } from "@/lib/tencent-tssh-file-client";
import { canReadTsshFile } from "@/lib/tssh-file-permissions";

const MANAGED_ROOT = "/home/agentuser";
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MEMORY_FALLBACK_BYTES = 8 * 1024 * 1024;
const WORKER_VERSION = "tat-file-download-v6";
const PERMISSION_SUBJECT = { uid: 1000, gid: 1000, groups: [1000], userName: "agentuser" };
const MANAGED_TEXT_PATH = /\/home\/agentuser\/[^\s"'`<>{}()[\]，。！？；：、#?]+/gu;

function isManagedFilePath(path: string): boolean {
  return path.startsWith(`${MANAGED_ROOT}/`)
    && !path.split("/").some((segment) => segment === "." || segment === "..")
    && !/[\\\0]/u.test(path);
}

export interface ChatFileHit {
  readonly path: string;
  readonly rects: readonly DOMRect[];
}

export function chatFileHitFromEvent(event: MouseEvent): ChatFileHit | null {
  const anchor = event.composedPath().find((node): node is HTMLAnchorElement =>
    node instanceof HTMLAnchorElement &&
    ["file", "workspace-file"].includes(node.dataset.chatResourceKind ?? ""),
  );
  if (!anchor) return plainFileHitFromEvent(event);
  try {
    const url = new URL(anchor.href);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    const path = decodeURIComponent(url.pathname);
    return isManagedFilePath(path) ? { path, rects: Array.from(anchor.getClientRects()) } : null;
  } catch {
    return null;
  }
}

export function chatFilePathFromEvent(event: MouseEvent): string | null {
  return chatFileHitFromEvent(event)?.path ?? null;
}

function plainFileHitFromEvent(event: MouseEvent): ChatFileHit | null {
  const target = event.composedPath()[0];
  if (!(target instanceof Element) || !target.closest(".opencraft-chat-document")
    || target.closest("a, button, pre, [contenteditable]")) return null;
  const container = target.closest("strong, code, p, li, td") ?? target;
  if (!container.textContent?.includes(`${MANAGED_ROOT}/`)) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const content = nodes.map((node) => node.data).join("");
  const position = (offset: number): { node: Text; offset: number } | null => {
    for (const node of nodes) {
      if (offset <= node.length) return { node, offset };
      offset -= node.length;
    }
    return null;
  };
  for (const match of content.matchAll(MANAGED_TEXT_PATH)) {
    const path = match[0].replace(/[.,;:!]+$/u, "");
    if (!isManagedFilePath(path)) continue;
    const start = position(match.index);
    const end = position(match.index + path.length);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rects = Array.from(range.getClientRects());
    if (rects.some((rect) =>
      event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom,
    )) return { path, rects };
  }
  return null;
}

interface DownloadRequest {
  readonly type: "tat-file-download-request";
  readonly requestId: string;
  readonly botId: string;
  readonly path: string;
}

function isDownloadRequest(value: unknown): value is DownloadRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "tat-file-download-request"
    && typeof record.requestId === "string"
    && typeof record.botId === "string"
    && typeof record.path === "string";
}

async function registerDownloadWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.register(`/tat-hermes-web-proxy-sw.js?v=${WORKER_VERSION}`, { scope: "/" });
  await registration.update().catch(() => undefined);
  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  const candidate = registration.waiting ?? registration.installing ?? registration.active;
  if (candidate && candidate.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Download service worker activation timed out")), 10_000);
      const onChange = () => {
        if (candidate.state !== "activated") return;
        window.clearTimeout(timer);
        candidate.removeEventListener("statechange", onChange);
        resolve();
      };
      candidate.addEventListener("statechange", onChange);
    });
  }
  const worker = registration.active ?? (await navigator.serviceWorker.ready).active;
  if (!worker) return false;
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => { channel.port1.close(); resolve(false); }, 2_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      channel.port1.close();
      const message = event.data as Record<string, unknown>;
      resolve(message.type === "TAT_FILE_DOWNLOAD_READY" && message.version === WORKER_VERSION);
    };
    worker.postMessage({ type: "PING_TAT_FILE_DOWNLOAD" }, [channel.port2]);
  });
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

type PendingDownload = { client: TencentTsshFileClient; iframe: HTMLIFrameElement; timer: number };

export class ChatFileDownloader {
  private readonly pending = new Map<string, PendingDownload[]>();
  private disposed = false;

  constructor(
    private readonly botId: string,
    private readonly getSession: (botId: string) => Promise<BotTerminalSession>,
    private readonly onStatus: (message: string | null) => void,
    private readonly t: TranslateFn,
  ) {
    navigator.serviceWorker?.addEventListener("message", this.handleMessage);
  }

  async download(path: string): Promise<void> {
    if (this.disposed) return;
    if (!isManagedFilePath(path)) throw new Error(this.t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_ROOT }));
    const session = await this.getSession(this.botId);
    if (this.disposed) return;
    const client = new TencentTsshFileClient(session, {
      channelId: `chat-file-${this.botId}-${Math.random().toString(36).slice(2)}`,
      userName: "agentuser",
    });
    try {
      await client.connect();
      if (this.disposed) return;
      const file = await client.fileInfo(path);
      if (!file) throw new Error(this.t("文件或目录不存在，请刷新后重试。"));
      if (file.type === "d") throw new Error(this.t("目录不能直接下载。"));
      if (file.size > MAX_FILE_BYTES) throw new Error(this.t("单个文件最大支持下载 {{size}}。", { size: "1 GB" }));
      if (!canReadTsshFile(file, PERMISSION_SUBJECT)) throw new Error(this.t("当前以 {{user}} 用户访问，选中文件没有可读权限。", { user: "agentuser" }));
      const name = path.split("/").at(-1)!;
      let workerReady = false;
      try { workerReady = await registerDownloadWorker(); } catch { /* Memory fallback below. */ }
      if (!workerReady) {
        if (file.size > MEMORY_FALLBACK_BYTES) throw new Error(this.t("当前浏览器不支持流式保存，最多只能下载 {{size}} 以内的文件。", { size: "8 MB" }));
        const blob = await client.downloadFile(path);
        if (this.disposed) return;
        saveBlob(blob, name);
        this.onStatus("done");
        return;
      }
      if (this.disposed) return;
      const iframe = document.createElement("iframe");
      iframe.hidden = true;
      iframe.style.display = "none";
      iframe.setAttribute("aria-hidden", "true");
      const timer = window.setTimeout(() => this.release(path, client), 6 * 60 * 60 * 1000);
      const entries = this.pending.get(path) ?? [];
      entries.push({ client, iframe, timer });
      this.pending.set(path, entries);
      const params = new URLSearchParams({ path, name });
      iframe.src = `/__tat_file_download/${encodeURIComponent(this.botId)}?${params}`;
      document.body.appendChild(iframe);
      this.onStatus("started");
    } catch (error) {
      client.close();
      throw error;
    } finally {
      if (!this.pending.get(path)?.some((entry) => entry.client === client)) client.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    navigator.serviceWorker?.removeEventListener("message", this.handleMessage);
    for (const [path, entries] of this.pending) {
      for (const entry of entries) this.release(path, entry.client);
    }
  }

  private release(path: string, client: TencentTsshFileClient): void {
    const entries = this.pending.get(path);
    const entry = entries?.find((item) => item.client === client);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    entry.iframe.remove();
    client.close();
    const remaining = entries!.filter((item) => item !== entry);
    if (remaining.length) this.pending.set(path, remaining);
    else this.pending.delete(path);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const port = event.ports[0];
    const request = event.data;
    if (!port || !isDownloadRequest(request) || request.botId !== this.botId) return;
    const entry = this.pending.get(request.path)?.[0];
    if (!entry) return;
    port.postMessage({ type: "tat-file-download-accepted", requestId: request.requestId });
    void this.stream(request, port, entry.client);
  };

  private async stream(request: DownloadRequest, port: MessagePort, client: TencentTsshFileClient): Promise<void> {
    let cancelled = false;
    let sequence = 0;
    let waiter: { sequence: number; resolve: () => void; reject: (error: Error) => void } | null = null;
    port.onmessage = (event) => {
      const message = event.data as Record<string, unknown>;
      if (message.requestId !== request.requestId) return;
      if (message.type === "tat-file-download-cancel") {
        cancelled = true;
        waiter?.reject(new Error("Download cancelled"));
      } else if (message.type === "tat-file-download-ack" && waiter && message.sequence === waiter.sequence) {
        waiter.resolve();
      }
    };
    try {
      await client.downloadFileToSink(request.path, {
        write: async (chunk) => {
          if (cancelled) throw new Error("Download cancelled");
          const copy = chunk.slice();
          const current = sequence++;
          port.postMessage({ type: "tat-file-download-chunk", requestId: request.requestId, sequence: current, chunk: copy.buffer }, [copy.buffer]);
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("Download stream timed out")), 30_000);
            waiter = {
              sequence: current,
              resolve: () => { window.clearTimeout(timer); resolve(); },
              reject: (error) => { window.clearTimeout(timer); reject(error); },
            };
          });
          waiter = null;
        },
      });
      port.postMessage({ type: "tat-file-download-done", requestId: request.requestId });
      this.onStatus("done");
    } catch (error) {
      if (!cancelled) {
        port.postMessage({ type: "tat-file-download-error", requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
        this.onStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      port.close();
      this.release(request.path, client);
    }
  }
}

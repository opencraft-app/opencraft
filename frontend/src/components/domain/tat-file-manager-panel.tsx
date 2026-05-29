import { useEffect, useMemo, useRef, useState } from "react";
import { Download, File, FileArchive, FileCode2, FileText, Folder, FolderPlus, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { joinTsshPath, parentTsshPath, TencentTsshFileClient, type TsshFileInfo } from "@/lib/tencent-tssh-file-client";
import { canReadTsshFile } from "@/lib/tssh-file-permissions";

interface TatFileManagerPanelProps {
  botId: string;
}

type FileManagerStatus = "idle" | "connecting" | "loading" | "working" | "ready" | "error";

const ROOT_PATH = "/";
const DEFAULT_TAT_FILE_USER = "agentuser";
const DEFAULT_TAT_FILE_UID = 1000;
const DEFAULT_TAT_FILE_GID = 1000;
const DEFAULT_TAT_FILE_PATH = "/home/agentuser/.hermes";
const SERVICE_WORKER_URL = "/tat-hermes-web-proxy-sw.js";
const SERVICE_WORKER_VERSION = "tat-file-download-v5";
const SERVICE_WORKER_SCOPE = "/";
const FILE_DOWNLOAD_PREFIX = "/__tat_file_download";
const MEMORY_DOWNLOAD_LIMIT_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TRIGGER_IFRAME_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TAT_FILE_PERMISSION_SUBJECT = {
  uid: DEFAULT_TAT_FILE_UID,
  gid: DEFAULT_TAT_FILE_GID,
  groups: [DEFAULT_TAT_FILE_GID],
  userName: DEFAULT_TAT_FILE_USER,
};

interface TatFileDownloadRequest {
  type: "tat-file-download-request";
  requestId: string;
  botId: string;
  path: string;
  name: string;
  size?: number | null;
}

interface TatFileDownloadAckWaiter {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatTime = (timestamp: number) => {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const pathSegments = (path: string) => {
  const normalized = path.trim() || ROOT_PATH;
  if (normalized === ROOT_PATH) {
    return [];
  }
  return normalized.split("/").filter(Boolean);
};

const pathFromSegments = (segments: string[], index: number) => {
  const next = segments.slice(0, index + 1).join("/");
  return next ? `/${next}` : ROOT_PATH;
};

const isDirectory = (file: TsshFileInfo) => file.type === "d";

const isTatFileDownloadRequest = (value: unknown): value is TatFileDownloadRequest => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "tat-file-download-request" &&
    typeof record.requestId === "string" &&
    typeof record.botId === "string" &&
    typeof record.path === "string" &&
    typeof record.name === "string"
  );
};

const clearTatFileDownloadAckWaiter = (waiter: TatFileDownloadAckWaiter | null) => {
  if (waiter) {
    window.clearTimeout(waiter.timer);
  }
};

const serviceWorkerScriptUrl = () => `${SERVICE_WORKER_URL}?v=${encodeURIComponent(SERVICE_WORKER_VERSION)}`;

const waitForServiceWorkerActivation = (registration: ServiceWorkerRegistration) => {
  const candidate = registration.waiting ?? registration.installing ?? registration.active;
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
      reject(new Error("TAT file download Service Worker activation timed out."));
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

const pingTatFileDownloadServiceWorker = (worker: ServiceWorker | null) =>
  new Promise<boolean>((resolve) => {
    if (!worker) {
      resolve(false);
      return;
    }
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 2000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      channel.port1.close();
      const message = event.data as Record<string, unknown>;
      resolve(message.type === "TAT_FILE_DOWNLOAD_READY" && message.version === SERVICE_WORKER_VERSION);
    };
    worker.postMessage({ type: "PING_TAT_FILE_DOWNLOAD" }, [channel.port2]);
  });

const registerTatServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) {
    return false;
  }
  const registration = await navigator.serviceWorker.register(serviceWorkerScriptUrl(), {
    scope: SERVICE_WORKER_SCOPE,
  });
  await registration.update().catch(() => undefined);
  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  await waitForServiceWorkerActivation(registration);
  await navigator.serviceWorker.ready;
  const worker = registration.active ?? (await navigator.serviceWorker.ready).active;
  return pingTatFileDownloadServiceWorker(worker);
};

const fileDownloadUrlFor = (botId: string, path: string, name: string, size: number) => {
  const params = new URLSearchParams({
    path,
    name,
    size: String(size),
  });
  return `${FILE_DOWNLOAD_PREFIX}/${encodeURIComponent(botId)}?${params.toString()}`;
};

const triggerBrowserDownload = (url: string) => {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.hidden = true;
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);
  window.setTimeout(() => {
    iframe.remove();
  }, DOWNLOAD_TRIGGER_IFRAME_TTL_MS);
};

const fileIconFor = (file: TsshFileInfo) => {
  if (isDirectory(file)) {
    return <Folder className="size-4 text-[#b7791f]" />;
  }
  const lower = file.name.toLowerCase();
  if (/\.(zip|tar|gz|tgz|rar|7z)$/.test(lower)) {
    return <FileArchive className="size-4 text-[#9a5b9d]" />;
  }
  if (/\.(json|yaml|yml|toml|rs|ts|tsx|js|jsx|go|py|sh)$/.test(lower)) {
    return <FileCode2 className="size-4 text-[#2f6f9f]" />;
  }
  if (/\.(txt|md|log|csv)$/.test(lower)) {
    return <FileText className="size-4 text-[#3b7f5a]" />;
  }
  return <File className="size-4 text-[var(--text-tertiary)]" />;
};

export const TatFileManagerPanel = ({ botId }: TatFileManagerPanelProps) => {
  const t = useT();
  const repositories = useRepositories();
  const clientRef = useRef<TencentTsshFileClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [path, setPath] = useState(DEFAULT_TAT_FILE_PATH);
  const [files, setFiles] = useState<TsshFileInfo[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [status, setStatus] = useState<FileManagerStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const selectedFile = useMemo(() => files.find((file) => file.name === selectedName) ?? null, [files, selectedName]);
  const segments = pathSegments(path);
  const selectedDownloadBlockReason = useMemo(() => {
    if (!selectedFile || isDirectory(selectedFile)) {
      return null;
    }
    if (canReadTsshFile(selectedFile, DEFAULT_TAT_FILE_PERMISSION_SUBJECT)) {
      return null;
    }
    return t("当前以 {{user}} 用户访问，选中文件没有可读权限。", { user: DEFAULT_TAT_FILE_USER });
  }, [selectedFile, t]);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setPath(DEFAULT_TAT_FILE_PATH);
    setFiles([]);
    setSelectedName(null);
    setNotice(null);
    setError(null);
    setProgress(null);
    setStatus("idle");
  }, [botId]);

  useEffect(() => {
    void loadPath(DEFAULT_TAT_FILE_PATH);
  }, [botId]);

  const getClient = async () => {
    if (clientRef.current) {
      return clientRef.current;
    }

    setStatus("connecting");
    const bootstrap = await repositories.bots.getTerminalSession(botId);
    const client = new TencentTsshFileClient(bootstrap, {
      channelId: `file-${botId}`,
      userName: DEFAULT_TAT_FILE_USER,
      onStateChange: (state) => {
        if (state === "ready") {
          setStatus("ready");
        }
      },
      onError: (message) => {
        setError(message);
        setStatus("error");
      },
    });
    clientRef.current = client;
    await client.connect();
    return client;
  };

  const assertCanDownloadFile = async (client: TencentTsshFileClient, remotePath: string, listedFile?: TsshFileInfo | null) => {
    const fileInfo = listedFile ?? (await client.fileInfo(remotePath));
    if (!fileInfo) {
      return;
    }
    if (isDirectory(fileInfo)) {
      throw new Error(t("目录不能直接下载。"));
    }
    if (!canReadTsshFile(fileInfo, DEFAULT_TAT_FILE_PERMISSION_SUBJECT)) {
      throw new Error(t("当前以 {{user}} 用户访问，选中文件没有可读权限。", { user: DEFAULT_TAT_FILE_USER }));
    }
  };

  const streamFileDownloadRequest = async (request: TatFileDownloadRequest, port: MessagePort) => {
    let cancelled = false;
    let sequence = 0;
    let waitingAck: TatFileDownloadAckWaiter | null = null;

    port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "tat-file-download-cancel" && message.requestId === request.requestId) {
        cancelled = true;
        if (waitingAck) {
          window.clearTimeout(waitingAck.timer);
          waitingAck.reject(new Error("download cancelled"));
          waitingAck = null;
        }
        return;
      }
      if (
        message.type === "tat-file-download-ack" &&
        message.requestId === request.requestId &&
        waitingAck &&
        message.sequence === waitingAck.sequence
      ) {
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
            reject(new Error("download stream ack timed out"));
          }, 30_000),
        };
      });

    const postError = (error: unknown) => {
      port.postMessage({
        type: "tat-file-download-error",
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    try {
      setStatus("working");
      setError(null);
      setNotice(null);
      setProgress(t("准备下载..."));
      const client = await getClient();
      await assertCanDownloadFile(client, request.path);
      await client.downloadFileToSink(
        request.path,
        {
          write: async (chunk) => {
            if (cancelled) {
              throw new Error("download cancelled");
            }
            const ownedChunk = chunk.slice();
            const buffer = ownedChunk.buffer as ArrayBuffer;
            const chunkSequence = sequence;
            sequence += 1;
            port.postMessage(
              {
                type: "tat-file-download-chunk",
                requestId: request.requestId,
                sequence: chunkSequence,
                chunk: buffer,
              },
              [buffer],
            );
            await waitForAck(chunkSequence);
          },
        },
        (state) => {
          setProgress(t("已接收 {{size}}", { size: formatBytes(state.receivedBytes) }));
        },
      );
      port.postMessage({
        type: "tat-file-download-done",
        requestId: request.requestId,
      });
      setNotice(t("下载完成。"));
      setStatus("ready");
    } catch (downloadError) {
      if (!cancelled) {
        postError(downloadError);
        setError(downloadError instanceof Error ? downloadError.message : t("下载失败"));
        setStatus("error");
      } else {
        setStatus("ready");
      }
    } finally {
      clearTatFileDownloadAckWaiter(waitingAck);
      waitingAck = null;
      setProgress(null);
      port.close();
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const port = event.ports[0];
      if (!port || !isTatFileDownloadRequest(event.data) || event.data.botId !== botId) {
        return;
      }
      port.postMessage({
        type: "tat-file-download-accepted",
        requestId: event.data.requestId,
      });
      void streamFileDownloadRequest(event.data, port);
    };

    navigator.serviceWorker?.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
    };
  }, [botId, streamFileDownloadRequest]);

  const loadPath = async (nextPath = path) => {
    if (!botId) {
      setError(t("缺少 Bot ID。"));
      setStatus("error");
      return;
    }

    setStatus("loading");
    setError(null);
    setNotice(null);
    setProgress(null);
    try {
      const client = await getClient();
      const entries = await client.listPath(nextPath);
      entries.sort((a, b) => Number(isDirectory(b)) - Number(isDirectory(a)) || a.name.localeCompare(b.name));
      setFiles(entries);
      setPath(nextPath);
      setSelectedName(null);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("文件列表加载失败"));
      setStatus("error");
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) {
      return;
    }
    setStatus("working");
    setError(null);
    try {
      const client = await getClient();
      await client.createFile(joinTsshPath(path, name), { isDir: true, mode: 0o755 });
      setFolderName("");
      setNotice(t("目录已创建。"));
      await loadPath(path);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("创建目录失败"));
      setStatus("error");
    }
  };

  const deleteSelected = async () => {
    if (!selectedFile) {
      return;
    }
    setStatus("working");
    setError(null);
    try {
      const client = await getClient();
      await client.deleteFile(joinTsshPath(path, selectedFile.name), isDirectory(selectedFile));
      setNotice(t("已删除选中文件。"));
      await loadPath(path);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("删除失败"));
      setStatus("error");
    }
  };

  const downloadSelectedWithMemoryFallback = async () => {
    if (!selectedFile || isDirectory(selectedFile)) {
      return;
    }
    if (selectedDownloadBlockReason) {
      setError(selectedDownloadBlockReason);
      return;
    }
    setStatus("working");
    setError(null);
    setProgress(t("准备下载..."));
    try {
      if (selectedFile.size > MEMORY_DOWNLOAD_LIMIT_BYTES) {
        throw new Error(t("当前浏览器不支持流式保存，最多只能下载 {{size}} 以内的文件。", { size: formatBytes(MEMORY_DOWNLOAD_LIMIT_BYTES) }));
      }
      const client = await getClient();
      const remotePath = joinTsshPath(path, selectedFile.name);
      await assertCanDownloadFile(client, remotePath, selectedFile);
      const onProgress = (state: { receivedBytes: number }) => {
        setProgress(t("已接收 {{size}}", { size: formatBytes(state.receivedBytes) }));
      };
      const blob = await client.downloadFile(remotePath, onProgress);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selectedFile.name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(t("当前浏览器不支持流式保存，已使用内存下载。"));
      setStatus("ready");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : t("下载失败"));
      setStatus("error");
    } finally {
      setProgress(null);
    }
  };

  const downloadSelected = async () => {
    if (!selectedFile || isDirectory(selectedFile)) {
      return;
    }
    if (selectedDownloadBlockReason) {
      setError(selectedDownloadBlockReason);
      return;
    }

    const remotePath = joinTsshPath(path, selectedFile.name);
    setError(null);
    setProgress(null);
    try {
      const serviceWorkerReady = await registerTatServiceWorker();
      if (!serviceWorkerReady) {
        await downloadSelectedWithMemoryFallback();
        return;
      }
      const downloadUrl = fileDownloadUrlFor(botId, remotePath, selectedFile.name, selectedFile.size);
      triggerBrowserDownload(downloadUrl);
      setNotice(t("下载已开始。"));
    } catch {
      await downloadSelectedWithMemoryFallback();
    }
  };

  const uploadFile = async (file: File) => {
    setStatus("working");
    setError(null);
    setProgress(t("准备上传..."));
    try {
      const client = await getClient();
      await client.uploadFile(joinTsshPath(path, file.name), file, (state) => {
        setProgress(t("已上传 {{sent}} / {{total}}", { sent: formatBytes(state.sentBytes), total: formatBytes(state.totalBytes) }));
      });
      setNotice(t("上传完成。"));
      await loadPath(path);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("上传失败"));
      setStatus("error");
    } finally {
      setProgress(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const openEntry = (file: TsshFileInfo) => {
    if (isDirectory(file)) {
      void loadPath(joinTsshPath(path, file.name));
      return;
    }
    setSelectedName(file.name);
  };

  const busy = status === "connecting" || status === "loading" || status === "working";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className="font-semibold text-[var(--text-primary)] hover:underline" onClick={() => void loadPath(ROOT_PATH)}>
              {t("根目录")}
            </button>
            {segments.map((segment, index) => (
              <span key={`${segment}-${index}`} className="inline-flex items-center gap-2">
                <span className="text-[var(--text-tertiary)]">/</span>
                <button type="button" className="max-w-36 truncate hover:underline" onClick={() => void loadPath(pathFromSegments(segments, index))}>
                  {segment}
                </button>
              </span>
            ))}
          </div>
          <p className="text-sm" style={{ color: "var(--lw-fg-secondary)" }}>
            {t("通过 TAT tssh 文件协议以 {{user}} 用户浏览实例文件，适合下载日志、上传配置和排障材料。", { user: DEFAULT_TAT_FILE_USER })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void loadPath(parentTsshPath(path))} disabled={busy || path === ROOT_PATH}>
            <Folder className="size-4" />
            {t("上级")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadPath(path)} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("刷新")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <Input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder={t("新目录名")} disabled={busy} />
          <Button type="button" variant="outline" onClick={() => void createFolder()} disabled={busy || !folderName.trim()}>
            <FolderPlus className="size-4" />
            {t("新建目录")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void uploadFile(file);
              }
            }}
          />
          <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload className="size-4" />
            {t("上传文件")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void downloadSelected()}
            disabled={busy || !selectedFile || isDirectory(selectedFile) || Boolean(selectedDownloadBlockReason)}
            title={selectedDownloadBlockReason ?? undefined}
          >
            <Download className="size-4" />
            {t("下载")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void deleteSelected()} disabled={busy || !selectedFile}>
            <Trash2 className="size-4" />
            {t("删除")}
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-md border border-[color-mix(in_oklab,var(--danger)_28%,white)] bg-[color-mix(in_oklab,var(--danger)_8%,white)] px-3 py-2 text-sm text-[var(--danger)]">{error}</div> : null}
      {selectedDownloadBlockReason ? (
        <div className="rounded-md border border-[color-mix(in_oklab,var(--warning)_28%,white)] bg-[color-mix(in_oklab,var(--warning)_8%,white)] px-3 py-2 text-sm text-[var(--warning)]">
          {selectedDownloadBlockReason}
        </div>
      ) : null}
      {notice ? <div className="rounded-md border border-[color-mix(in_oklab,var(--success)_24%,white)] bg-[color-mix(in_oklab,var(--success)_8%,white)] px-3 py-2 text-sm text-[var(--success)]">{notice}</div> : null}
      {progress ? <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]">{progress}</div> : null}

      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
        <div className="grid grid-cols-[minmax(0,1fr)_104px_132px] bg-[var(--surface-muted)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          <span>{t("名称")}</span>
          <span>{t("大小")}</span>
          <span>{t("修改时间")}</span>
        </div>
        <div className="max-h-[420px] overflow-auto bg-white">
          {files.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-tertiary)]">
              {status === "idle" ? t("连接后会显示当前目录文件。") : t("当前目录为空。")}
            </div>
          ) : (
            files.map((file) => {
              const selected = selectedName === file.name;
              return (
                <button
                  type="button"
                  key={`${file.type}:${file.name}`}
                  className="grid w-full grid-cols-[minmax(0,1fr)_104px_132px] items-center border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm transition hover:bg-[var(--surface-muted)]"
                  style={selected ? { background: "color-mix(in oklab, var(--brand-500) 9%, white)" } : undefined}
                  onClick={() => setSelectedName(file.name)}
                  onDoubleClick={() => openEntry(file)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {fileIconFor(file)}
                    <span className="truncate font-medium text-[var(--text-primary)]">{file.name}</span>
                    {isDirectory(file) ? <Badge>{t("目录")}</Badge> : null}
                  </span>
                  <span className="text-[var(--text-secondary)]">{isDirectory(file) ? "-" : formatBytes(file.size)}</span>
                  <span className="text-[var(--text-secondary)]">{formatTime(file.modifyTime)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Download, Eye, EyeOff, File, FileArchive, FileCode2, FileText, Folder, FolderPlus, Loader2, PencilLine, RefreshCw, Trash2, Undo2, Upload, XCircle } from "lucide-react";
import { AgentSectionHeader } from "./agent-section-header";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useRepositories } from "../../contexts/repository-context";
import { useT } from "../../i18n/t";
import { DEFAULT_LOCALE } from "../../lib/region";
import { joinTsshPath, parentTsshPath, TencentTsshFileClient, type TsshFileInfo } from "../../lib/tencent-tssh-file-client";
import { canReadTsshFile } from "../../lib/tssh-file-permissions";

interface TatFileManagerPanelProps {
  botId: string;
}

interface ActionTooltipProps {
  children: ReactNode;
  label?: string;
  variant?: "light";
}

const ActionTooltip = ({ children, label }: ActionTooltipProps) => {
  return (
    <span
      className="group relative inline-flex"
      tabIndex={label ? 0 : undefined}
    >
      {children}
      {label ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          {label}
          <span
            className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white"
          />
        </span>
      ) : null}
    </span>
  );
};

type FileManagerStatus = "idle" | "connecting" | "loading" | "working" | "ready" | "error";
type StorageCapacityStatus = "loading" | "ready" | "error";

interface StorageCapacity {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

const ROOT_PATH = "/";
const DEFAULT_TAT_FILE_USER = "agentuser";
const DEFAULT_TAT_FILE_UID = 1000;
const DEFAULT_TAT_FILE_GID = 1000;
const DEFAULT_TAT_FILE_PATH = "/home/agentuser/.hermes";
const MANAGED_TAT_FILE_ROOT = "/home/agentuser";
const STORAGE_CAPACITY_OUTPUT_START = "__LIGHTVELA_STORAGE_CAPACITY_START__";
const STORAGE_CAPACITY_OUTPUT_END = "__LIGHTVELA_STORAGE_CAPACITY_END__";
const STORAGE_CAPACITY_COMMAND_FAILED_MESSAGE = "storage capacity command failed";
const STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE = "invalid storage capacity response";
const STORAGE_CAPACITY_REQUEST_FAILED_MESSAGE = "storage capacity request failed";
const STORAGE_CAPACITY_COMMAND = `python3 -c 'import json, os; stats = os.statvfs("/home/agentuser"); block_size = stats.f_frsize; total = stats.f_blocks * block_size; available = stats.f_bavail * block_size; print("${STORAGE_CAPACITY_OUTPUT_START}" + json.dumps({"total_bytes": total, "used_bytes": max(0, total - available), "available_bytes": available}, separators=(",", ":")) + "${STORAGE_CAPACITY_OUTPUT_END}")'`;
const STORAGE_CAPACITY_COMMAND_TIMEOUT_SECONDS = 30;
const SERVICE_WORKER_URL = "/tat-hermes-web-proxy-sw.js";
const SERVICE_WORKER_VERSION = "tat-file-download-v6";
const SERVICE_WORKER_SCOPE = "/";
const FILE_DOWNLOAD_PREFIX = "/__tat_file_download";
const MEMORY_DOWNLOAD_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_DOWNLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILE_SIZE_LABEL = "1 GB";
const MAX_DOWNLOAD_FILE_SIZE_LABEL = "1 GB";
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

interface DownloadTriggerIframe {
  iframe: HTMLIFrameElement;
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

const parseStorageCapacity = (output: string): StorageCapacity => {
  const startIndex = output.lastIndexOf(STORAGE_CAPACITY_OUTPUT_START);
  if (startIndex < 0) {
    throw new Error(STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE);
  }
  const payloadStart = startIndex + STORAGE_CAPACITY_OUTPUT_START.length;
  const endIndex = output.indexOf(STORAGE_CAPACITY_OUTPUT_END, payloadStart);
  if (endIndex < 0) {
    throw new Error(STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(payloadStart, endIndex).trim());
  } catch {
    throw new Error(STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE);
  }
  const record = parsed as Record<string, unknown>;
  const totalBytes = record.total_bytes;
  const usedBytes = record.used_bytes;
  const availableBytes = record.available_bytes;
  const values = [totalBytes, usedBytes, availableBytes];
  if (
    values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
    typeof totalBytes !== "number" ||
    typeof usedBytes !== "number" ||
    typeof availableBytes !== "number" ||
    totalBytes <= 0 ||
    usedBytes > totalBytes ||
    availableBytes > totalBytes
  ) {
    throw new Error(STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE);
  }
  return { totalBytes, usedBytes, availableBytes };
};

const storageCapacityFailureReason = (error: unknown) => {
  if (
    error instanceof Error &&
    (error.message === STORAGE_CAPACITY_COMMAND_FAILED_MESSAGE ||
      error.message === STORAGE_CAPACITY_INVALID_RESPONSE_MESSAGE)
  ) {
    return error.message;
  }
  return STORAGE_CAPACITY_REQUEST_FAILED_MESSAGE;
};

const formatTime = (timestamp: number) => {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const normalizeEditablePath = (value: string) => {
  const trimmed = value.trim();
  const absolute = !trimmed ? ROOT_PATH : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length ? `/${segments.join("/")}` : ROOT_PATH;
};

const isDirectory = (file: TsshFileInfo) => file.type === "d";

const isHiddenFile = (file: TsshFileInfo) => file.name.startsWith(".");

const isManagedPath = (value: string) => {
  const normalized = normalizeEditablePath(value);
  return normalized === MANAGED_TAT_FILE_ROOT || normalized.startsWith(`${MANAGED_TAT_FILE_ROOT}/`);
};

const managedChildPath = (basePath: string, name: string) => {
  const nextPath = normalizeEditablePath(joinTsshPath(basePath, name));
  return isManagedPath(nextPath) ? nextPath : null;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

interface FileManagerErrorTranslations {
  directoryNotEmpty: string;
  fileChannelNotConnected: string;
  fileChannelClosed: string;
  fileExists: string;
  fileNotFound: string;
  invalidArgument: string;
  isDirectory: string;
  notDirectory: string;
  operationNotPermitted: string;
  permissionDenied: string;
  requestTimedOut: string;
  websocketError: string;
}

const fileManagerErrorMessage = (error: unknown, fallback: string, translations: FileManagerErrorTranslations) => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.trim().toLowerCase();
  if (normalized === "file channel is not connected") {
    return translations.fileChannelNotConnected;
  }
  if (normalized === "file channel closed") {
    return translations.fileChannelClosed;
  }
  if (normalized === "file exists" || normalized.includes("already exists")) {
    return translations.fileExists;
  }
  if (normalized === "file not found" || normalized.includes("no such file or directory") || normalized.includes("not found")) {
    return translations.fileNotFound;
  }
  if (normalized === "permission denied" || normalized.includes("permission denied") || normalized.includes("access denied")) {
    return translations.permissionDenied;
  }
  if (normalized === "operation not permitted" || normalized.includes("operation not permitted")) {
    return translations.operationNotPermitted;
  }
  if (normalized === "not a directory" || normalized.includes("not a directory")) {
    return translations.notDirectory;
  }
  if (normalized === "is a directory" || normalized.includes("is a directory")) {
    return translations.isDirectory;
  }
  if (normalized === "directory not empty" || normalized.includes("directory not empty")) {
    return translations.directoryNotEmpty;
  }
  if (normalized === "invalid argument" || normalized.includes("invalid argument")) {
    return translations.invalidArgument;
  }
  if (normalized === "tat file request timed out" || normalized.includes("timed out")) {
    return translations.requestTimedOut;
  }
  if (normalized === "websocket error") {
    return translations.websocketError;
  }
  return message || fallback;
};

const isRecoverableFileChannelError = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.trim().toLowerCase();
  return normalized === "file channel is not connected" || normalized === "file channel closed" || normalized === "websocket error";
};

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

const fileDownloadUrlFor = (botId: string, path: string, name: string) => {
  const params = new URLSearchParams({
    path,
    name,
  });
  return `${FILE_DOWNLOAD_PREFIX}/${encodeURIComponent(botId)}?${params.toString()}`;
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
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const pathControlsRef = useRef<HTMLDivElement | null>(null);
  const createFolderInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const downloadTriggerIframesRef = useRef<Set<DownloadTriggerIframe>>(new Set());
  const capacityRequestSequenceRef = useRef(0);
  const activeBotIdRef = useRef(botId);
  const [path, setPath] = useState(DEFAULT_TAT_FILE_PATH);
  const [pathDraft, setPathDraft] = useState(DEFAULT_TAT_FILE_PATH);
  const [pathEditing, setPathEditing] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderDraft, setNewFolderDraft] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [files, setFiles] = useState<TsshFileInfo[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [status, setStatus] = useState<FileManagerStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [storageCapacityStatus, setStorageCapacityStatus] = useState<StorageCapacityStatus>("loading");
  const [storageCapacity, setStorageCapacity] = useState<StorageCapacity | null>(null);

  const displayedFiles = useMemo(() => (showHiddenFiles ? files : files.filter((file) => !isHiddenFile(file))), [files, showHiddenFiles]);
  const selectedFile = useMemo(() => displayedFiles.find((file) => file.name === selectedName) ?? null, [displayedFiles, selectedName]);
  const noFileSelectedTitle = t("未选择文件");
  const selectedPermissionBlockReason = useMemo(() => {
    if (!selectedFile || isDirectory(selectedFile)) {
      return null;
    }
    if (canReadTsshFile(selectedFile, DEFAULT_TAT_FILE_PERMISSION_SUBJECT)) {
      return null;
    }
    return t("当前以 {{user}} 用户访问，选中文件没有可读权限。", { user: DEFAULT_TAT_FILE_USER });
  }, [selectedFile, t]);
  const selectedDownloadSizeBlockReason =
    selectedFile && !isDirectory(selectedFile) && selectedFile.size > MAX_DOWNLOAD_FILE_BYTES
      ? t("单个文件最大支持下载 {{size}}。", { size: MAX_DOWNLOAD_FILE_SIZE_LABEL })
      : null;
  const selectedDownloadBlockReason = selectedFile && isDirectory(selectedFile) ? t("不支持下载文件夹") : selectedDownloadSizeBlockReason ?? selectedPermissionBlockReason;
  const downloadTooltip = selectedDownloadBlockReason ?? (!selectedFile ? noFileSelectedTitle : undefined);
  const renameTooltip = !selectedFile ? noFileSelectedTitle : undefined;
  const deleteTooltip = !selectedFile ? noFileSelectedTitle : undefined;
  const parentPathBlocked = path === MANAGED_TAT_FILE_ROOT;
  const parentPathTooltip = parentPathBlocked ? t("不支持返回上一级目录") : t("上级");

  const translateFileManagerError = useCallback(
    (operationError: unknown, fallback: string) =>
      fileManagerErrorMessage(operationError, fallback, {
        directoryNotEmpty: t("目录非空，无法删除。"),
        fileChannelNotConnected: t("文件通道未连接，请刷新后重试。"),
        fileChannelClosed: t("文件通道已关闭，请刷新后重试。"),
        fileExists: t("文件已存在，请换个名称。"),
        fileNotFound: t("文件或目录不存在，请刷新后重试。"),
        invalidArgument: t("文件操作参数无效，请检查后重试。"),
        isDirectory: t("该路径是目录，不能按文件操作。"),
        notDirectory: t("路径中包含非目录项，请检查路径。"),
        operationNotPermitted: t("没有权限执行该文件操作。"),
        permissionDenied: t("权限不足，无法完成该文件操作。"),
        requestTimedOut: t("文件操作超时，请稍后重试。"),
        websocketError: t("连接异常，请刷新后重试。"),
      }),
    [t],
  );

  const removeDownloadTriggerIframe = useCallback((trigger: DownloadTriggerIframe) => {
    window.clearTimeout(trigger.timer);
    trigger.iframe.remove();
    downloadTriggerIframesRef.current.delete(trigger);
  }, []);

  const clearDownloadTriggerIframes = useCallback(() => {
    for (const trigger of downloadTriggerIframesRef.current) {
      window.clearTimeout(trigger.timer);
      trigger.iframe.remove();
    }
    downloadTriggerIframesRef.current.clear();
  }, []);

  const triggerBrowserDownload = useCallback((url: string) => {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.hidden = true;
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    const trigger: DownloadTriggerIframe = {
      iframe,
      timer: window.setTimeout(() => {
        removeDownloadTriggerIframe(trigger);
      }, DOWNLOAD_TRIGGER_IFRAME_TTL_MS),
    };
    downloadTriggerIframesRef.current.add(trigger);
    document.body.appendChild(iframe);
  }, [removeDownloadTriggerIframe]);

  useEffect(() => {
    return () => {
      clearDownloadTriggerIframes();
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [clearDownloadTriggerIframes]);

  useEffect(() => {
    activeBotIdRef.current = botId;
    capacityRequestSequenceRef.current += 1;
    clearDownloadTriggerIframes();
    clientRef.current?.close();
    clientRef.current = null;
    setPath(DEFAULT_TAT_FILE_PATH);
    setPathDraft(DEFAULT_TAT_FILE_PATH);
    setPathEditing(false);
    setCreatingFolder(false);
    setNewFolderDraft("");
    setRenamingName(null);
    setRenameDraft("");
    setFiles([]);
    setSelectedName(null);
    setNotice(null);
    setError(null);
    setProgress(null);
    setStatus("idle");
    setStorageCapacity(null);
    setStorageCapacityStatus("loading");
  }, [botId, clearDownloadTriggerIframes]);

  useEffect(() => {
    void (async () => {
      await loadPath(DEFAULT_TAT_FILE_PATH);
      await loadStorageCapacity();
    })();
  }, [botId]);

  useEffect(() => {
    if (!creatingFolder) {
      return;
    }
    window.requestAnimationFrame(() => createFolderInputRef.current?.focus());
  }, [creatingFolder]);

  useEffect(() => {
    if (!renamingName) {
      return;
    }
    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingName]);

  useEffect(() => {
    if (!pathEditing) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && pathControlsRef.current?.contains(target)) {
        return;
      }
      setPathDraft(path);
      setPathEditing(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [path, pathEditing]);

  const getClient = useCallback(async () => {
    if (clientRef.current?.isReady()) {
      return clientRef.current;
    }
    clientRef.current?.close();
    clientRef.current = null;

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
        setError(translateFileManagerError(message, t("文件操作失败")));
        setStatus("error");
      },
    });
    clientRef.current = client;
    await client.connect();
    return client;
  }, [botId, repositories.bots, t, translateFileManagerError]);

  const resetClient = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

  const runWithReconnectedClient = useCallback(async <T,>(
    operation: (client: TencentTsshFileClient) => Promise<T>,
    options: { shouldRetry?: () => boolean } = {},
  ) => {
    try {
      return await operation(await getClient());
    } catch (error) {
      if (!isRecoverableFileChannelError(error) || options.shouldRetry?.() === false) {
        throw error;
      }
      resetClient();
      return operation(await getClient());
    }
  }, [getClient, resetClient]);

  const loadStorageCapacity = async () => {
    const requestBotId = botId;
    if (!requestBotId || activeBotIdRef.current !== requestBotId) {
      return;
    }
    const requestSequence = capacityRequestSequenceRef.current + 1;
    capacityRequestSequenceRef.current = requestSequence;
    setStorageCapacityStatus("loading");
    try {
      const result = await runWithReconnectedClient((client) =>
        client.execCommand(STORAGE_CAPACITY_COMMAND, STORAGE_CAPACITY_COMMAND_TIMEOUT_SECONDS),
      );
      if (result.exitCode !== null && result.exitCode !== 0) {
        throw new Error(STORAGE_CAPACITY_COMMAND_FAILED_MESSAGE);
      }
      const capacity = parseStorageCapacity(result.output);
      if (capacityRequestSequenceRef.current !== requestSequence || activeBotIdRef.current !== requestBotId) {
        return;
      }
      setStorageCapacity(capacity);
      setStorageCapacityStatus("ready");
    } catch (capacityError) {
      if (capacityRequestSequenceRef.current !== requestSequence || activeBotIdRef.current !== requestBotId) {
        return;
      }
      console.warn(
        "[storage-capacity] lookup failed",
        storageCapacityFailureReason(capacityError),
      );
      setStorageCapacity(null);
      setStorageCapacityStatus("error");
    }
  };

  const assertCanDownloadFile = useCallback(async (client: TencentTsshFileClient, remotePath: string, listedFile?: TsshFileInfo | null) => {
    const fileInfo = listedFile ?? (await client.fileInfo(remotePath));
    if (!fileInfo) {
      return;
    }
    if (isDirectory(fileInfo)) {
      throw new Error(t("目录不能直接下载。"));
    }
    if (fileInfo.size > MAX_DOWNLOAD_FILE_BYTES) {
      throw new Error(t("单个文件最大支持下载 {{size}}。", { size: MAX_DOWNLOAD_FILE_SIZE_LABEL }));
    }
    if (!canReadTsshFile(fileInfo, DEFAULT_TAT_FILE_PERMISSION_SUBJECT)) {
      throw new Error(t("当前以 {{user}} 用户访问，选中文件没有可读权限。", { user: DEFAULT_TAT_FILE_USER }));
    }
  }, [t]);

  const streamFileDownloadRequest = useCallback(async (request: TatFileDownloadRequest, port: MessagePort) => {
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
      if (!isManagedPath(request.path)) {
        throw new Error(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      }
      await runWithReconnectedClient(
        async (client) => {
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
        },
        { shouldRetry: () => sequence === 0 },
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
        setError(translateFileManagerError(downloadError, t("下载失败")));
        setStatus("error");
      } else {
        setStatus("ready");
      }
    } finally {
      clearTatFileDownloadAckWaiter(waitingAck);
      clearDownloadTriggerIframes();
      waitingAck = null;
      setProgress(null);
      port.close();
    }
  }, [assertCanDownloadFile, clearDownloadTriggerIframes, runWithReconnectedClient, t, translateFileManagerError]);

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
    const managedPath = normalizeEditablePath(nextPath);
    if (!isManagedPath(managedPath)) {
      setPathDraft(path);
      setPathEditing(false);
      setError(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      setStatus("error");
      return;
    }

    setStatus("loading");
    setError(null);
    setNotice(null);
    setProgress(null);
    try {
      const entries = await runWithReconnectedClient((client) => client.listPath(managedPath));
      entries.sort((a, b) => Number(isDirectory(b)) - Number(isDirectory(a)) || a.name.localeCompare(b.name));
      setFiles(entries);
      setPath(managedPath);
      setPathDraft(managedPath);
      setSelectedName(null);
      setCreatingFolder(false);
      setNewFolderDraft("");
      setRenamingName(null);
      setRenameDraft("");
      setStatus("ready");
    } catch (loadError) {
      setError(translateFileManagerError(loadError, t("文件列表加载失败")));
      setStatus("error");
    }
  };

  const refreshPathAndCapacity = async () => {
    await loadPath(path);
    await loadStorageCapacity();
  };

  const openPathDraft = async () => {
    const nextPath = normalizeEditablePath(pathDraft);
    setPathDraft(nextPath);
    await loadPath(nextPath);
    setPathEditing(false);
  };

  const beginCreateFolder = () => {
    setSelectedName(null);
    setRenamingName(null);
    setRenameDraft("");
    setNewFolderDraft("");
    setCreatingFolder(true);
  };

  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setNewFolderDraft("");
  };

  const beginRenameSelected = () => {
    if (!selectedFile) {
      return;
    }
    setCreatingFolder(false);
    setNewFolderDraft("");
    setRenamingName(selectedFile.name);
    setRenameDraft(selectedFile.name);
  };

  const cancelRename = () => {
    setRenamingName(null);
    setRenameDraft("");
  };

  const createFolder = async () => {
    const name = newFolderDraft.trim();
    if (!name) {
      return;
    }
    const folderPath = managedChildPath(path, name);
    if (!folderPath || name.includes("/") || name === "." || name === "..") {
      setError(t("文件夹名无效，只能在 {{path}} 目录下新建。", { path: MANAGED_TAT_FILE_ROOT }));
      setStatus("error");
      return;
    }
    setStatus("working");
    setError(null);
    try {
      await runWithReconnectedClient((client) => client.createFile(folderPath, { isDir: true, mode: 0o755 }));
      setCreatingFolder(false);
      setNewFolderDraft("");
      setNotice(t("目录已创建。"));
      await loadPath(path);
    } catch (createError) {
      setError(translateFileManagerError(createError, t("创建目录失败")));
      setStatus("error");
    }
  };

  const renameSelected = async () => {
    const sourceName = renamingName;
    const name = renameDraft.trim();
    if (!sourceName || !name) {
      return;
    }
    if (name === sourceName) {
      cancelRename();
      return;
    }
    const sourcePath = managedChildPath(path, sourceName);
    const targetPath = managedChildPath(path, name);
    if (!sourcePath || !targetPath || name.includes("/") || name === "." || name === "..") {
      setError(t("文件名无效，只能在 {{path}} 目录下重命名。", { path: MANAGED_TAT_FILE_ROOT }));
      setStatus("error");
      return;
    }

    setStatus("working");
    setError(null);
    try {
      const command = `if [ -e ${shellQuote(targetPath)} ]; then echo 'file exists' >&2; exit 1; fi\nmv -- ${shellQuote(sourcePath)} ${shellQuote(targetPath)}`;
      const result = await runWithReconnectedClient((client) => client.execCommand(command, 60));
      if (result.exitCode !== 0) {
        throw new Error(result.output.trim() || `rename command failed with exit code ${result.exitCode ?? "unknown"}`);
      }
      setRenamingName(null);
      setRenameDraft("");
      await loadPath(path);
      setStatus("ready");
      setNotice(t("已重命名。"));
    } catch (renameError) {
      setError(translateFileManagerError(renameError, t("重命名失败")));
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
      const remotePath = managedChildPath(path, selectedFile.name);
      if (!remotePath) {
        throw new Error(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      }
      await runWithReconnectedClient((client) => client.deleteFile(remotePath, isDirectory(selectedFile)));
      setNotice(t("已删除选中文件。"));
      await loadPath(path);
      await loadStorageCapacity();
    } catch (deleteError) {
      setError(translateFileManagerError(deleteError, t("删除失败")));
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
      const remotePath = managedChildPath(path, selectedFile.name);
      if (!remotePath) {
        throw new Error(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      }
      const onProgress = (state: { receivedBytes: number }) => {
        setProgress(t("已接收 {{size}}", { size: formatBytes(state.receivedBytes) }));
      };
      const blob = await runWithReconnectedClient(async (client) => {
        await assertCanDownloadFile(client, remotePath, selectedFile);
        return client.downloadFile(remotePath, onProgress);
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selectedFile.name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(t("当前浏览器不支持流式保存，已使用内存下载。"));
      setStatus("ready");
    } catch (downloadError) {
      setError(translateFileManagerError(downloadError, t("下载失败")));
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

    const remotePath = managedChildPath(path, selectedFile.name);
    if (!remotePath) {
      setError(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      return;
    }
    setError(null);
    setProgress(null);
    try {
      const serviceWorkerReady = await registerTatServiceWorker();
      if (!serviceWorkerReady) {
        await downloadSelectedWithMemoryFallback();
        return;
      }
      const downloadUrl = fileDownloadUrlFor(botId, remotePath, selectedFile.name);
      triggerBrowserDownload(downloadUrl);
      setNotice(t("下载已开始。"));
    } catch {
      await downloadSelectedWithMemoryFallback();
    }
  };

  const uploadFile = async (file: File) => {
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setError(t("单个文件最大支持上传 {{size}}。", { size: MAX_UPLOAD_FILE_SIZE_LABEL }));
      setNotice(null);
      setProgress(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    setStatus("working");
    setError(null);
    setProgress(t("准备上传..."));
    try {
      const remotePath = managedChildPath(path, file.name);
      if (!remotePath) {
        throw new Error(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
      }
      await runWithReconnectedClient((client) => client.uploadFile(remotePath, file, (state) => {
        setProgress(t("已上传 {{sent}} / {{total}}", { sent: formatBytes(state.sentBytes), total: formatBytes(state.totalBytes) }));
      }));
      setNotice(t("上传完成。"));
      await loadPath(path);
      await loadStorageCapacity();
    } catch (uploadError) {
      setError(translateFileManagerError(uploadError, t("上传失败")));
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
      const nextPath = managedChildPath(path, file.name);
      if (!nextPath) {
        setError(t("只能访问 {{path}} 目录下的文件和文件夹。", { path: MANAGED_TAT_FILE_ROOT }));
        return;
      }
      void loadPath(nextPath);
      return;
    }
  };

  const toggleHiddenFiles = () => {
    setShowHiddenFiles((current) => {
      const next = !current;
      if (!next) {
        setSelectedName((selected) => {
          if (!selected) {
            return null;
          }
          const visibleNames = new Set(files.filter((file) => !isHiddenFile(file)).map((file) => file.name));
          return visibleNames.has(selected) ? selected : null;
        });
      }
      return next;
    });
  };

  const busy = status === "connecting" || status === "loading" || status === "working";
  const storageUsagePercent = storageCapacity
    ? Math.min(100, Math.max(0, Math.round((storageCapacity.usedBytes / storageCapacity.totalBytes) * 100)))
    : 0;

  return (
    <div className="space-y-5">
      <AgentSectionHeader
        title={t("云存储")}
        description={t("查看、管理云存储中的文件")}
      />

      <section
        aria-labelledby="instance-storage-title"
        className="rounded-md border border-[var(--border-subtle)] bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 id="instance-storage-title" className="text-sm font-semibold text-[var(--text-primary)]">
              {t("存储概览")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-[var(--text-tertiary)]">
              {t("包含 Agent 运行环境、系统预留和云存储文件。")}
            </p>
          </div>
          {storageCapacityStatus === "ready" && storageCapacity ? (
            <div className="shrink-0 text-left sm:text-right">
              <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                {t("已用 {{used}} / {{total}}", {
                  used: formatBytes(storageCapacity.usedBytes),
                  total: formatBytes(storageCapacity.totalBytes),
                })}
              </p>
              <p className="mt-1 text-xs tabular-nums text-[var(--text-secondary)]">
                {t("可用 {{available}}", { available: formatBytes(storageCapacity.availableBytes) })}
              </p>
            </div>
          ) : storageCapacityStatus === "loading" ? (
            <p className="inline-flex shrink-0 items-center gap-2 text-sm text-[var(--text-secondary)]" aria-live="polite">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t("正在查询存储容量")}
            </p>
          ) : (
            <p className="shrink-0 text-sm text-[var(--text-secondary)]" role="status">
              {t("存储容量暂不可用")}
            </p>
          )}
        </div>
        {storageCapacityStatus === "ready" && storageCapacity ? (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-[var(--text-tertiary)]">
              <span>{t("存储空间使用率")}</span>
              <span className="tabular-nums">{storageUsagePercent}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={t("存储空间使用率")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={storageUsagePercent}
              className="h-2 overflow-hidden rounded-full bg-black/[0.08]"
            >
              <div
                className="h-full origin-left rounded-full bg-[#2F6BFF]"
                style={{ transform: `scaleX(${storageUsagePercent / 100})` }}
              />
            </div>
          </div>
        ) : null}
      </section>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-start gap-2">
          <Button type="button" variant="outline" onClick={beginCreateFolder} disabled={busy || creatingFolder}>
            <FolderPlus className="size-4" />
            {t("新建文件夹")}
          </Button>
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
        </div>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div ref={pathControlsRef} className="flex w-full min-w-0 flex-wrap items-center gap-2">
            <ActionTooltip label={parentPathTooltip} variant="light">
              <Button
                type="button"
                variant="outline"
                className="h-10 w-10 shrink-0 px-0"
                onClick={() => void loadPath(parentTsshPath(path))}
                disabled={busy || parentPathBlocked}
                aria-label={t("上级")}
                title={parentPathTooltip}
              >
                <Undo2 className="size-5" />
              </Button>
            </ActionTooltip>
            <div className="relative min-w-[min(100%,18rem)] flex-1">
              <Input
                ref={pathInputRef}
                className={pathEditing ? undefined : "pr-11"}
                value={pathDraft}
                onFocus={() => setPathEditing(true)}
                onClick={() => setPathEditing(true)}
                onPointerDown={() => setPathEditing(true)}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void openPathDraft();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPathDraft(path);
                    setPathEditing(false);
                  }
                }}
                placeholder={t("当前目录路径")}
                disabled={busy}
              />
              {!pathEditing ? (
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                  <ActionTooltip label={t("点击按钮或输入框空白区域可输入文件路径")}>
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => {
                        setPathEditing(true);
                        window.requestAnimationFrame(() => pathInputRef.current?.focus());
                      }}
                      disabled={busy}
                      aria-label={t("编辑文件路径")}
                    >
                      <PencilLine className="size-4" />
                    </button>
                  </ActionTooltip>
                </span>
              ) : null}
            </div>
            {pathEditing ? (
              <Button type="button" className="h-10 shrink-0 px-6" onMouseDown={(event) => event.preventDefault()} onClick={() => void openPathDraft()} disabled={busy}>
                {t("进入")}
              </Button>
            ) : (
              <>
                <ActionTooltip label={showHiddenFiles ? t("不显示隐藏文件") : t("显示隐藏文件")} variant="light">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-10 shrink-0 px-0"
                    onClick={toggleHiddenFiles}
                    aria-label={showHiddenFiles ? t("不显示隐藏文件") : t("显示隐藏文件")}
                  >
                    {showHiddenFiles ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </Button>
                </ActionTooltip>
                <ActionTooltip label={t("刷新")} variant="light">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-10 shrink-0 px-0"
                    onClick={() => void refreshPathAndCapacity()}
                    disabled={busy}
                    aria-label={t("刷新")}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  </Button>
                </ActionTooltip>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:shrink-0">
            <ActionTooltip label={downloadTooltip}>
              <Button
                type="button"
                variant="outline"
                onClick={() => void downloadSelected()}
                disabled={busy || !selectedFile || isDirectory(selectedFile) || Boolean(selectedDownloadBlockReason)}
              >
                <Download className="size-4" />
                {t("下载")}
              </Button>
            </ActionTooltip>
            <ActionTooltip label={renameTooltip}>
              <Button type="button" variant="outline" onClick={beginRenameSelected} disabled={busy || !selectedFile}>
                <PencilLine className="size-4" />
                {t("重命名")}
              </Button>
            </ActionTooltip>
            <ActionTooltip label={deleteTooltip}>
              <Button type="button" variant="destructive" onClick={() => void deleteSelected()} disabled={busy || !selectedFile}>
                <Trash2 className="size-4" />
                {t("删除")}
              </Button>
            </ActionTooltip>
          </div>
        </div>
      </div>

      {error ? <div className="rounded-md border border-[color-mix(in_oklab,var(--danger)_28%,white)] bg-[color-mix(in_oklab,var(--danger)_8%,white)] px-3 py-2 text-sm text-[var(--danger)]">{error}</div> : null}
      {selectedPermissionBlockReason ? (
        <div className="rounded-md border border-[color-mix(in_oklab,var(--warning)_28%,white)] bg-[color-mix(in_oklab,var(--warning)_8%,white)] px-3 py-2 text-sm text-[var(--warning)]">
          {selectedPermissionBlockReason}
        </div>
      ) : null}
      {notice ? <div className="rounded-md border border-[color-mix(in_oklab,var(--success)_24%,white)] bg-[color-mix(in_oklab,var(--success)_8%,white)] px-3 py-2 text-sm text-[var(--success)]">{notice}</div> : null}
      {progress ? <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]">{progress}</div> : null}

      <div className="overflow-hidden rounded-md border border-[var(--border-subtle)]">
        <div className="grid grid-cols-[minmax(0,1fr)_104px_116px] bg-[var(--surface-muted)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          <span>{t("名称")}</span>
          <span>{t("大小")}</span>
          <span>{t("修改时间")}</span>
        </div>
        <div className="max-h-[615px] overflow-auto bg-white">
          {creatingFolder ? (
            <div className="grid w-full grid-cols-[minmax(0,1fr)_104px_116px] items-center border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Folder className="size-4 text-[#b7791f]" />
                <Input
                  ref={createFolderInputRef}
                  className="h-9 max-w-sm"
                  value={newFolderDraft}
                  onChange={(event) => setNewFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createFolder();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelCreateFolder();
                    }
                  }}
                  placeholder={t("请输入文件夹名")}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-blue-500 transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => void createFolder()}
                  disabled={busy || !newFolderDraft.trim()}
                  aria-label={t("确认新建文件夹")}
                >
                  <CheckCircle className="size-4" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={cancelCreateFolder}
                  disabled={busy}
                  aria-label={t("取消新建文件夹")}
                >
                  <XCircle className="size-4" />
                </button>
              </span>
              <span className="text-[var(--text-secondary)]">-</span>
              <span className="text-[var(--text-secondary)]">-</span>
            </div>
          ) : null}
          {displayedFiles.length === 0 && !creatingFolder ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--text-tertiary)]">
              {status === "idle" ? t("连接后会显示当前目录文件。") : t("当前目录为空。")}
            </div>
          ) : (
            displayedFiles.map((file) => {
              const selected = selectedName === file.name;
              const renaming = renamingName === file.name;
              return (
                <div
                  key={`${file.type}:${file.name}`}
                  className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_104px_116px] items-center border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm transition hover:bg-[var(--surface-muted)]"
                  style={selected ? { background: "color-mix(in oklab, var(--brand-500) 9%, white)" } : undefined}
                  onClick={() => setSelectedName(file.name)}
                  onDoubleClick={() => openEntry(file)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {fileIconFor(file)}
                    {renaming ? (
                      <>
                        <Input
                          ref={renameInputRef}
                          className="h-9 max-w-sm"
                          value={renameDraft}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void renameSelected();
                              return;
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                          placeholder={t("请输入文件名")}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-blue-500 transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={(event) => {
                            event.stopPropagation();
                            void renameSelected();
                          }}
                          disabled={busy || !renameDraft.trim()}
                          aria-label={t("确认重命名")}
                        >
                          <CheckCircle className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                          onClick={(event) => {
                            event.stopPropagation();
                            cancelRename();
                          }}
                          disabled={busy}
                          aria-label={t("取消重命名")}
                        >
                          <XCircle className="size-4" />
                        </button>
                      </>
                    ) : (
                      <span className="truncate font-medium text-[var(--text-primary)]">{file.name}</span>
                    )}
                  </span>
                  <span className="text-[var(--text-secondary)]">{isDirectory(file) ? "-" : formatBytes(file.size)}</span>
                  <span className="text-[var(--text-secondary)]">{formatTime(file.modifyTime)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, File, FileArchive, FileCode2, FileText, Folder, FolderPlus, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import { joinTsshPath, parentTsshPath, TencentTsshFileClient, type TsshFileInfo } from "@/lib/tencent-tssh-file-client";

interface TatFileManagerPanelProps {
  botId: string;
}

type FileManagerStatus = "idle" | "connecting" | "loading" | "working" | "ready" | "error";

const ROOT_PATH = "/";

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
  const [path, setPath] = useState(ROOT_PATH);
  const [files, setFiles] = useState<TsshFileInfo[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [status, setStatus] = useState<FileManagerStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const selectedFile = useMemo(() => files.find((file) => file.name === selectedName) ?? null, [files, selectedName]);
  const segments = pathSegments(path);

  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setPath(ROOT_PATH);
    setFiles([]);
    setSelectedName(null);
    setNotice(null);
    setError(null);
    setProgress(null);
    setStatus("idle");
  }, [botId]);

  const getClient = async () => {
    if (clientRef.current) {
      return clientRef.current;
    }

    setStatus("connecting");
    const bootstrap = await repositories.bots.getTerminalSession(botId);
    const client = new TencentTsshFileClient(bootstrap, {
      channelId: `file-${botId}`,
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

  const downloadSelected = async () => {
    if (!selectedFile || isDirectory(selectedFile)) {
      return;
    }
    setStatus("working");
    setError(null);
    setProgress(t("准备下载..."));
    try {
      const client = await getClient();
      const blob = await client.downloadFile(joinTsshPath(path, selectedFile.name), (state) => {
        setProgress(t("已接收 {{size}}，{{chunks}} 个分块", { size: formatBytes(state.receivedBytes), chunks: state.chunks }));
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selectedFile.name;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(t("下载已开始。"));
      setStatus("ready");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : t("下载失败"));
      setStatus("error");
    } finally {
      setProgress(null);
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
            {t("通过 TAT tssh 文件协议浏览实例文件，适合下载日志、上传配置和排障材料。")}
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
          <Button type="button" size="sm" onClick={() => void loadPath(path)} disabled={busy}>
            {status === "idle" ? t("连接文件通道") : t("重新加载")}
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
          <Button type="button" variant="outline" onClick={() => void downloadSelected()} disabled={busy || !selectedFile || isDirectory(selectedFile)}>
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
      {notice ? <div className="rounded-md border border-[color-mix(in_oklab,var(--success)_24%,white)] bg-[color-mix(in_oklab,var(--success)_8%,white)] px-3 py-2 text-sm text-[var(--success)]">{notice}</div> : null}
      {progress ? <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]">{progress}</div> : null}

      <div className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
        <div className="grid grid-cols-[minmax(0,1fr)_104px_132px_112px] bg-[var(--surface-muted)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          <span>{t("名称")}</span>
          <span>{t("大小")}</span>
          <span>{t("修改时间")}</span>
          <span>{t("权限")}</span>
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
                  className="grid w-full grid-cols-[minmax(0,1fr)_104px_132px_112px] items-center border-t border-[var(--border-subtle)] px-3 py-2.5 text-left text-sm transition hover:bg-[var(--surface-muted)]"
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
                  <span className="truncate text-[var(--text-tertiary)]">{file.rights ?? file.type}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

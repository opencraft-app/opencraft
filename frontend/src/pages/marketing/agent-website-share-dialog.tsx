import { Copy, KeyRound, Loader2, RefreshCw, Share2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useT } from "@/i18n/t";

/**
 * 分享弹窗所需的站点最小字段。两个页面各自的 WebsiteSite 都满足此结构化子集，
 * 传入时无需额外转换。
 */
export interface ShareDialogSite {
  SiteID: string;
  Name: string;
  PublicURL: string;
  AccessMode?: "owner_only" | "share_code";
  ShareExpiresAt?: string | null;
}

interface WebsiteShareDialogProps {
  site: ShareDialogSite;
  onClose: () => void;
  /** 分享状态（开启/重置/停止）变更后回调，用于父组件刷新列表 */
  onChanged: () => void;
}

interface ShareAccessResponse {
  mode?: string;
  code?: string;
  expires_at?: string;
}

function buildAuthHeaders(): HeadersInit {
  const headers = new Headers();
  const token = readStoredAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function formatDateTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

const SHARE_DURATIONS = [1, 7, 30] as const;

export const WebsiteShareDialog = ({ site, onClose, onChanged }: WebsiteShareDialogProps) => {
  const t = useT();
  const [durationDays, setDurationDays] = useState<number>(7);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(site.ShareExpiresAt ?? null);
  /** 本次会话中用户点了「停止分享」：用于覆盖后端返回的分享态 */
  const [stopped, setStopped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** 是否处于分享中：本次会话拿到过明文码，或后端返回的站点本就是 share_code 模式 */
  const isSharing = !stopped && (code !== null || site.AccessMode === "share_code");

  const callAccess = useCallback(
    async (path: string, init?: RequestInit): Promise<ShareAccessResponse> => {
      const apiBase = resolveConfiguredAuthApiBaseUrl();
      if (!apiBase) throw new Error(t("服务地址未配置"));
      const res = await fetch(`${apiBase}${path}`, {
        credentials: "include",
        headers: { ...buildAuthHeaders(), ...(init?.headers ?? {}) },
        ...init,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.code !== "OK") {
        throw new Error(json?.message || t("操作失败，请稍后重试"));
      }
      return (json.data ?? {}) as ShareAccessResponse;
    },
    [t],
  );

  const handleEnable = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "share_code", duration_days: durationDays }),
      });
      setCode(data.code ?? null);
      setExpiresAt(data.expires_at ?? null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [callAccess, durationDays, site.SiteID, onChanged]);

  const handleReset = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/share-code/reset`, {
        method: "POST",
      });
      setCode(data.code ?? null);
      setExpiresAt(data.expires_at ?? null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [callAccess, site.SiteID, onChanged]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await callAccess(`/v1/websites/${site.SiteID}/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "owner_only" }),
      });
      setStopped(true);
      setCode(null);
      setExpiresAt(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [callAccess, site.SiteID, onChanged]);

  const shareText = code
    ? `hello，我使用LightVela给你分享了一个网站，点击输入分享码可以查看：\n${site.PublicURL}\n分享码：${code}\n有效期至：${formatDateTime(expiresAt ?? "")}`
    : "";

  const writeToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!shareText) return;
    const ok = await writeToClipboard(shareText);
    if (ok) {
      markCopied();
    } else {
      setError(t("复制失败，请手动复制"));
    }
  }, [shareText, writeToClipboard, markCopied, t]);

  /**
   * 「无明文码」态下的一键复制。流程：调重置接口拿到新码 → 立刻用新码
   * 拼出含码文案并写入剪贴板。原分享码随之失效。
   */
  const handleCopyWithReset = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/share-code/reset`, {
        method: "POST",
      });
      const newCode = data.code ?? null;
      const newExpiresAt = data.expires_at ?? null;
      setCode(newCode);
      setExpiresAt(newExpiresAt);
      onChanged();

      if (newCode) {
        const text = `hello，我使用LightVela给你分享了一个网站，点击输入分享码可以查看：\n${site.PublicURL}\n分享码：${newCode}\n有效期至：${formatDateTime(newExpiresAt ?? "")}`;
        const ok = await writeToClipboard(text);
        if (ok) {
          markCopied();
        } else {
          setError(t("复制失败，请手动复制"));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [callAccess, site.SiteID, site.PublicURL, writeToClipboard, markCopied, onChanged, t]);

  const shownCode = code ?? "";

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={() => !loading && onClose()}
    >
      <motion.div
        className="relative mx-4 w-full max-w-[420px] overflow-hidden rounded-2xl bg-white"
        style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pb-5 pt-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full"
              style={{ background: "rgba(0,0,0,0.05)" }}
            >
              <Share2 className="h-4 w-4" style={{ color: "#333" }} />
            </div>
            <h3 className="m-0 flex-1 text-[16px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
              {t("分享网站")}
            </h3>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex h-7 w-7 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-black/[0.05] disabled:opacity-50"
              title={t("取消")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="text-[13px] leading-relaxed" style={{ margin: "10px 0 0 0", color: "#666" }}>
            {t("工作台名称")}：{site.Name}
          </p>

          {/* 未分享态：直接选择有效期后开启 */}
          {!isSharing ? (
            <div className="mt-4">
              <p className="mb-1.5 text-[11px] font-medium" style={{ color: "#999" }}>
                {t("分享链接有效期")}
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {SHARE_DURATIONS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setDurationDays(days)}
                    className="rounded-md border py-1.5 text-[13px] font-medium transition-colors"
                    style={{
                      borderColor: durationDays === days ? "#000" : "rgba(0,0,0,0.1)",
                      background: durationDays === days ? "#000" : "transparent",
                      color: durationDays === days ? "#fff" : "#666",
                    }}
                  >
                    {days} {t("天")}
                  </button>
                ))}
              </div>

              <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: "#999" }}>
                {t("开启分享后将生成分享码，可一键复制给好友。")}
              </p>

              <div className="mt-4 flex gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                  style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={handleEnable}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("开启分享")}
                </button>
              </div>
            </div>
          ) : shownCode ? (
            /* 已分享 + 有明文码（刚开启/重置后） */
            <div className="mt-4">
              <div className="rounded-xl px-4 py-3.5 text-center" style={{ background: "rgba(0,0,0,0.04)" }}>
                <p className="mb-1.5 text-[11px]" style={{ color: "#999" }}>
                  {t("分享码")}
                </p>
                <p className="select-all text-xl font-bold tracking-[0.2em]" style={{ color: "#111" }}>
                  {shownCode}
                </p>
                {expiresAt && (
                  <p className="mt-1.5 text-[11px]" style={{ color: "#999" }}>
                    {t("有效期至")} {formatDateTime(expiresAt)}
                  </p>
                )}
              </div>
              <div className="mt-3.5 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex flex-[2] items-center justify-center gap-1.5 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85"
                >
                  {copied ? <KeyRound className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? t("已复制") : t("复制分享信息")}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                  style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {t("重置")}
                </button>
              </div>
              <button
                type="button"
                onClick={handleStop}
                disabled={loading}
                className="mt-2.5 w-full rounded-lg py-2 text-sm font-medium transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                style={{ color: "#999" }}
              >
                {t("停止分享")}
              </button>
            </div>
          ) : (
            /* 已分享 + 无明文码（二次打开） */
            <div className="mt-4">
              <div className="rounded-xl px-4 py-3" style={{ background: "rgba(0,0,0,0.04)" }}>
                <p className="mb-1 text-[11px] font-medium" style={{ color: "#999" }}>
                  {t("站点地址")}
                </p>
                <p
                  className="select-all truncate text-sm font-medium"
                  style={{ color: "#333" }}
                  title={site.PublicURL}
                >
                  {site.PublicURL}
                </p>
              </div>
              <div className="mt-2 rounded-xl px-4 py-3">
                <p className="text-sm font-medium" style={{ color: "#333" }}>
                  {t("分享已开启")}
                </p>
                {expiresAt && (
                  <p className="mt-0.5 text-xs" style={{ color: "#999" }}>
                    {t("有效期至")} {formatDateTime(expiresAt)}
                  </p>
                )}
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: "#999" }}>
                {t("点击「复制分享信息」将生成新分享码并复制完整文案，原分享码立即失效。")}
              </p>
              <div className="mt-2.5 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCopyWithReset}
                  disabled={loading}
                  className="flex flex-[2] items-center justify-center gap-1.5 rounded-lg bg-black px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : copied ? (
                    <KeyRound className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied ? t("已复制") : t("复制分享信息")}
                </button>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-[color-mix(in_oklab,var(--danger)_6%,transparent)] disabled:opacity-50"
                  style={{ borderColor: "rgba(0,0,0,0.1)", color: "var(--danger)" }}
                >
                  {t("停止分享")}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

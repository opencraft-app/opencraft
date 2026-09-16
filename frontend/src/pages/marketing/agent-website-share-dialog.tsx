import { useCallback, useRef, useState } from "react";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useT } from "@/i18n/t";
import { WebsiteShareDialogView } from "./website-share-dialog-view";

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
  /** 分享状态（开启/重置/停止）变更后回调，用于父组件同步站点分享字段 */
  onChanged: (next: { mode: "share_code" | "owner_only"; expiresAt: string | null }) => void;
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
  /** 本次会话点过「开启分享」：兜底确保开启后立即进入已分享态，不依赖父组件 site.AccessMode 同步 */
  const [hasEnabled, setHasEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const clipboardContainerRef = useRef<HTMLDivElement>(null);

  /** 是否处于分享中：本次会话拿到过明文码，或后端返回的站点本就是 share_code 模式 */
  const isSharing = !stopped && (code !== null || site.AccessMode === "share_code" || hasEnabled);

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
    setStopped(false);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "share_code", duration_days: durationDays }),
      });
      setCode(data.code ?? null);
      setExpiresAt(data.expires_at ?? null);
      setHasEnabled(true);
      onChanged({ mode: "share_code", expiresAt: data.expires_at ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [callAccess, durationDays, site.SiteID, onChanged]);

  const handleReset = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStopped(false);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/share-code/reset`, {
        method: "POST",
      });
      setCode(data.code ?? null);
      setExpiresAt(data.expires_at ?? null);
      onChanged({ mode: "share_code", expiresAt: data.expires_at ?? null });
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
      onChanged({ mode: "owner_only", expiresAt: null });
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
      const container = clipboardContainerRef.current ?? document.body;
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Keep the native selection inside the active modal's focus scope.
      container.appendChild(ta);
      ta.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        const restoreFocus = document.activeElement === ta;
        container.removeChild(ta);
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
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
    setStopped(false);
    try {
      const data = await callAccess(`/v1/websites/${site.SiteID}/share-code/reset`, {
        method: "POST",
      });
      const newCode = data.code ?? null;
      const newExpiresAt = data.expires_at ?? null;
      setCode(newCode);
      setExpiresAt(newExpiresAt);
      onChanged({ mode: "share_code", expiresAt: newExpiresAt });

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
    <WebsiteShareDialogView
      contentRef={clipboardContainerRef}
      siteName={site.Name}
      publicUrl={site.PublicURL}
      durationDays={durationDays}
      durationOptions={SHARE_DURATIONS.map((days) => ({ value: days, label: `${days} ${t("天")}` }))}
      isSharing={isSharing}
      code={shownCode}
      expiresLabel={expiresAt ? `${t("有效期至")} ${formatDateTime(expiresAt)}` : ""}
      loading={loading}
      copied={copied}
      error={error}
      labels={{
        title: t("分享网站"), close: t("关闭"), cancel: t("取消"), siteName: t("工作台名称"),
        duration: t("分享链接有效期"), enable: t("开启分享"), enableHint: t("开启分享后将生成分享码，可一键复制给好友。"),
        code: t("分享码"), reset: t("重置分享码"), copy: t("复制分享信息"), copied: t("已复制"),
        stop: t("停止分享"), address: t("站点地址"), sharing: t("分享已开启"),
        resetCopyHint: t("点击「复制分享信息」会重置分享码并复制新的分享信息，原分享码将立即失效。"),
      }}
      onDurationChange={setDurationDays}
      onEnable={handleEnable}
      onReset={handleReset}
      onCopy={shownCode ? handleCopy : handleCopyWithReset}
      onStop={handleStop}
      onClose={onClose}
    />
  );
};

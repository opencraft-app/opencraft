"use client";

import { AlertCircle, Loader2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type { CloudDesktopSession } from "@/domain/types";
import { cn } from "@/lib/utils";/**
 * 云桌面（VNC）面板 —— 实验室 › 云桌面。
 *
 * 交互契约（cloud-desktop-vnc-plan §4.3 / §6）：
 *  1. POST desktop/session 幂等触发 provision → Provisioning
 *  2. 轮询 GET desktop/session 直到 Ready（携带 wsUrl/password）
 *  3. noVNC (RFB) 连 wsUrl，凭 password 认证；连接期每 30s 轮询一次 GET 作 idle 回收心跳
 *  4. Failed 可一键重试（重新 POST）；wsUrl 一律由后端下发，前端不拼 IP
 */

const DESKTOP_POLL_INTERVAL_MS = 3_000;
const DESKTOP_HEARTBEAT_MS = 30_000;
const DESKTOP_MAX_POLL_ERRORS = 5;

type PanelPhase = "idle" | "installing" | "provisioning" | "connecting" | "connected" | "failed";

type RFBLike = {
  sendCredentials: (credentials: { password: string }) => void;
  scaleViewport: boolean;
  resizeSession: boolean;
  disconnect: () => void;
};

export function AgentCloudDesktopPanel({ botId }: { botId: string }) {
  const t = useT();
  const repositories = useRepositories();

  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [session, setSession] = useState<CloudDesktopSession | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFBLike | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const teardown = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    try {
      rfbRef.current?.disconnect();
    } catch {
      // disconnect on already-closed connection is safe to ignore
    }
    rfbRef.current = null;
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
  }, []);

  // 触发 + 轮询 + 连接 的主流程。retryToken 驱动重试。
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    const abort = new AbortController();
    pollAbortRef.current = abort;
    let pollErrors = 0;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const startHeartbeat = () => {
      if (heartbeat) return;
      // idle 回收心跳：连接期间周期 GET 刷新 last_active（plan §4.5）。
      heartbeat = setInterval(() => {
        repositories.bots
          .getDesktopSession(botId)
          .catch(() => undefined /* 心跳失败不打断 viewer */);
      }, DESKTOP_HEARTBEAT_MS);
    };

    const run = async () => {
      setPhase("provisioning");
      setErrorText(null);
      try {
        let current = await repositories.bots.ensureDesktopSession(botId);
        setSession(current);
        if (current.status === "Failed") {
          throw new Error(current.reason || t("云桌面启动失败"));
        }
        // 首次可能进入 Installing（按需装图形层），需在轮询前先切到 installing 相位。
        setPhase(current.status === "Installing" ? "installing" : "provisioning");

        // Installing / Provisioning → Ready 轮询
        while (!cancelled && current.status !== "Ready") {
          if (current.status === "Failed") {
            throw new Error(current.reason || t("云桌面启动失败"));
          }
          await new Promise((resolve) => setTimeout(resolve, DESKTOP_POLL_INTERVAL_MS));
          if (cancelled) return;
          try {
            current = await repositories.bots.getDesktopSession(botId);
            setSession(current);
            setPhase(current.status === "Installing" ? "installing" : "provisioning");
            pollErrors = 0;
          } catch (err) {
            pollErrors += 1;
            if (pollErrors >= DESKTOP_MAX_POLL_ERRORS) {
              throw err;
            }
          }
        }
        if (cancelled || !current.wsUrl || !current.password) return;

        // Ready → noVNC 连接
        setPhase("connecting");
        const [{ default: RFB }, wsURL] = await Promise.all([
          // noVNC npm 包只发布 lib/（core/ 是源码仓路径）。
          import("@novnc/novnc/lib/rfb"),
          Promise.resolve(current.wsUrl),
        ]);
        if (cancelled || !containerRef.current) return;

        const rfb = new RFB(containerRef.current, wsURL, {
          credentials: { password: current.password },
        });
        rfb.addEventListener("connect", () => {
          if (!cancelled) {
            setPhase("connected");
            startHeartbeat();
          }
        });
        rfb.addEventListener("disconnect", (event) => {
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          if (!cancelled) {
            setPhase("failed");
            setErrorText(
              event.detail?.clean
                ? t("云桌面连接已断开")
                : t("云桌面连接中断，请点击重试"),
            );
          }
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbRef.current = rfb as unknown as RFBLike;
      } catch (err) {
        if (cancelled) return;
        setPhase("failed");
        setErrorText(err instanceof Error ? err.message : String(err));
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, retryToken, repositories, t, teardown]);

  const statusText =
    phase === "installing"
      ? session?.message || t("正在安装桌面环境（首次约需 2–4 分钟）…")
      : phase === "provisioning"
        ? t("正在启动云桌面（首次约需 1–2 分钟）…")
        : phase === "connecting"
          ? t("正在建立桌面连接…")
          : phase === "connected"
            ? t("云桌面已连接")
            : null;

  // Installing 阶段的进度百分比（后端 install_progress，0-100）。
  const installProgress =
    phase === "installing" && typeof session?.installProgress === "number"
      ? Math.max(0, Math.min(100, Math.round(session.installProgress)))
      : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Monitor className="text-muted-foreground h-5 w-5" />
          <div>
            <h2 className="text-lg font-semibold">{t("云桌面")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("在浏览器中实时操作你的云端桌面（VNC），无需公网 IP")}
            </p>
          </div>
        </div>
        {phase === "failed" && (
          <button
            type="button"
            onClick={() => {
              setSession(null);
              setErrorText(null);
              setRetryToken((n) => n + 1);
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            <RefreshCw className="h-4 w-4" />
            {t("重试")}
          </button>
        )}
      </div>

      {statusText && (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {statusText}
        </div>
      )}

      {installProgress !== null && (
        <div className="space-y-1">
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-500"
              style={{ width: `${installProgress}%` }}
            />
          </div>
          <div className="text-muted-foreground text-right text-xs tabular-nums">
            {installProgress}%
          </div>
        </div>
      )}

      {errorText && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{errorText}</span>
        </div>
      )}

      {session?.status === "Failed" && session.reason && !errorText && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {session.reason}
        </div>
      )}

      <div
        className={cn(
          "bg-card relative overflow-hidden rounded-lg border",
          phase === "connected" ? "aspect-video" : "hidden",
        )}
      >
        <div ref={containerRef} className="h-full w-full" />
      </div>

      {phase !== "connected" && phase !== "failed" && (
        <div className="bg-card text-muted-foreground flex aspect-video items-center justify-center rounded-lg border border-dashed">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">{statusText || t("准备中…")}</p>
            {installProgress !== null && (
              <p className="text-xs tabular-nums">{installProgress}%</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

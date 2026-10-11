"use client";

import { AlertCircle, CheckCircle2, Loader2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type { CloudDesktopSession } from "@/domain/types";
import { cn } from "@/lib/utils";/**
 * 云电脑（VNC）面板 —— 实验室 › 云电脑。
 *
 * 交互契约（cloud-desktop-vnc-plan §4.3 / §6）：
 *  1. POST desktop/session 幂等触发 provision → Provisioning
 *  2. 轮询 GET desktop/session 直到 Ready（携带 wsUrl/password）
 *  3. noVNC (RFB) 连 wsUrl，凭 password 认证；连接期每 30s 轮询一次 GET 作 idle 回收心跳
 *  4. Failed 可一键重试（重新 POST）；wsUrl 一律由后端下发，前端不拼 IP
 */

// Provisioning 态已接近就绪（拉起服务 + 探测，通常数秒），轮询快一点可缩短进入
// 桌面的等待体感。
const DESKTOP_POLL_INTERVAL_MS = 3_000;
// Installing 态是按需装图形层（apt，通常 2-5 分钟）。后端进度文件本身约 8s 才刷新
// 一次（ctl desktopInstallPollInterval），此阶段用 3s 轮询纯属空转、会打出上百次
// 拿到同一进度值的无效请求。拉到 6s，既对齐后端更新节奏、显著降频，又不致让进度
// 显示太迟钝。
const DESKTOP_INSTALLING_POLL_INTERVAL_MS = 6_000;
const DESKTOP_HEARTBEAT_MS = 30_000;
const DESKTOP_MAX_POLL_ERRORS = 5;
// WebSocket 保活间隔：桌面静止时 wss 链路长时间无字节，会被腾讯云 CLB 按
// 「连接空闲/会话保持」超时（HTTP 监听器默认 30s）判定空闲并断开，表现为
// 「不操作一会儿就断、点重试又能连」。这里在连接期周期性发一条 incremental
// FramebufferUpdateRequest（RFB 消息类型 3），让 wss 链路有周期性流量，
// 规避 CLB 空闲回收。间隔取 20s，明显小于 30s。
// 注意：这与上面的 DESKTOP_HEARTBEAT_MS 是两回事——心跳是独立的 GET HTTP 轮询
// （刷新后端 idle last_active），不经过 wss 长连接，无法为其保活。
const DESKTOP_WS_KEEPALIVE_MS = 20_000;

type PanelPhase = "idle" | "installing" | "provisioning" | "connecting" | "connected" | "failed";

type RFBLike = {
  sendCredentials: (credentials: { password: string }) => void;
  // sendFramebufferUpdateRequest()：经 noVNC 底层 WebSocket 发一条 10 字节的
  // RFB FramebufferUpdateRequest（类型 3，incremental=1，1×1 区域），让 wss
  // 链路有周期性流量，规避腾讯云 CLB 空闲回收。不产生任何键盘/鼠标事件。
  // 实现直接访问 rfb._sock._websocket（原生 WebSocket），绕过 noVNC 队列，
  // 是稳定的标准 API，不依赖 noVNC 内部方法签名。
  sendFramebufferUpdateRequest: () => void;
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
    let wsKeepalive: ReturnType<typeof setInterval> | null = null;

    const startHeartbeat = () => {
      if (heartbeat) return;
      // idle 回收心跳：连接期间周期 GET 刷新 last_active（plan §4.5）。
      heartbeat = setInterval(() => {
        repositories.bots
          .getDesktopSession(botId)
          .catch(() => undefined /* 心跳失败不打断 viewer */);
      }, DESKTOP_HEARTBEAT_MS);
    };

    // ws 保活：连接期周期性发一条 RFB FramebufferUpdateRequest（incremental=1），
    // 让 wss 链路有流量，规避腾讯云 CLB 对空闲连接的超时回收（见常量注释）。
    const startWsKeepalive = () => {
      if (wsKeepalive) return;
      wsKeepalive = setInterval(() => {
        try {
          rfbRef.current?.sendFramebufferUpdateRequest();
        } catch {
          // 连接已断/尚未就绪时发送失败可忽略，disconnect 会清理定时器。
        }
      }, DESKTOP_WS_KEEPALIVE_MS);
    };

    const stopTimers = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (wsKeepalive) {
        clearInterval(wsKeepalive);
        wsKeepalive = null;
      }
    };

    const run = async () => {
      setPhase("provisioning");
      setErrorText(null);
      try {
        let current = await repositories.bots.ensureDesktopSession(botId);
        setSession(current);
        if (current.status === "Failed") {
          throw new Error(current.reason?.trim() || t("云电脑启动失败"));
        }
        // 首次可能进入 Installing（按需装图形层），需在轮询前先切到 installing 相位。
        setPhase(current.status === "Installing" ? "installing" : "provisioning");

        // Installing / Provisioning → Ready 轮询
        while (!cancelled && current.status !== "Ready") {
          if (current.status === "Failed") {
            throw new Error(current.reason?.trim() || t("云电脑启动失败"));
          }
          // 按阶段分级轮询：Installing（apt 装图形层，分钟级）用更大间隔降频，
          // Provisioning（接近就绪）保持较快轮询以缩短进入桌面的等待。
          const pollDelayMs =
            current.status === "Installing"
              ? DESKTOP_INSTALLING_POLL_INTERVAL_MS
              : DESKTOP_POLL_INTERVAL_MS;
          await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
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
            startWsKeepalive();
          }
        });
        rfb.addEventListener("disconnect", (event) => {
          stopTimers();
          if (!cancelled) {
            setPhase("failed");
            setErrorText(
              event.detail?.clean
                ? t("云电脑连接已断开")
                : t("云电脑连接中断，请点击重试"),
            );
          }
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        // RFB FramebufferUpdateRequest（类型 3，incremental=1，1×1）：10 字节，
        // 通过 noVNC 底层原生 WebSocket 直接发送，完全不产生键盘/鼠标事件。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawWs: WebSocket | undefined = (rfb as any)?._sock?._websocket;
        const rfbLike: RFBLike = {
          sendCredentials: rfb.sendCredentials.bind(rfb),
          sendFramebufferUpdateRequest: () => {
            if (rawWs?.readyState === WebSocket.OPEN) {
              // type=3, incremental=1, x=0,y=0, w=1,h=1
              rawWs.send(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]));
            }
          },
          get scaleViewport() { return rfb.scaleViewport; },
          set scaleViewport(v) { rfb.scaleViewport = v; },
          get resizeSession() { return rfb.resizeSession; },
          set resizeSession(v) { rfb.resizeSession = v; },
          disconnect: rfb.disconnect.bind(rfb),
        };
        rfbRef.current = rfbLike;
      } catch (err) {
        if (cancelled) return;
        setPhase("failed");
        setErrorText(err instanceof Error && err.message.trim() ? err.message : t("云电脑启动失败"));
      }
    };

    void run();
    return () => {
      cancelled = true;
      stopTimers();
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, retryToken, repositories, t, teardown]);

  const statusText =
    phase === "installing"
      ? session?.installPhase === "configuring_wallpaper"
        ? t("正在配置云电脑壁纸…")
        : t("正在安装桌面环境（首次约需 2–4 分钟）…")
      : phase === "provisioning"
        ? t("正在启动云电脑（首次约需 1–2 分钟）…")
        : phase === "connecting"
          ? t("正在建立桌面连接…")
          : phase === "connected"
            ? t("云电脑已连接")
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
            <h2 className="text-lg font-semibold">{t("云电脑")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("在浏览器中实时操作你的云端电脑")}
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

      {phase === "connected" && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-500"
        >
          <CheckCircle2 className="h-4 w-4" />
          {statusText}
        </div>
      )}

      {errorText && (
        <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{errorText}</span>
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
            <p role="status" aria-live="polite" className="text-sm">{statusText || t("准备中…")}</p>
            {installProgress !== null && (
              <p className="text-xs tabular-nums">{installProgress}%</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

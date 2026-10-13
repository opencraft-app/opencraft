"use client";

import { AlertCircle, CheckCircle2, Loader2, Monitor, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type {
  CloudDesktopSession,
  CloudDesktopViewerAccess,
  CloudDesktopViewerClaim,
} from "@/domain/types";
import {
  openDesktopTatSocket,
  type DesktopRawChannel,
  type DesktopTatConnection,
} from "@/lib/desktop-tat-transport";
import { cn } from "@/lib/utils";/**
 * 云电脑（VNC）面板 —— 实验室 › 云电脑。
 *
 * 交互契约（ingressproxy 下线 + 不下发 VNC 密码）：
 *  1. POST/GET desktop/session 走准备状态机（Installing/Provisioning/Ready），
 *     仅用于阶段与进度展示；**该接口不再下发 wsUrl/password**
 *  2. POST desktop/resource 幂等准备 → 轮询到 prepared（不返回任何凭据）
 *  3. POST desktop/viewer 签发一次性租约 → POST .../claim 兑换票据
 *  4. 经实例级、已鉴权的 TAT 会话把媒体隧道到浏览器（**无公网 URL、无密码**）
 *  5. noVNC (RFB) 直接跑在该通道上；可写端点由服务端授权，未授权时输入被丢弃
 *  6. 断线按退避自动重连（每次重新签发租约并重做物理身份校验）；租约到期同样重连
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

// 自动重连：媒体改走 TAT 后链路多一跳，断连概率只增不减，「断线即死、手动点重
// 试」等于把链路复杂度的代价转嫁给用户。但这里的重连不是重连 socket——租约单次
// 使用，重连实为「重新签发租约 + 重开隧道」，每次都要重新做物理身份校验，成本
// 不低，所以必须退避且有上限，绝不能失败就立刻重试。
const DESKTOP_RECONNECT_BASE_MS = 1_000;
const DESKTOP_RECONNECT_MAX_MS = 16_000;
const DESKTOP_RECONNECT_MAX_ATTEMPTS = 5;

// 物理机器身份：沙箱内 HMAC 校验出的 64 位 hex，不是准备代次。
const DESKTOP_INCARNATION_PATTERN = /^[0-9a-f]{64}$/;
// 与后端契约一致：租约必须是有限的、且不超过 10 分钟。
const DESKTOP_MAX_LEASE_MS = 600_000;
const DESKTOP_RESOURCE_TIMEOUT_MS = 90_000;
const DESKTOP_RFB_HANDSHAKE_TIMEOUT_MS = 30_000;

function isRetryableDesktopError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  if ("retryable" in error && error.retryable === false) return false;
  if ("status" in error && typeof error.status === "number") {
    return error.status < 400 || error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return true;
}

/**
 * 流程失败的分类。`retryable` 区分两类失败：
 *   - true ：网络/瞬时类，可自动重连；
 *   - false：语义失败或安全校验失败，必须交给用户决策。
 * 物理身份没校验通过时自动重试等于绕过安全模型，所以这类一律不可重试。
 */
class DesktopFlowError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "DesktopFlowError";
    this.retryable = retryable;
  }
}

/**
 * 后端返回的租约必须逐字段校验后才能用。宁可看不到云电脑，也不能把画面和键鼠
 * 交给一台没证明过物理身份的机器，或一个没有明确上限的租约。
 */
function assertDesktopLease(claim: CloudDesktopViewerClaim, t: (text: string) => string): void {
  if (!DESKTOP_INCARNATION_PATTERN.test(claim.incarnation)) {
    throw new DesktopFlowError(t("云电脑目标校验失败"), false);
  }
  if (
    !Number.isSafeInteger(claim.expiresAt) ||
    claim.expiresAt <= Date.now() ||
    claim.expiresAt > Date.now() + DESKTOP_MAX_LEASE_MS
  ) {
    throw new DesktopFlowError(t("云电脑租约有效期异常"), false);
  }
}

type PanelPhase =
  | "idle"
  | "installing"
  | "provisioning"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

type RFBLike = {
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
  // write = 键鼠可用；read = 可写端点未就绪，降级为只读观看。
  const [access, setAccess] = useState<CloudDesktopViewerAccess | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // 当前处于第几次自动重连（0 = 首次连接，尚未发生重连）。
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFBLike | null>(null);
  const channelRef = useRef<DesktopRawChannel | null>(null);
  const transportRef = useRef<DesktopTatConnection | null>(null);
  const attachmentRef = useRef<string | null>(null);

  const releaseViewer = useCallback(() => {
    const attachmentId = attachmentRef.current;
    attachmentRef.current = null;
    if (!attachmentId) return;
    // 撤权是尽力而为：页面卸载时租约最迟 5 分钟后自然过期。
    void repositories.bots.releaseDesktopViewer(botId, attachmentId).catch(() => undefined);
  }, [botId, repositories]);

  const teardown = useCallback(() => {
    const rfb = rfbRef.current;
    const transport = transportRef.current;
    rfbRef.current = null;
    channelRef.current = null;
    transportRef.current = null;
    try {
      rfb?.disconnect();
    } catch {
      // disconnect on already-closed connection is safe to ignore
    }
    transport?.close();
    releaseViewer();
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
  }, [releaseViewer]);

  // 触发 + 轮询 + 连接 的主流程。retryToken 驱动重试。
  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let wsKeepalive: ReturnType<typeof setInterval> | null = null;
    let leaseTimer: ReturnType<typeof setTimeout> | null = null;
    let resourceTimer: ReturnType<typeof setTimeout> | null = null;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let resolvePoll: (() => void) | null = null;
    let reconnectAttempts = 0;
    // 每次连接尝试发号：旧 RFB 实例的 disconnect 事件因号不匹配被忽略，避免
    // 「teardown → disconnect → 再重连」的自激。
    let attemptSeq = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // 页面在后台时挂起重连，回到前台再继续。
    let pendingReconnect = false;
    const isCurrentAttempt = (seq: number) => !cancelled && seq === attemptSeq;
    const waitForPoll = (delay: number) => new Promise<void>((resolve) => {
      resolvePoll = resolve;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        resolvePoll = null;
        resolve();
      }, delay);
    });

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

    const stopTimers = (preserveResourceBudget = false) => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (wsKeepalive) {
        clearInterval(wsKeepalive);
        wsKeepalive = null;
      }
      if (leaseTimer) {
        clearTimeout(leaseTimer);
        leaseTimer = null;
      }
      if (!preserveResourceBudget) {
        if (resourceTimer) clearTimeout(resourceTimer);
        resourceTimer = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      pendingReconnect = false;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      resolvePoll?.();
      resolvePoll = null;
    };

    // 重连途中同样会经过 provisioning/connecting，但用户看到的应该是「正在重新
    // 连接」，否则会误以为云电脑被重启了。
    const goPhase = (next: PanelPhase) =>
      setPhase(
        reconnectAttempts > 0 && (next === "provisioning" || next === "connecting")
          ? "reconnecting"
          : next,
      );

    const isPageVisible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    /**
     * 安排一次重连：退避递增、有次数上限；页面在后台时挂起，不做无意义的续租。
     */
    const scheduleReconnect = (message: string) => {
      if (cancelled || reconnectTimer || pendingReconnect) return;
      if (reconnectAttempts >= DESKTOP_RECONNECT_MAX_ATTEMPTS) {
        setPhase("failed");
        setErrorText(message);
        return;
      }
      reconnectAttempts += 1;
      setReconnectAttempt(reconnectAttempts);
      setErrorText(null);
      goPhase("reconnecting");
      if (!isPageVisible()) {
        pendingReconnect = true;
        return;
      }
      const delay = Math.min(
        DESKTOP_RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1),
        DESKTOP_RECONNECT_MAX_MS,
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        if (!isPageVisible()) {
          pendingReconnect = true;
          return;
        }
        void attempt();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (cancelled || !pendingReconnect || !isPageVisible()) return;
      pendingReconnect = false;
      void attempt();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const failAttempt = (seq: number, error: unknown) => {
      if (!isCurrentAttempt(seq)) return;
      // 先使旧事件失效，再停止计时和断开，避免同步 disconnect 重入及迟到事件。
      attemptSeq += 1;
      const retryable = isRetryableDesktopError(error);
      stopTimers(retryable && reconnectAttempts < DESKTOP_RECONNECT_MAX_ATTEMPTS);
      teardown();
      const message =
        error instanceof Error && error.message.trim() ? error.message : t("云电脑启动失败");
      if (!retryable) {
        setPhase("failed");
        setErrorText(message);
        return;
      }
      scheduleReconnect(message);
    };

    // 资源准备总预算从首次进入 connecting 起算，跨重试共享同一个计时器。它耗尽
    // 表示「总时长内始终没能完成准备」，是与具体某一轮无关的最终失败，必须无条件
    // 终结整个流程。因此这里刻意绕开 failAttempt 的 seq 守卫（否则：用全局
    // attemptSeq 会在到点时误杀一个正在正常运行的新 attempt；用创建轮 seq 又会在
    // 任意一次重连后因 isCurrentAttempt 失配而彻底哑火、放任超预算）。
    const failResourceBudget = () => {
      if (cancelled) return;
      // 使任何在跑的 run 失效，避免 teardown → disconnect 的迟到事件自激重连。
      attemptSeq += 1;
      stopTimers();
      teardown();
      setPhase("failed");
      setErrorText(t("云电脑启动失败"));
    };

    const attempt = async (): Promise<void> => {
      const seq = ++attemptSeq;
      try {
        await run(seq);
      } catch (err) {
        failAttempt(seq, err);
      }
    };

    const run = async (seq: number) => {
      goPhase("provisioning");
      setErrorText(null);
      try {
        let pollErrors = 0;
        let current = await repositories.bots.ensureDesktopSession(botId);
        if (!isCurrentAttempt(seq)) return;
        setSession(current);
        // 首次可能进入 Installing（按需装图形层），需在轮询前先切到 installing 相位。
        goPhase(current.status === "Installing" ? "installing" : "provisioning");

        // Installing / Provisioning → Ready 轮询
        while (isCurrentAttempt(seq) && current.status !== "Ready") {
          if (current.status === "Failed") {
            throw new DesktopFlowError(current.reason?.trim() || t("云电脑启动失败"), false);
          }
          if (current.status === "Paused") {
            throw new DesktopFlowError(t("云电脑已休眠，请点击重试"), false);
          }
          // 按阶段分级轮询：Installing（apt 装图形层，分钟级）用更大间隔降频，
          // Provisioning（接近就绪）保持较快轮询以缩短进入桌面的等待。
          const pollDelayMs =
            current.status === "Installing"
              ? DESKTOP_INSTALLING_POLL_INTERVAL_MS
              : DESKTOP_POLL_INTERVAL_MS;
          await waitForPoll(pollDelayMs);
          if (!isCurrentAttempt(seq)) return;
          try {
            current = await repositories.bots.getDesktopSession(botId);
            if (!isCurrentAttempt(seq)) return;
            setSession(current);
            goPhase(current.status === "Installing" ? "installing" : "provisioning");
            pollErrors = 0;
          } catch (err) {
            if (!isCurrentAttempt(seq)) return;
            if (!isRetryableDesktopError(err)) throw err;
            pollErrors += 1;
            if (pollErrors >= DESKTOP_MAX_POLL_ERRORS) throw err;
          }
        }
        if (!isCurrentAttempt(seq)) return;

        // Ready → 再走 desktop/resource 准备，签发一次性观看租约，最后经实例级
        // TAT 隧道连接：不下发公网 URL、不下发 VNC 密码。
        goPhase("connecting");
        if (!resourceTimer) {
          resourceTimer = setTimeout(() => {
            failResourceBudget();
          }, DESKTOP_RESOURCE_TIMEOUT_MS);
        }
        let desktop = await repositories.bots.ensureDesktopResource(botId);
        if (!isCurrentAttempt(seq)) return;
        while (isCurrentAttempt(seq) && desktop.state !== "prepared") {
          if (desktop.state === "failed") {
            throw new DesktopFlowError(t("云电脑启动失败"), false);
          }
          if (desktop.state === "paused") {
            throw new DesktopFlowError(t("云电脑已休眠，请点击重试"), false);
          }
          await waitForPoll(DESKTOP_POLL_INTERVAL_MS);
          if (!isCurrentAttempt(seq)) return;
          desktop = await repositories.bots.getDesktopResource(botId);
        }
        if (!isCurrentAttempt(seq)) return;
        clearTimeout(resourceTimer);
        resourceTimer = null;

        const lease = await repositories.bots.createDesktopViewer(botId);
        if (!isCurrentAttempt(seq)) {
          void repositories.bots.releaseDesktopViewer(botId, lease.attachmentId).catch(() => undefined);
          return;
        }
        attachmentRef.current = lease.attachmentId;
        const claim = await repositories.bots.claimDesktopViewer(botId, lease.attachmentId, lease.ticket);
        if (!isCurrentAttempt(seq)) return;
        // 先用物理身份和有效期校验租约，再拿它去换媒体。
        assertDesktopLease(claim, t);
        setAccess(claim.access);
        const bootstrap = await repositories.bots.getTerminalSession(botId);
        if (!isCurrentAttempt(seq)) return;

        const transport = await openDesktopTatSocket({
          bootstrap,
          tunnel: claim.tunnel,
          attach: { attachmentId: claim.attachmentId, ticket: lease.ticket },
        });
        if (!isCurrentAttempt(seq) || !containerRef.current) {
          transport.close();
          return;
        }
        transportRef.current = transport;
        channelRef.current = transport.channel;
        // 客户端在租约到期时主动重建连接，不必等待服务端断开通知；
        // 服务端桌面网关独立校验 grant TTL 并主动断开过期连接，不依赖客户端计时。
        const remaining = claim.expiresAt - Date.now();
        if (remaining <= 0) {
          throw new DesktopFlowError(t("云电脑观看租约已到期，请点击重试"), true);
        }
        leaseTimer = setTimeout(() => {
          failAttempt(seq, new DesktopFlowError(t("云电脑观看租约已到期，请点击重试"), true));
        }, remaining);
        handshakeTimer = setTimeout(() => {
          failAttempt(seq, new DesktopFlowError(t("云电脑连接中断，请点击重试"), true));
        }, DESKTOP_RFB_HANDSHAKE_TIMEOUT_MS);

        const [{ default: RFB }] = await Promise.all([
          // noVNC npm 包只发布 lib/（core/ 是源码仓路径）。
          import("@novnc/novnc/lib/rfb"),
        ]);
        if (!isCurrentAttempt(seq) || !containerRef.current) return;

        // 不再传 credentials：可写端点无密码，隧道本身已鉴权。
        const rfb = new RFB(containerRef.current, transport.channel as unknown as WebSocket, {});
        rfb.addEventListener("connect", () => {
          if (!isCurrentAttempt(seq)) return;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          reconnectAttempts = 0;
          setReconnectAttempt(0);
          setPhase("connected");
          startHeartbeat();
          startWsKeepalive();
        });
        rfb.addEventListener("disconnect", (event) => {
          failAttempt(seq, new DesktopFlowError(
            event.detail?.clean
              ? t("云电脑连接已断开")
              : t("云电脑连接中断，请点击重试"),
            true,
          ));
        });
        rfb.addEventListener("securityfailure", () => {
          failAttempt(seq, new DesktopFlowError(t("云电脑目标校验失败"), false));
        });
        rfb.addEventListener("credentialsrequired", () => {
          failAttempt(seq, new DesktopFlowError(t("云电脑目标校验失败"), false));
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        // RFB FramebufferUpdateRequest（类型 3，incremental=1，1×1）：10 字节，
        // 通过 noVNC 底层原生 WebSocket 直接发送，完全不产生键盘/鼠标事件。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawWs: WebSocket | undefined = (rfb as any)?._sock?._websocket;
        const rfbLike: RFBLike = {
          sendFramebufferUpdateRequest: () => {
            // 优先写 TAT 隧道通道；TAT 链路同样需要周期性流量避免被判空闲。
            if (channelRef.current?.readyState === WebSocket.OPEN) {
              // type=3, incremental=1, x=0,y=0, w=1,h=1
              channelRef.current.send(new Uint8Array([3, 1, 0, 0, 0, 0, 0, 1, 0, 1]));
            } else if (rawWs?.readyState === WebSocket.OPEN) {
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
        // 不在这里定终态：交给 attempt 统一分类——可重试的走自动重连，语义失败与
        // 安全校验失败才落到 failed。
        if (cancelled || seq !== attemptSeq) return;
        throw err;
      }
    };

    void attempt();
    return () => {
      cancelled = true;
      stopTimers();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
          : phase === "reconnecting"
            ? t("正在重新连接…")
            : phase === "connected"
            ? access === "read"
              ? `${t("云电脑已连接")} · ${t("当前为只读模式，键鼠暂不可用")}`
              : t("云电脑已连接")
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
              setReconnectAttempt(0);
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
            {/* 重连不能静默：让用户知道在自动重试、已试到第几次，而不是以为卡住了。 */}
            {phase === "reconnecting" && reconnectAttempt > 0 && (
              <p className="text-muted-foreground text-xs tabular-nums">
                {reconnectAttempt}/{DESKTOP_RECONNECT_MAX_ATTEMPTS}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

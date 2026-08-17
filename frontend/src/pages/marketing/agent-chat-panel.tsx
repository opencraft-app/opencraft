import { lazy, Suspense, useCallback, useRef, type ComponentProps } from "react";

import { useT } from "@/i18n/t";
import { DATONG_EVENTS, DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongEvent } from "@/observability/datong-tracker";
import { WorkbenchPromptAutoSender } from "./workbench-prompt-auto-sender";

// AgentChat carries side-effect CSS. Keep it out of the agents shell until the chat tab is actually rendered.
const LightVelaPanel = lazy(() =>
  import("@tencent/agentchat-lightvela-panel").then((module) => ({ default: module.LightVelaPanel })),
);

type AgentChatPanelProps = {
  accountId: string;
  commandExecutor: ComponentProps<typeof LightVelaPanel>["commandExecutor"];
  instanceId: string;
  launchToken: string | null;
  /** 首帧 token 的过期时刻（Unix 秒；后端未下发为 null），供面板按真实剩余寿命判断复用。 */
  launchTokenExpiresAt: number | null;
  launchTokenError: string | null;
  launchTokenStatus: "idle" | "loading" | "ready" | "error";
  onRetryLaunchToken: () => void;
  /** 拉取新 launch token（不写外层 state），由 SDK 续期机制调用。expiresAt 为 Unix 秒。 */
  onRefreshLaunchToken: () => Promise<{ token: string; expiresAt?: number }>;
};

/**
 * 续期缓冲：距真实过期还剩此值内就提前换新，否则复用缓存 token（不打后端）。
 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const AgentChatPanel = ({
  accountId,
  commandExecutor,
  instanceId,
  launchToken,
  launchTokenExpiresAt,
  launchTokenError,
  launchTokenStatus,
  onRetryLaunchToken,
  onRefreshLaunchToken,
}: AgentChatPanelProps) => {
  const t = useT();

  // 缓存当前 token、获取时刻及过期时刻（Unix 秒），供续期回调判断是否复用。
  // 初始化为 null / 0：真正的值在下方「首次锁定」块里写入，不依赖 mount 时的 prop 快照。
  const tokenRef = useRef<string | null>(null);
  const tokenFetchedAtRef = useRef<number>(0);
  const tokenExpiresAtRef = useRef<number | null>(null);

  type StableApiParams = { businessCode: string; token: string; timestamp: number };
  /**
   * 锁定首帧拿到的 lightvelaApiParams，引用永久稳定 → SDK 内部 socket 鉴权 useMemo
   * 不会因 token 续期被穿透重算（防重连的关键）。
   *
   * 触发器：`stableApiParamsRef.current === null`（即「尚未锁定过」）且当前有 ready
   * 的 token。**只在第一次满足时锁定一次**，之后永不重锁。
   *
   * 为什么不用「launchToken 字符串相对 ref 变化」作触发器：AgentChatPanel 是 lazy
   * 懒加载，去缓存刷新时页面首帧就已在 chat tab，token effect 早已跑完；等 chunk
   * 下载完组件首次 mount 时 launchToken 已是真 token，若用 `useRef(launchToken)`
   * 初始快照做对比会得到「相等」→ 误判为无变化 → 永不锁定 → LightVelaPanel 永不
   * 挂载（只剩空框）。改用「是否已锁定」判据即可规避该时序 race。
   *
   * 续期不写外层 state、launchToken prop 不变，本块条件天然不再成立 → 引用锁定。
   * retry 会先卸载重挂本组件，ref 全部重置为 null → 再次首帧锁定新 token。
   */
  const stableApiParamsRef = useRef<StableApiParams | null>(null);
  if (stableApiParamsRef.current === null && launchTokenStatus === "ready" && launchToken) {
    tokenRef.current = launchToken;
    tokenFetchedAtRef.current = Date.now();
    tokenExpiresAtRef.current = launchTokenExpiresAt;
    stableApiParamsRef.current = {
      businessCode: "lightvela",
      token: launchToken,
      // SDK 续期调度依赖 timestamp（秒）判断 token 是否将过期。
      timestamp: Math.floor(tokenFetchedAtRef.current / 1000),
    };
  }
  const stableApiParams = stableApiParamsRef.current;

  /**
   * SDK 检测到 token 将过期时调用本回调拿新值，内部自更新鉴权，不触发本组件重渲染。
   * 复用策略（对齐后端真实 TTL）：有 expiresAt 且剩余 > buffer 则复用，否则换新；
   * 无 expiresAt 时直接续期，顺带取回真实 expiresAt。
   */
  const refreshLightvelaApiParams = useCallback(async () => {
    const now = Date.now();
    const expiresAt = tokenExpiresAtRef.current;

    const canReuse =
      Boolean(tokenRef.current) &&
      typeof expiresAt === "number" &&
      expiresAt * 1000 - now > TOKEN_REFRESH_BUFFER_MS;

    if (canReuse && tokenRef.current) {
      return {
        businessCode: "lightvela",
        token: tokenRef.current,
        timestamp: Math.floor(tokenFetchedAtRef.current / 1000),
      };
    }

    const { token: newToken, expiresAt: newExpiresAt } = await onRefreshLaunchToken();
    tokenRef.current = newToken;
    tokenFetchedAtRef.current = Date.now();
    tokenExpiresAtRef.current = typeof newExpiresAt === "number" ? newExpiresAt : null;
    return {
      businessCode: "lightvela",
      token: newToken,
      timestamp: Math.floor(tokenFetchedAtRef.current / 1000),
    };
  }, [onRefreshLaunchToken]);

  /**
   * 桥接 AgentChat 内置上报到大同埋点：拦截发送消息事件，转发为大同的
   * `agent_message_send`（North Star 指标依赖），其余事件保持原样。
   */
  const handleReport = (eventId: string, data?: Record<string, unknown>) => {
    if (eventId === "send-message") {
      trackDatongEvent(DATONG_EVENTS.AGENT_MESSAGE_SEND, {
        pgid: DATONG_PAGE_IDS.AGENT_CHAT,
        params: {
          bot_id: instanceId,
          msg_len: typeof data?.msg_len === "number" ? data.msg_len : undefined,
          session_id: typeof data?.session_id === "string" ? data.session_id : undefined,
        },
      });
    }
  };

  return (
    <div className="h-[clamp(516px,calc(100vh-220px),960px)] overflow-hidden rounded-lg border border-black/[0.08] bg-white [&>*]:h-full">
      {(launchTokenStatus === "idle" || launchTokenStatus === "loading") && (
        <div className="flex h-full items-center justify-center p-6 text-sm text-black/60">
          {t("正在获取 AgentChat 启动 token…")}
        </div>
      )}
      {launchTokenStatus === "error" && (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm">
          <p className="text-red-500">
            {t("获取 AgentChat 启动 token 失败：{{message}}", { message: launchTokenError || t("未知错误") })}
          </p>
          <button
            type="button"
            onClick={onRetryLaunchToken}
            className="mt-3 inline-flex items-center rounded-md border border-black/[0.12] bg-white px-3 py-1.5 text-xs font-medium text-black/80 hover:bg-black/[0.04]"
          >
            {t("重试")}
          </button>
        </div>
      )}
      {launchTokenStatus === "ready" && launchToken && accountId && stableApiParams && (
        <Suspense
          fallback={(
            <div className="flex h-full items-center justify-center p-6 text-sm text-black/60">
              {t("正在加载 AgentChat…")}
            </div>
          )}
        >
          <LightVelaPanel
            instanceIds={[instanceId]}
            instanceId={instanceId}
            region="ap-guangzhou"
            userId={accountId}
            product="lightvela"
            lightvelaApiParams={stableApiParams}
            refreshLightvelaApiParams={refreshLightvelaApiParams}
            commandExecutor={commandExecutor}
            report={handleReport}
            features={{
              autoActivate: true,
              nativeWsGray: true,
            }}
          />
          {/* 工作台模板 → 对话自动发送：读取 pending prompt 后填入输入框并发送。 */}
          <WorkbenchPromptAutoSender />
        </Suspense>
      )}
    </div>
  );
};

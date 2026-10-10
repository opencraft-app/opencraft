/**
 * ConnectorsPanel — Agent「连接器」独立页（LightVela）。
 *
 * 架构对齐 AgentChat-web ConnectorCenter 模式：
 *   列表（三态数据模型）→ 9 态 UI 状态机（deriveConnectorUiState）→
 *   按状态路由操作（OAuth 授权 / local_cli 启用 / 解除 / 重试）→
 *   TAT 下发（enable/detach/complete 响应携带 tat → execDebugCommand
 *   执行到云端虾实例 → reportDelivery 回写服务端）。
 *
 * OAuth 双通道等待：postMessage（ai-server 回调页）+ 每 2s 轮询
 * completeOAuth 兜底 + 3 分钟超时 + cancel 关窗清理（AgentChat waitForOAuth 模式）。
 *
 * 红线：不持有/缓存任何凭据，只展示授权状态；token 只用于请求头。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

// 复用标准面板体系（通道/模型/技能同源）：弹窗蒙层、按钮、主题变量
import "./agent-config/styles-index.css";
import { message } from "./agent-config";
import { AgentSectionHeader } from "@/components/domain/agent-section-header";

import { fetchAgentChatLaunchToken } from "@/lib/agentchat-launch-token";
import { t } from "@/i18n/t";
import {
  cancelConnectorOAuth,
  checkBuiltinConnectorLocal,
  completeConnectorOAuth,
  CONNECTOR_OAUTH_COMPLETE_MESSAGE,
  detachBuiltinConnector,
  enableBuiltinConnector,
  listInstanceConnectors,
  normalizeInstanceConnectors,
  reportConnectorDelivery,
  startConnectorOAuth,
  type ConnectorEnableResponse,
  type InstanceBuiltinConnectorView,
  type InstanceConnectorsResponse,
  type OAuthCompletionResponse,
} from "@/lib/connectors-client";
import {
  executeConnectorTat,
  type ConnectorCommandExecutor,
  type ConnectorTatReport,
} from "@/lib/connector-tat";

// ─── 连接器卡片元信息（品牌图标 + 描述，按 connectorKey 本地映射） ───
// 图标与 AgentChat-web connectorIcons.ts 同源（官方品牌 SVG，data URL 内联）。

const CONNECTOR_LOGO: Record<string, string> = {
  "tencent-docs":
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjgiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyOCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMjEuOTMwMjQzNiw3LjMwODQzOTU3ZS0xNCBMNC41MjI5MzEwMyw3LjMwODQzOTU3ZS0xNCBDNC4yODI3ODE4Nyw3LjMwODQzOTU3ZS0xNCA0LjA3NzE5NzkyLDAuMTcxOTIwMzc5IDQuMDM1NTE2MzQsMC40MDc5NDQ3NTMgTDAuMDA3NjUyMzQ1MzIsMjMuMTkwNjYyMiBDLTAuMDQ1Nzc2ODg5OSwyMy40OTI5MzExIDAuMTg3MzY4ODY0LDIzLjc2OTk2NCAwLjQ5NTA2NzAzOCwyMy43Njk5NjQgTDEwLjA5MTA5MzIsMjMuNzY5OTY0IEwxMC44NTE1Mjc5LDIzLjUzNDcyODIgTDE1LjMwNzk1NTQsMjMuNTM0NzI4MiBMMTUuOTMwNjk0LDIzLjc2OTk2NCBMMjMuMzIyNzkyNSwyMy43Njk5NjQgQzIzLjU2Mjk0MTYsMjMuNzY5OTY0IDIzLjc2ODQxMjYsMjMuNTk3OTMwOSAyMy44MTAyMDcyLDIzLjM2MjEzMTkgTDI3LjEyMzE1ODYsNC42MjI0NzI1OCBMMjEuOTMwMjQzNiw3LjMwODQzOTU3ZS0xNCBaIiBmaWxsPSIjMkE2NUY1Ii8+PHBhdGggZD0iTTIxLjcwMjc5MSw0LjYyMjQ5NTExIEwyNy4xMjMyMDM4LDQuNjIyNDk1MTEgTDIxLjkzMDI4ODgsMi4yNTMyMTU5OGUtMDUgTDIxLjIxNTQ4OTIsNC4wNDMxOTMyOCBDMjEuMTYxOTQ3LDQuMzQ1NDYyMjEgMjEuMzk1MDkyOCw0LjYyMjQ5NTExIDIxLjcwMjc5MSw0LjYyMjQ5NTExIiBmaWxsPSIjMDBEQ0ZGIi8+PHBvbHlnb24gZmlsbD0iI0ZGRkZGRiIgcG9pbnRzPSIxNC4xMjQ2NjE2IDAuOTc1NjUzNzg1IDEzLjE1MDYyMjkgNi41MDA3NjQ2OSAzLjY1NDQ1MTggNi41MTcxMDA1IDcuNzgwMjUwNTcgMTAuOTY5NDU1MyAxMi4zNTkzNTA2IDEwLjk2OTQ1NTMgMTAuMDkxMTQ5NyAyMy43Njk5NzUyIDE1LjkzMDc1MDUgMjMuNzY5OTc1MiAxOC4yMDE1NDk1IDEwLjk2OTQ1NTMgMjUuMDk2NDA1OSAxMC45Njk0NTUzIDI1LjMzNTk5MDMgMTAuOTY0MTYwMiIvPjwvc3ZnPg==",
  "tencent-meeting":
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAzNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTEwLjkxMTEgMTUuMDgxNUwxNy4wMDg1IDIxLjI3MDhMMjMuMDgwOCAxNS4xMDc0TDI5LjE0MDIgMjEuMjU3M0wzMy4xMTI1IDE3LjIyNTRDMzQuMjg2IDE2LjAzNCAzNC4yODYgMTQuMTAyOSAzMy4xMTI1IDEyLjkxMTRMMjkuMTc4NiA4LjkxODE0TDIzLjA4MDggMi43MjkyNUwxMC45MTExIDE1LjA4MTVaIiBmaWxsPSJ1cmwoI3BhaW50MF9saW5lYXJfMTI3MF8yNTIpIi8+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00LjgxNDAyIDguOTE4MTRMMC44ODAxMTEgMTIuOTExNEMtMC4yOTMzNyAxNC4xMDI5IC0wLjI5MzM3IDE2LjAzNCAwLjg4MDExMSAxNy4yMjU0TDQuODM5ODQgMjEuMjQ0NkwxMC45MTE4IDE1LjA4MTVWMi43MjkyNUw0LjgxNDAyIDguOTE4MTRaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXJfMTI3MF8yNTIpIi8+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xMC45MTExIDE1LjA4MTVMMTYuOTk2IDguOTA1MzhMMTAuOTExMSAyLjcyOTI1VjE1LjA4MTVaIiBmaWxsPSJ1cmwoI3BhaW50Ml9saW5lYXJfMTI3MF8yNTIpIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJwYWludDBfbGluZWFyXzEyNzBfMjUyIiB4MT0iMzMuOTkyNiIgeTE9IjUuNTQyMjMiIHgyPSIxMC45MTExIiB5Mj0iNS41NDIyMyIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiMwNDk5RkQiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwMDRERkYiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQxX2xpbmVhcl8xMjcwXzI1MiIgeDE9IjMuNDcxMTkiIHkxPSIzNC41MTA0IiB4Mj0iMTYuMzQ2NyIgeTI9IjI1Ljc4NyIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiMwMDM4RkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMwNDVFRkQiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQyX2xpbmVhcl8xMjcwXzI1MiIgeDE9IjE1LjU5MzUiIHkxPSIxNS4wODEyIiB4Mj0iMTUuOTQwMiIgeTI9IjcuOTkzMjMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj48c3RvcCBzdG9wLWNvbG9yPSIjMDAwMEI4Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDQzQkZEIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PC9zdmc+",
};

const CONNECTOR_DESCRIPTION: Record<string, string> = {
  "tencent-meeting": t("创建会议并管理日程与参会信息"),
  "tencent-docs": t("创建、编辑和管理在线协作文档"),
};

/** 品牌图标：缺图时用名称首字 + 渐变底（AgentChat ConnectorProductIcon 同款兜底） */
function ConnectorLogo({ connectorKey, name }: { connectorKey: string; name: string }) {
  const logoUrl = CONNECTOR_LOGO[connectorKey];
  if (logoUrl) {
    return (
      <img
        className="h-9 w-9 shrink-0 rounded-[10px] object-contain"
        src={logoUrl}
        alt=""
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-[#1f6feb] to-[#20c5a5] text-sm font-bold text-white"
    >
      {name.slice(0, 1)}
    </span>
  );
}

// ─── UI 状态机（移植 AgentChat connectorUiState / deriveConnectorUiState） ───

export type ConnectorUiState =
  | "not_bound" // 未授权
  | "authorizing" // 授权进行中（含 OAuth 弹窗 / local_cli 登录中）
  | "installing" // 实例配置下发中
  | "ready" // 已授权（实例可用）
  | "auth_expired" // 授权已失效
  | "runtime_missing" // 实例配置异常（授权在，配置缺失）
  | "instance_unreachable" // 无法连接实例（P1 无 check-local，预留）
  | "detaching" // 解除中
  | "operation_failed"; // 下发失败

export interface ConnectorUiOperation {
  action?: string;
  active?: boolean;
  failed?: boolean;
}

function deriveConnectorUiState(
  item: InstanceBuiltinConnectorView,
  operation?: ConnectorUiOperation,
): ConnectorUiState {
  const action = operation?.action || item.operationAction || "";
  const operationActive = Boolean(operation?.active || item.operationId);

  if (operation?.active && action === "remove") return "detaching";
  if (operation?.active && action === "authorize") return "authorizing";
  if (operation?.active && action === "upsert") return "installing";

  const operationPending = item.deliverStatus === "pending" || item.deliverStatus === "none";
  if (operationPending && (item.bindingStatus === "detaching" || (operationActive && action === "remove"))) {
    return "detaching";
  }
  if (item.bindingStatus === "authorizing" || item.authStatus === "authorizing") {
    return "authorizing";
  }
  if (operationPending && (item.bindingStatus === "binding" || (operationActive && action === "upsert"))) {
    return "installing";
  }
  if (
    operation?.failed
    || item.bindingStatus === "error"
    || item.deliverStatus === "failed"
    || item.deliverStatus === "error"
  ) {
    return "operation_failed";
  }
  if (item.authStatus === "expired" || item.authStatus === "revoked") {
    return "auth_expired";
  }
  if (item.bindingStatus === "active" && item.deliverStatus === "none") {
    return "runtime_missing";
  }
  if (
    item.bindingStatus === "active"
    && (item.authStatus === "authorized" || item.authStatus === "not_required")
  ) {
    return "ready";
  }
  return "not_bound";
}

/** 状态文案（键走 t() 保证 i18n 提取；对齐 AgentChat stateText） */
function stateText(state: ConnectorUiState): string {
  switch (state) {
    case "not_bound": return t("尚未授权");
    case "authorizing": return t("等待完成授权");
    case "installing": return t("正在配置当前实例");
    case "ready": return t("已授权");
    case "auth_expired": return t("授权已失效");
    case "runtime_missing": return t("实例配置异常");
    case "instance_unreachable": return t("无法连接实例");
    case "detaching": return t("正在移除实例配置");
    case "operation_failed": return t("下发失败");
    default: return t("未知状态");
  }
}

/** 状态指示点颜色（对齐 AgentChat binding 色：ready 绿 / 进行中蓝 / 失败红） */
function stateDotClass(state: ConnectorUiState): string {
  switch (state) {
    case "ready": return "bg-[#35bd79]";
    case "authorizing":
    case "installing":
    case "detaching": return "bg-[#2563eb] animate-pulse";
    case "operation_failed": return "bg-[#e5484d]";
    case "auth_expired":
    case "runtime_missing": return "bg-amber-500";
    default: return "bg-[#b8bec8]";
  }
}

/** 状态文字颜色 */
function stateTextClass(state: ConnectorUiState): string {
  return state === "ready" ? "text-[#1f8f55]" : "text-[#8a9099]";
}

/** 操作按钮文案（对齐 AgentChat actionText / 主操作路由） */
function primaryActionCopy(state: ConnectorUiState): string {
  switch (state) {
    case "ready": return t("解除授权");
    case "authorizing": return t("授权中...");
    case "installing": return t("配置中...");
    case "detaching": return t("解除中…");
    case "auth_expired": return t("重新授权");
    // 失败态统一「重试」：先保授权重发配置（enableBuiltin）；授权已失效时
    // 服务端返回 auth_required，前端自动转重新授权——用户无需区分两种失败
    case "runtime_missing":
    case "operation_failed": return t("重试");
    default: return t("去授权");
  }
}

/** OAuth 型连接器（oauth / tencent_cloud_oauth）走 startOAuth 授权流 */
function isOAuthType(authType?: string): boolean {
  return authType === "oauth" || authType === "tencent_cloud_oauth";
}

// ─── 组件 ───

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * 弹窗关闭后 pending 状态的宽限窗口：授权成功时回调页会自动关闭，
 * postMessage 可能因此丢失、且服务端处理 OAuth 回调/绑定存在延迟——
 * 关窗 ≠ 授权失败。关窗后 pending 持续超过该窗口才判定未完成
 * （对齐 AgentChat：关窗后仍轮询 complete 至终态）。
 */
const OAUTH_CLOSED_PENDING_GRACE_MS = 10_000;
const LOCAL_CLI_AUTH_POLL_INTERVAL_MS = 3000;
const LOCAL_CLI_AUTH_MAX_POLL = 20;

/** OAuth 完成状态分类（对齐 AgentChat classifyOAuthPollingStatus） */
function classifyCompletion(status: string): "wait" | "done" | "abandoned" {
  if (status === "pending" || status === "binding") return "wait";
  if (status === "completed" || status === "active") return "done";
  return "abandoned"; // expired / cancelled / superseded
}

export function ConnectorsPanel({
  instanceId,
  execCommand,
}: {
  instanceId: string;
  /** 实例命令执行通道（execDebugCommand 包装）；P1 未提供时隐藏操作按钮 */
  execCommand?: ConnectorCommandExecutor;
}) {
  const [data, setData] = useState<InstanceConnectorsResponse>(() => ({ builtin: [], customMcp: [] }));
  const [itemsReady, setItemsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 提示交互对齐 AgentChat：过程状态全部由卡片承载（左下状态文字流转 +
   * 右下按钮 loading），仅错误走全局 toast（message.error），成功不弹
   * （卡片状态直接变化即反馈）。
   */
  /** 进行中操作（connectorKey → action），防重复点击 + 状态机输入 */
  const [busy, setBusy] = useState<Record<string, { action: string; active: boolean; failed?: boolean }>>({});

  const [launchToken, setLaunchToken] = useState<string | null>(null);
  const pendingFlowRef = useRef<{ connectorKey: string; flowId: string } | null>(null);
  const popupRef = useRef<Window | null>(null);
  const launchTokenRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    launchTokenRef.current = launchToken;
  }, [launchToken]);

  /** 拉取 launch token */
  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const { token } = await fetchAgentChatLaunchToken(instanceId);
      setLaunchToken(token);
      return token;
    } catch (err) {
      setLaunchToken(null);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [instanceId]);

  // 实例切换时丢弃旧 token
  useEffect(() => {
    setLaunchToken(null);
    launchTokenRef.current = null;
  }, [instanceId]);

  const refresh = useCallback(async () => {
    const token = launchTokenRef.current ?? (await fetchToken());
    if (!token) return;
    setError(null);
    try {
      setData(normalizeInstanceConnectors(await listInstanceConnectors(token, instanceId)));
      setItemsReady(true);
    } catch (err) {
      setData({ builtin: [], customMcp: [] });
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchToken, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 手动重试：全量重来（丢弃缓存 token，强制重新走完整链路） */
  const retry = useCallback(() => {
    setLaunchToken(null);
    launchTokenRef.current = null;
    void refresh();
  }, [refresh]);

  // busy 占用判断走 ref（同步可读）：setState updater 在 React 18+ 批处理下
  // 异步执行，不能用于「点击当下」的占用判断。
  const busyRef = useRef<Record<string, { action: string; active: boolean; failed?: boolean }>>({});

  const claimBusy = useCallback((key: string, action: string) => {
    // 仅「进行中」（active）不可抢占；失败态（active: false + failed: true）
    // 的残留 entry 允许覆盖，否则失败后按钮点击无效、恢复逻辑也会被阻塞。
    const existing = busyRef.current[key];
    if (existing && existing.active) return false;
    busyRef.current[key] = { action, active: true };
    setBusy({ ...busyRef.current });
    return true;
  }, []);

  const releaseBusy = useCallback((key: string, failed?: string) => {
    if (!busyRef.current[key]) return;
    if (failed) busyRef.current[key] = { action: busyRef.current[key].action, active: false, failed: true };
    else delete busyRef.current[key];
    setBusy({ ...busyRef.current });
  }, []);

  /**
   * 完成 TAT 下发（对齐 AgentChat finishOperation/executePlan）：
   * 响应携带 tat → execCommand 执行到实例 → reportDelivery 回写 → refresh。
   * 失败时尽力回写 failed 状态。
   */
  const finishOperation = useCallback(
    async (result: ConnectorEnableResponse): Promise<ConnectorTatReport | null> => {
      if (!result.tat || !result.installId || !result.installType) return null;
      if (!result.operationId || result.bindingVersion === undefined) {
        throw new Error(t("连接器下发计划缺少版本信息"));
      }
      if (!execCommand) {
        throw new Error(t("当前环境不支持实例配置下发，请稍后重试"));
      }
      let reported = false;
      try {
        const report = await executeConnectorTat(
          execCommand,
          result.tat,
          launchTokenRef.current ?? undefined,
        );
        await reportConnectorDelivery(launchTokenRef.current ?? "", {
          installId: result.installId,
          installType: result.installType,
          operationId: result.operationId,
          bindingVersion: result.bindingVersion,
          action: result.tat.action,
          status: report.status,
          tatTaskId: report.tatTaskId || undefined,
          error: report.status === "failed" ? report.message : undefined,
        });
        reported = true;
        if (report.status === "failed") {
          throw new Error(report.message || t("连接器配置下发失败"));
        }
        return report;
      } catch (err) {
        if (!reported && launchTokenRef.current) {
          void reportConnectorDelivery(launchTokenRef.current, {
            installId: result.installId,
            installType: result.installType,
            operationId: result.operationId,
            bindingVersion: result.bindingVersion,
            action: result.tat.action,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => undefined);
        }
        throw err;
      }
    },
    [execCommand],
  );

  /**
   * OAuth 等待：postMessage + 轮询 completeOAuth 双通道（对齐 AgentChat waitForOAuth）。
   * 关窗 ≠ 失败：授权成功时回调页自动关闭，postMessage 可能丢失——关窗后仍轮询
   * complete；binding（已授权、服务端绑定中）必须等到终态；pending 关窗后给宽限窗口。
   */
  const waitForOAuth = useCallback(
    (connectorKey: string, flowId: string, popup: Window | null): Promise<OAuthCompletionResponse> =>
      new Promise((resolve, reject) => {
        const token = launchTokenRef.current ?? "";
        const startedAt = Date.now();
        let settled = false;
        let completing = false;
        let lastStatus: string | null = null;
        let lastResult: OAuthCompletionResponse | null = null;
        let closedPendingSince: number | null = null;
        const cleanup = () => {
          window.removeEventListener("message", handleMessage);
          window.clearInterval(timer);
          window.clearInterval(closedWatcher);
          window.clearTimeout(hardDeadline);
        };
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const abandon = async (msg: string, keepServerFlow = false) => {
          if (settled) return;
          // keepServerFlow：flow 已进入绑定/下发阶段时保留服务端状态（cancel 无意义），
          // 后续由卡片上的「正在配置中」+ 挂载恢复逻辑接管。
          if (!keepServerFlow) await cancelConnectorOAuth(token, instanceId, connectorKey, flowId).catch(() => undefined);
          finish(() => reject(new Error(msg)));
        };
        const complete = async () => {
          if (completing || settled) return;
          completing = true;
          try {
            const result = await completeConnectorOAuth(token, instanceId, connectorKey, flowId);
            lastStatus = result.status;
            lastResult = result;
            const outcome = classifyCompletion(result.status);
            if (outcome === "wait") {
              // 关窗后的判定：binding = 已授权，继续轮询至终态；pending 给宽限窗口
              // （覆盖回调处理延迟），超窗才判定未完成。
              if (popup?.closed && result.status !== "binding") {
                const now = Date.now();
                if (closedPendingSince === null) closedPendingSince = now;
                if (now - closedPendingSince >= OAUTH_CLOSED_PENDING_GRACE_MS) {
                  await abandon(t("授权未完成，请重新授权"));
                }
              }
              return;
            }
            if (outcome === "abandoned") {
              await abandon(result.status === "superseded" ? t("本次授权已被更新的授权操作替代") : t("授权未完成，请重新授权"));
              return;
            }
            finish(() => resolve(result));
          } catch (err) {
            // 轮询期的网络/服务端错误：超时窗口内继续轮询
            if (Date.now() - startedAt >= OAUTH_TIMEOUT_MS) {
              finish(() => reject(err instanceof Error ? err : new Error(String(err))));
            }
          } finally {
            completing = false;
          }
        };
        function handleMessage(event: MessageEvent) {
          const base = process.env.NEXT_PUBLIC_AI_SERVER_BASE_URL?.trim();
          if (!base || event.origin !== new URL(base).origin) return;
          if (popup && event.source !== popup) return;
          const value = event.data as { type?: string; flowId?: string; connectorKey?: string };
          if (value?.type !== CONNECTOR_OAUTH_COMPLETE_MESSAGE || value.flowId !== flowId) return;
          void complete();
        }
        window.addEventListener("message", handleMessage);
        // 关窗实时检测：不等下个轮询 tick（2s）——500ms 高频探测 popup.closed，
        // 发现关窗立即触发一次 complete 确认服务端状态。若授权实际已成功
        // （用户授权后回调页自动关窗），complete 返回终态直接 resolve；
        // 若仍 pending，complete 内的关窗宽限逻辑（10s）接管判定未完成。
        // 浏览器无原生「弹窗被关闭」事件，轮询 closed 是唯一可靠手段。
        const closedWatcher = window.setInterval(() => {
          if (popup?.closed) void complete();
        }, 500);
        // 硬性 deadline 兜底：interval 轮询/abandon 内部都依赖 fetch（虽已加
        // 15s 超时，仍可能被极端环境拖住）——此处独立 setTimeout 强制 settle，
        // 保证 Promise 必然结束 → busy 必然释放，卡片不会永久卡在「授权中」。
        const hardDeadline = window.setTimeout(() => {
          finish(() => reject(new Error(t("授权等待超时，请重试"))));
        }, OAUTH_TIMEOUT_MS + 15_000);
        const timer = window.setInterval(() => {
          if (Date.now() - startedAt >= OAUTH_TIMEOUT_MS) {
            // 超时：已进入绑定/下发阶段（binding）= 授权已成功，保留 flow 不
            // cancel——resolve 最后一次 complete 响应走正常收尾（finishOperation
            // 缺 tat 时跳过 → refresh），卡片转「正在配置中」，不误报「请重新授权」
            if (lastStatus === "binding" && lastResult) {
              const completion = lastResult;
              finish(() => resolve(completion));
              return;
            }
            void abandon(t("授权等待超时，请重试"));
            return;
          }
          // 弹窗关闭也先走 complete 确认服务端状态（postMessage 可能因回调页
          // 立即关闭而丢失）；是否放弃由 complete 内的关窗宽限逻辑判定
          void complete();
        }, OAUTH_POLL_INTERVAL_MS);
      }),
    [instanceId, refresh],
  );

  /**
   * OAuth 型授权入口（对齐 AgentChat startAuthorization）：
   * startOAuth → 弹窗 → waitForOAuth → finishOperation（complete 响应含 TAT）。
   */
  const startAuthorization = useCallback(
    async (connectorKey: string) => {
      const busyKey = connectorKey;
      if (!claimBusy(busyKey, "authorize")) return;
      setError(null);
      // 预开窗：window.open 必须在用户手势的同步上下文内调用——await 两个网络
      // 请求（fetchToken/startOAuth）后浏览器 transient activation 已失效，
      // 弹窗会被拦截（时灵时不灵的原因）。先同步开 about:blank（必不被拦），
      // 拿到 authorizeUrl 再导航；失败路径关掉空白窗不残留。
      const popup = window.open("about:blank", "_blank");
      // popup 为 null：浏览器禁弹窗（拦截器/隐私模式）——降级当前页跳转，
      // 同页导航不受弹窗拦截约束；授权完成回来由挂载恢复逻辑接管 flow
      const fallbackToSameTab = popup === null;
      if (fallbackToSameTab) {
        message.info({ content: t("浏览器拦截了授权弹窗，将在当前页打开授权，完成后请返回本页"), duration: 6000 });
      }
      try {
        const token = launchTokenRef.current ?? (await fetchToken());
        if (!token) {
          popup?.close();
          return;
        }
        // 取消上一条未完成的 flow（双击/换连接器连点）
        const previous = pendingFlowRef.current;
        if (previous) {
          void cancelConnectorOAuth(token, instanceId, previous.connectorKey, previous.flowId).catch(() => undefined);
        }
        const flow = await startConnectorOAuth(token, instanceId, connectorKey, window.location.href);
        pendingFlowRef.current = { connectorKey, flowId: flow.flowId };
        if (fallbackToSameTab) {
          // 弹窗被拦：当前页跳授权页。flow 已在服务端挂起，用户授权完成回
          // 到本页后由挂载恢复逻辑（pending 检测）接管，无需本地等待
          window.location.href = flow.authorizeUrl;
          return;
        }
        // about:blank 与本页同源可安全导航；closed 的窗导航无效，跳过不报错
        // （waitForOAuth 的关窗宽限逻辑会正确处理这种「关窗」场景）
        if (!popup.closed) popup.location.href = flow.authorizeUrl;
        popupRef.current = popup;
        const completion = await waitForOAuth(connectorKey, flow.flowId, popup);
        pendingFlowRef.current = null;
        popupRef.current = null;
        if (launchTokenRef.current) {
          await finishOperation(completion);
        }
        await refresh();
      } catch (err) {
        pendingFlowRef.current = null;
        // 已导航到授权页的弹窗保留（用户可能还停留在授权流程上）；
        // 仅未导航成功的 about:blank 空白窗关掉，不残留垃圾标签页
        if (popupRef.current !== popup) popup?.close();
        popupRef.current = null;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        message.error({ content: msg, duration: 4000 });
        releaseBusy(busyKey, msg);
        return;
      }
      releaseBusy(busyKey);
    },
    [claimBusy, fetchToken, finishOperation, instanceId, refresh, releaseBusy, waitForOAuth],
  );

  /**
   * 统一重试/启用入口（对齐 AgentChat retryPending）：
   * enableBuiltin（服务端按类型路由——local_cli 走 local_cli_enable TAT、
   * OAuth 型已授权则重发 MCP 配置）→ finishOperation →
   * local_cli 的 authUrl 走授权页轮询；OAuth 型返回 auth_required
   * （授权已失效）时自动转重新授权，用户无需区分。
   */
  const retryDelivery = useCallback(
    async (connectorKey: string) => {
      const busyKey = connectorKey;
      // busy action 用状态机语义名（upsert），deriveConnectorUiState 据此
      // 将卡片切到「正在配置当前实例」+ 按钮「配置中...」spinner。
      if (!claimBusy(busyKey, "upsert")) return;
      setError(null);
      // 预开窗：authUrl 要等 enable/finishOperation 网络响应才有，届时已脱离
      // 用户手势上下文（window.open 会被浏览器拦截）——先同步开 about:blank，
      // 有 authUrl 再导航，无 authUrl 或失败则关掉，不残留空白标签页
      const popup = window.open("about:blank", "_blank");
      // popup 为 null：浏览器禁弹窗——与 OAuth 入口同款降级策略（authUrl
      // 就绪后当前页跳转，提示用户授权完成后返回）
      const fallbackToSameTab = popup === null;
      let navigated = false;
      try {
        const token = launchTokenRef.current ?? (await fetchToken());
        if (!token) {
          popup?.close();
          return;
        }
        const result = await enableBuiltinConnector(token, instanceId, connectorKey);
        // OAuth 型授权已失效：enable 只会返回 auth_required（不带 TAT）——
        // 关掉预开窗、释放 busy 后自动转重新授权（startAuthorization 会重新
        // claimBusy 为 authorize），用户无需先手动「重新授权」
        if (result.status === "auth_required") {
          popup?.close();
          releaseBusy(busyKey);
          void startAuthorization(connectorKey);
          return;
        }
        const report = await finishOperation(result);
        if (report?.authUrl) {
          // 轮询期间卡片切到「等待完成授权」（busy action = authorize），
          // 对齐 AgentChat setBusyAction(busy, 'authorize')。
          setBusy((prev) => ({ ...prev, [busyKey]: { action: "authorize", active: true } }));
          busyRef.current[busyKey] = { action: "authorize", active: true };
          if (fallbackToSameTab) {
            message.info({ content: t("浏览器拦截了授权弹窗，将在当前页打开授权，完成后请返回本页"), duration: 6000 });
            window.location.href = report.authUrl;
            return;
          }
          if (!popup.closed) popup.location.href = report.authUrl;
          navigated = true;
          for (let attempt = 0; attempt < LOCAL_CLI_AUTH_MAX_POLL; attempt += 1) {
            await new Promise((r) => setTimeout(r, LOCAL_CLI_AUTH_POLL_INTERVAL_MS));
            if (!mountedRef.current) return;
            const checkResult = await checkBuiltinConnectorLocal(token, instanceId, connectorKey);
            const checkReport = await finishOperation(checkResult);
            if (checkReport?.status === "success") {
              break;
            }
          }
        } else {
          // enable 响应不带 authUrl（无需浏览器授权），关掉预开的空白窗
          popup?.close();
        }
        await refresh();
      } catch (err) {
        if (!navigated) popup?.close();
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        message.error({ content: msg, duration: 4000 });
        releaseBusy(busyKey, msg);
        return;
      }
      releaseBusy(busyKey);
    },
    [claimBusy, fetchToken, finishOperation, instanceId, refresh, releaseBusy, startAuthorization],
  );

  /** 解除授权（对齐 AgentChat detachBuiltin）：detach → finishOperation（TAT remove） */
  const detachConnector = useCallback(
    async (connectorKey: string) => {
      const busyKey = connectorKey;
      // busy action 用状态机语义名（remove）→ 卡片切「正在移除实例配置」+
      // 按钮「解除中...」spinner（弹窗已关，过程反馈全在卡片上）。
      if (!claimBusy(busyKey, "remove")) return;
      setError(null);
      try {
        const token = launchTokenRef.current ?? (await fetchToken());
        if (!token) return;
        const result = await detachBuiltinConnector(token, instanceId, connectorKey);
        await finishOperation(result);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        message.error({ content: msg, duration: 4000 });
        releaseBusy(busyKey, msg);
        return;
      }
      releaseBusy(busyKey);
    },
    [claimBusy, fetchToken, finishOperation, instanceId, refresh, releaseBusy],
  );

  /**
   * pending 操作自动恢复（AgentChat useInstanceConnectorActions 恢复模式）：
   * 列表发现 deliverStatus=pending 且有 operationId 的项（如 OAuth 完成
   * 但下发被中断——页面刷新/网络断开）时，自动重新下发：
   *   remove 型 → detach；其余 → enable（已授权的 OAuth 型直接返回 TAT 计划）。
   * busy claim 防重复；执行结果经 reportDelivery 回写，失败态不会循环。
   */
  const recoveringRef = useRef<string>("");
  useEffect(() => {
    if (!itemsReady || !launchToken || !execCommand) return;
    const pending = data.builtin.find(
      (item) => item.deliverStatus === "pending" && item.operationId,
    );
    if (!pending?.operationId) {
      recoveringRef.current = "";
      return;
    }
    const signature = `${pending.connectorKey}:${pending.operationId}`;
    if (recoveringRef.current === signature) return;
    recoveringRef.current = signature;
    const busyKey = pending.connectorKey;
    if (!claimBusy(busyKey, "upsert")) return;
    void (async () => {
      try {
        const isRemove = pending.operationAction === "remove" || pending.operationAction === "local_cli_logout";
        const result = isRemove
          ? await detachBuiltinConnector(launchToken, instanceId, pending.connectorKey)
          : await enableBuiltinConnector(launchToken, instanceId, pending.connectorKey);
        await finishOperation(result);
      } catch {
        // 恢复失败：reportDelivery 已回写 failed（finishOperation 内），
        // refresh 后状态会离开 pending；错误横幅不弹（后台恢复语义）
      } finally {
        releaseBusy(busyKey);
        await refresh();
      }
    })();
  }, [data.builtin, itemsReady, launchToken, execCommand, claimBusy, releaseBusy, finishOperation, instanceId, refresh]);

  /** 卸载时取消未完成 flow */
  useEffect(() => {
    return () => {
      const current = pendingFlowRef.current;
      if (current && launchTokenRef.current) {
        void cancelConnectorOAuth(launchTokenRef.current, instanceId, current.connectorKey, current.flowId).catch(
          () => undefined,
        );
      }
    };
  }, [instanceId]);

  /** 主操作路由（对齐 AgentChat handleOfficialPrimary）：失败态统一走重试 */
  const handlePrimary = (item: InstanceBuiltinConnectorView, state: ConnectorUiState) => {
    if (state === "ready") {
      setPendingDisconnect(item);
      return;
    }
    if (state === "operation_failed" || state === "runtime_missing") {
      void retryDelivery(item.connectorKey);
      return;
    }
    if (isOAuthType(item.authType)) {
      void startAuthorization(item.connectorKey);
      return;
    }
    void retryDelivery(item.connectorKey);
  };

  const [pendingDisconnect, setPendingDisconnect] = useState<InstanceBuiltinConnectorView | null>(null);

  /**
   * 确认解除：立即关闭弹窗（对齐 AgentChat confirmingAction 模式——确认
   * 后弹窗即关），解除过程由卡片状态承载（busy detach → 左下「正在移除
   * 实例配置」+ 右下按钮「解除中...」spinner）。防重复由 detachConnector
   * 内的 claimBusy 保证。
   */
  const confirmDisconnect = () => {
    const target = pendingDisconnect;
    if (!target) return;
    setPendingDisconnect(null);
    void detachConnector(target.connectorKey);
  };

  const busyItem = (key: string) => busy[key]?.active === true;
  const opFailed = (key: string) => busy[key]?.failed === true;

  return (
    <section aria-label={t("连接器")} className="space-y-4">
      <AgentSectionHeader
        title={t("连接器")}
        description={t("连接常用服务，扩展 Agent 能力边界，帮你完成更多任务")}
      />

      {error && (
        <div
          role="alert"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <span className="text-pretty">{error}</span>
          <button
            type="button"
            onClick={retry}
            className="font-medium underline underline-offset-2"
          >
            {t("重试")}
          </button>
        </div>
      )}

      {!itemsReady && !error ? (
        <p aria-busy="true" className="rounded-lg border border-black/[0.08] bg-white py-10 text-center text-sm text-black/45 shadow-[0_8px_24px_rgba(15,23,42,0.035)]">
          {t("加载中…")}
        </p>
      ) : data.builtin.length === 0 && !error ? (
        <p className="rounded-lg border border-black/[0.08] bg-white py-10 text-center text-sm text-black/45 shadow-[0_8px_24px_rgba(15,23,42,0.035)]">{t("暂无可用的连接器")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.builtin.map((item) => {
            const isBusy = busyItem(item.connectorKey);
            const failed = opFailed(item.connectorKey);
            const state = deriveConnectorUiState(item, failed
              ? { action: busy[item.connectorKey]?.action, active: false, failed: true }
              : isBusy
                ? { action: busy[item.connectorKey]?.action, active: true }
                : undefined);
            const description = CONNECTOR_DESCRIPTION[item.connectorKey];
            const accountName = item.account?.displayName || item.account?.externalUserIdMasked || "";
            const disabled = isBusy || ["installing", "detaching"].includes(state);
            return (
              <li
                key={item.connectorKey}
                data-connector-key={item.connectorKey}
                className="flex flex-col rounded-lg border border-black/[0.08] bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.035)]"
              >
                <div className="flex items-start gap-3">
                  <ConnectorLogo connectorKey={item.connectorKey} name={item.name} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[#20242a]">{item.name}</div>
                    <p className="mt-1 truncate text-xs text-[#646a73]">
                      {description ?? t("第三方业务连接器")}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex h-[34px] items-center justify-between gap-3 border-t border-[#edf0f4] pt-3">
                  <span
                    className={`flex min-w-0 items-center gap-[7px] text-xs ${stateTextClass(state)}`}
                    data-status={state}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-[7px] w-[7px] shrink-0 rounded-full ${stateDotClass(state)}`}
                    />
                    <span className="truncate">
                      {accountName && <span className="mr-2 text-[#606670]">{accountName}</span>}
                      {stateText(state)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handlePrimary(item, state)}
                      aria-busy={state === "detaching" || undefined}
                      className={`inline-flex items-center gap-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                        state === "ready" ? "text-[#e5484d]" : "text-[#2563eb]"
                      }`}
                    >
                      {(state === "authorizing" || state === "installing" || state === "detaching") && (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      )}
                      {primaryActionCopy(state)}
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 解除授权确认弹窗（与断开通道弹窗同款：lh-std-channel-panel__modal 体系） */}
      {pendingDisconnect && (
        <div
          className="lh-std-channel-panel__modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDisconnect(null);
          }}
        >
          <div className="lh-std-channel-panel__modal">
            <h3 className="lh-std-channel-panel__modal-title">{t("确认解除授权？")}</h3>
            <p className="lh-std-channel-panel__modal-desc">
              {t("确认解除「{{name}}」授权？解除后，当前实例下的所有 Bot 都将无法使用该连接器；重新连接无需再次授权。", {
                name: pendingDisconnect.name,
              })}
            </p>
            <div className="lh-std-channel-panel__modal-actions">
              <button
                type="button"
                className="lh-std-channel-panel__btn-outline"
                onClick={() => setPendingDisconnect(null)}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                className="lh-std-channel-panel__btn-primary lh-std-channel-panel__btn-danger"
                onClick={confirmDisconnect}
              >
                {t("确认解除")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default ConnectorsPanel;

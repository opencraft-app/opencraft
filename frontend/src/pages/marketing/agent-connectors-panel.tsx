/**
 * ConnectorsPanel — Agent 设置页「连接器」面板（LightVela P1）。
 *
 * 数据与授权全走 ai-server 连接器平台（契约见 connectors-client.ts）。
 * OAuth 握手：enable → auth_required 时新窗口打开授权页（保留 opener，
 * ai-server 回调页依赖 window.opener.postMessage 回执）→ 监听 message
 * （origin 严格校验 + flowId 匹配）→ complete → 刷新列表。
 * 兜底：弹窗关闭检测（用户取消）+ 面板重新可见时刷新。
 *
 * 红线：不持有/缓存任何凭据，只展示授权状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAgentChatLaunchToken } from "@/lib/agentchat-launch-token";
import { t } from "@/i18n/t";
import {
  cancelConnectorOAuth,
  completeConnectorOAuth,
  CONNECTOR_OAUTH_COMPLETE_MESSAGE,
  disableBuiltinConnector,
  enableBuiltinConnector,
  listInstanceConnectors,
  retryConnectorDelivery,
  type ConnectorItem,
  type ConnectorStatus,
} from "@/lib/connectors-client";

/**
 * 状态文案用 switch + 字面量 t()，确保 i18n-extract 能扫描到键
 * （对象常量里的值提取器扫不到，会导致非中文语种裸显中文）。
 */
function statusLabel(status: ConnectorStatus): string {
  switch (status) {
    case "not_connected":
      return t("未连接");
    case "connected":
      return t("已连接");
    case "expired":
      return t("已过期");
    case "failed":
      return t("连接失败");
    case "auth_required":
      return t("待授权");
    default:
      return t("未知状态");
  }
}

/** 进行中的授权流（新窗口已打开、等待 postMessage 回执） */
interface PendingFlow {
  connectorKey: string;
  flowId: string;
}

function aiServerOrigin(): string | null {
  const base = (
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AI_SERVER_BASE_URL : ""
  )?.trim();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export function ConnectorsPanel({ instanceId }: { instanceId: string }) {
  const [items, setItems] = useState<ConnectorItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingFlow, setPendingFlow] = useState<PendingFlow | null>(null);
  /** 进行中的 enable 请求对应的连接器 key（重复点击防护） */
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  /**
   * AgentChat 启动 token（launch_token，≠ 主站登录 token）：ai-server 用它
   * introspect 换 user_id。token 就绪前面板显示加载，失败显示重试。
   */
  const [launchToken, setLaunchToken] = useState<string | null>(null);
  // 卸载/回调里读最新 pendingFlow，避免闭包过期；渲染期不写 ref
  const pendingFlowRef = useRef<PendingFlow | null>(null);
  useEffect(() => {
    pendingFlowRef.current = pendingFlow;
  }, [pendingFlow]);
  /** 授权弹窗引用：关闭检测（用户取消授权）用 */
  const popupRef = useRef<Window | null>(null);
  /** 回调里读最新 launchToken（避免闭包过期） */
  const launchTokenRef = useRef<string | null>(null);
  useEffect(() => {
    launchTokenRef.current = launchToken;
  }, [launchToken]);

  /** 拉取 launch token（面板挂载 / 401 过期重试） */
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

  useEffect(() => {
    setLaunchToken(null);
    void fetchToken();
  }, [fetchToken]);

  const refresh = useCallback(async () => {
    const token = launchTokenRef.current ?? (await fetchToken());
    if (!token) return;
    setError(null);
    try {
      setItems(await listInstanceConnectors(token, instanceId));
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetchToken, instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (item: ConnectorItem) => {
      // 重复点击防护：同一连接器进行中直接忽略
      if (connectingKey) return;
      setError(null);
      setConnectingKey(item.key);
      try {
        const token = launchTokenRef.current ?? (await fetchToken());
        if (!token) return;
        const result = await enableBuiltinConnector(token, instanceId, item.key);
        if (result.status === "auth_required" && result.authorizationUrl && result.flowId) {
          // 取消上一个未完成 flow（双击/换连接器连点会开新流，旧流悬挂）
          const previous = pendingFlowRef.current;
          if (previous) {
            void cancelConnectorOAuth(launchTokenRef.current ?? "", instanceId, previous.connectorKey, previous.flowId).catch(
              () => {
                /* 旧 flow cancel 尽力而为 */
              },
            );
          }
          setPendingFlow({ connectorKey: item.key, flowId: result.flowId });
          // 不带 noopener：ai-server 回调页依赖 window.opener.postMessage 回执，
          // noopener 会置空 opener 导致握手失效。安全性由接收侧 origin 严格
          // 相等校验 + flowId 匹配保证（标准 OAuth popup 模式）。
          popupRef.current = window.open(result.authorizationUrl, "_blank");
        } else {
          // 直接成功（无需 OAuth），刷新列表
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnectingKey(null);
      }
    },
    [connectingKey, instanceId, refresh],
  );

  // 监听 ai-server 回调页的 postMessage 完成事件
  useEffect(() => {
    const expectedOrigin = aiServerOrigin();
    const handleMessage = (event: MessageEvent) => {
      // origin 必须是 ai-server 域名，否则忽略（防伪造）
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      const data = event.data as
        | { type?: string; flowId?: string; connectorKey?: string }
        | null;
      if (data?.type !== CONNECTOR_OAUTH_COMPLETE_MESSAGE) return;
      const current = pendingFlowRef.current;
      if (!current || data.flowId !== current.flowId) return;
      setPendingFlow(null);
      popupRef.current = null;
      void completeConnectorOAuth(launchTokenRef.current ?? "", instanceId, current.connectorKey, current.flowId)
        .catch(() => {
          /* complete 失败时列表刷新仍会反映真实状态 */
        })
        .finally(() => void refresh());
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [instanceId, refresh]);

  // 弹窗关闭检测：用户未完成授权直接关窗 → cancel 该 flow 并刷新
  // （postMessage 丢失时这也是兜底恢复路径）
  useEffect(() => {
    if (!pendingFlow) return;
    const timer = window.setInterval(() => {
      const popup = popupRef.current;
      if (popup && popup.closed) {
        const current = pendingFlowRef.current;
        popupRef.current = null;
        if (current && current.flowId === pendingFlow.flowId) {
          setPendingFlow(null);
          void cancelConnectorOAuth(launchTokenRef.current ?? "", instanceId, current.connectorKey, current.flowId)
            .catch(() => {
              /* cancel 尽力而为 */
            })
            .finally(() => void refresh());
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [instanceId, pendingFlow, refresh]);

  // 面板重新可见（用户从授权页切回）且存在 pendingFlow 时刷新：
  // 授权可能已在服务端完成但 postMessage 丢失，refresh 反映真实状态
  useEffect(() => {
    if (!pendingFlow) return;
    const handleVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("focus", handleVisible);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("focus", handleVisible);
    };
  }, [pendingFlow, refresh]);

  // 卸载时取消未完成的授权流（用户没完成授权就离开）
  useEffect(() => {
    return () => {
      const current = pendingFlowRef.current;
      if (current) {
        void cancelConnectorOAuth(launchTokenRef.current ?? "", instanceId, current.connectorKey, current.flowId).catch(
          () => {
            /* 离开页面时的 cancel 尽力而为 */
          },
        );
      }
    };
  }, [instanceId]);

  const connectLabel = useCallback((item: ConnectorItem) => {
    if (item.status === "expired" || item.status === "failed") return t("重新连接");
    return t("连接");
  }, []);

  /** 待确认断开的连接器（弹确认层，防误触） */
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectorItem | null>(null);

  const disconnect = useCallback(
    async (item: ConnectorItem) => {
      setError(null);
      try {
        await disableBuiltinConnector(launchTokenRef.current ?? "", instanceId, item.key);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [instanceId, refresh],
  );

  const retryDelivery = useCallback(
    async (item: ConnectorItem) => {
      setError(null);
      try {
        await retryConnectorDelivery(launchTokenRef.current ?? "", instanceId, item.key);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [instanceId, refresh],
  );

  return (
    <section aria-label={t("连接器")} className="lh-connectors-panel">
      <header>
        <h3>{t("连接器")}</h3>
        <p>{t("连接第三方服务，让你的 Agent 直接调用")}</p>
      </header>
      {error && (
        <div role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            {t("重试")}
          </button>
        </div>
      )}
      {items === null ? (
        <p aria-busy="true">{t("加载中…")}</p>
      ) : items.length === 0 && !error ? (
        <p>{t("暂无可用的连接器")}</p>
      ) : (
        <ul>
          {items.map((item) => {
            const busy = connectingKey === item.key;
            return (
              <li key={item.key} data-connector-key={item.key}>
                <span>{item.name}</span>
                <span>{item.connectorType === "local_cli" ? "CLI" : "MCP"}</span>
                <span data-status={item.status}>{statusLabel(item.status)}</span>
                {item.deliveryWarning && (
                  <span>{t("已授权，等待 Agent 在线后同步")}</span>
                )}
                {(item.status === "not_connected" ||
                  item.status === "expired" ||
                  item.status === "failed") && (
                  <button type="button" disabled={busy} onClick={() => void connect(item)}>
                    {busy ? t("连接中…") : t(connectLabel(item))}
                  </button>
                )}
                {item.status === "connected" && (
                  <button
                    type="button"
                    onClick={() => setPendingDisconnect(item)}
                    aria-label={t("断开")}
                  >
                    {t("断开")}
                  </button>
                )}
                {item.status === "connected" && item.deliveryWarning && (
                  <button type="button" onClick={() => void retryDelivery(item)}>
                    {t("重试同步")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pendingDisconnect && (
        <div role="dialog" aria-label={t("确认断开连接")}>
          <p>
            {t("断开后 Agent 将无法调用 {{name}}，可随时重新连接。", {
              name: pendingDisconnect.name,
            })}
          </p>
          <button type="button" onClick={() => setPendingDisconnect(null)}>
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={() => {
              const target = pendingDisconnect;
              setPendingDisconnect(null);
              void disconnect(target);
            }}
          >
            {t("确认断开")}
          </button>
        </div>
      )}
    </section>
  );
}

export default ConnectorsPanel;

/**
 * ConnectorsPanel — Agent 设置页「连接器」面板（LightVela P1）。
 *
 * 数据与授权全走 ai-server 连接器平台（契约见 connectors-client.ts）。
 * OAuth 握手：enable → auth_required 时新窗口打开授权页 → 监听回调页
 * postMessage（origin 校验）→ complete → 刷新列表。
 *
 * 红线：不持有/缓存任何凭据，只展示授权状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "@/i18n/t";
import {
  cancelConnectorOAuth,
  completeConnectorOAuth,
  CONNECTOR_OAUTH_COMPLETE_MESSAGE,
  enableBuiltinConnector,
  listInstanceConnectors,
  type ConnectorItem,
} from "@/lib/connectors-client";

const STATUS_LABELS: Record<string, string> = {
  not_connected: "未连接",
  connected: "已连接",
  expired: "已过期",
  failed: "连接失败",
  auth_required: "待授权",
};

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
  // 卸载时用最新 pendingFlow 做 cancel，避免闭包过期
  const pendingFlowRef = useRef<PendingFlow | null>(null);
  pendingFlowRef.current = pendingFlow;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setItems(await listInstanceConnectors(instanceId));
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [instanceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (item: ConnectorItem) => {
      setError(null);
      try {
        const result = await enableBuiltinConnector(instanceId, item.key);
        if (result.status === "auth_required" && result.authorizationUrl && result.flowId) {
          setPendingFlow({ connectorKey: item.key, flowId: result.flowId });
          window.open(result.authorizationUrl, "_blank", "noopener");
        } else {
          // 直接成功（无需 OAuth），刷新列表
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [instanceId, refresh],
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
      void completeConnectorOAuth(instanceId, current.connectorKey, current.flowId)
        .catch(() => {
          /* complete 失败时列表刷新仍会反映真实状态 */
        })
        .finally(() => void refresh());
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [instanceId, refresh]);

  // 卸载时取消未完成的授权流（用户没完成授权就离开）
  useEffect(() => {
    return () => {
      const current = pendingFlowRef.current;
      if (current) {
        void cancelConnectorOAuth(instanceId, current.connectorKey, current.flowId).catch(
          () => {
            /* 离开页面时的 cancel 尽力而为 */
          },
        );
      }
    };
  }, [instanceId]);

  const connectLabel = useCallback((item: ConnectorItem) => {
    if (item.status === "expired" || item.status === "failed") return "重新连接";
    return "连接";
  }, []);

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
          {items.map((item) => (
            <li key={item.key} data-connector-key={item.key}>
              <span>{item.name}</span>
              <span>{item.connectorType === "local_cli" ? "CLI" : "MCP"}</span>
              <span data-status={item.status}>
                {t(STATUS_LABELS[item.status] ?? item.status)}
              </span>
              {item.deliveryWarning && (
                <span>{t("已授权，等待 Agent 在线后同步")}</span>
              )}
              {(item.status === "not_connected" ||
                item.status === "expired" ||
                item.status === "failed") && (
                <button type="button" onClick={() => void connect(item)}>
                  {t(connectLabel(item))}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ConnectorsPanel;

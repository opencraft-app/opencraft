/**
 * ConnectorsPanel — Agent 设置页「连接器」面板（LightVela P1）。
 *
 * 数据与授权全走 ai-server 连接器平台（契约见 connectors-client.ts）。
 * 红线：不持有/缓存任何凭据，只展示授权状态。
 */

import { useCallback, useEffect, useState } from "react";

import { t } from "@/i18n/t";
import { listInstanceConnectors, type ConnectorItem } from "@/lib/connectors-client";

const STATUS_LABELS: Record<string, string> = {
  not_connected: "未连接",
  connected: "已连接",
  expired: "已过期",
  failed: "连接失败",
  auth_required: "待授权",
};

export function ConnectorsPanel({ instanceId }: { instanceId: string }) {
  const [items, setItems] = useState<ConnectorItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              {/* 连接/断开操作在后续任务注入 */}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ConnectorsPanel;

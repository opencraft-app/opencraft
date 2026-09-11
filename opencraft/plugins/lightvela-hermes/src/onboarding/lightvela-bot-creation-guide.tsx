import { Bot, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";

import { SettingsActions, SettingsButton } from "@opencraft/extension-react";

export interface LightVelaBotCreationGuideProps {
  readonly createUrl: string;
  readonly onRefresh: () => Promise<unknown>;
}

/** DOM adapter for the shared first-Bot state. Host/AppServer ownership stays outside this view. */
export function LightVelaBotCreationGuide({
  createUrl,
  onRefresh,
}: LightVelaBotCreationGuideProps) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  useEffect(() => {
    const refreshAfterReturn = () => { void refresh().catch(() => undefined); };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshAfterReturn();
    };
    window.addEventListener("focus", refreshAfterReturn);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshAfterReturn);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const createBot = () => {
    const created = window.open(createUrl, "_blank", "noopener,noreferrer");
    if (created === null) window.location.assign(createUrl);
  };

  return (
    <section className="hostless-empty-view lightvela-bot-creation-guide" aria-live="polite">
      <span className="hostless-empty-view__icon" aria-hidden="true"><Bot size={20} /></span>
      <h1>即刻创建你的云端智能体伙伴</h1>
      <p>创建完成后返回此页，我们会自动连接你的 Hermes Bot。</p>
      <SettingsActions align="start" className="hostless-empty-view__actions">
        <SettingsButton
          className="lightvela-bot-creation-guide__primary"
          variant="primary"
          type="button"
          onClick={createBot}
        >
          新建 Bot
        </SettingsButton>
        <SettingsButton disabled={refreshing} type="button" onClick={() => void refresh().catch(() => undefined)}>
          <RefreshCw size={15} /> {refreshing ? "正在检查…" : "我已创建"}
        </SettingsButton>
      </SettingsActions>
    </section>
  );
}

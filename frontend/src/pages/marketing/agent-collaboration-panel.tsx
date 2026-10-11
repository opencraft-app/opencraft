"use client";

import { useEffect, useMemo, useState } from "react";
import { createCollaborationScope, serializeCollaborationWorkspaceRoute } from "@lightvela/collaboration-web";
import "@lightvela/collaboration-web/styles.css";
import { useSession } from "@/contexts/session-context";
import { createCollaborationAccount } from "@/lib/collaboration-account";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import { useT } from "@/i18n/t";
import "./agent-collaboration-panel.css";

let previousShutdown: Promise<void> = Promise.resolve();

export function AgentCollaborationPanel() {
  const t = useT();
  const { session, authReady, isAuthenticated } = useSession();
  const accountId = session.user?.id;
  const apiBase = resolveConfiguredAuthApiBaseUrl();
  const token = readStoredAuthToken();
  const [current, setCurrent] = useState<{ key: string; scope: ReturnType<typeof createCollaborationScope> } | null>(null);
  const [resourceUri, setResourceUri] = useState(() => serializeCollaborationWorkspaceRoute({ kind: "home" }));
  const key = `${apiBase}:${accountId ?? "anonymous"}`;
  useEffect(() => {
    if (!authReady || !isAuthenticated || !accountId) return;
    const abort = new AbortController();
    const scope = createCollaborationScope(createCollaborationAccount(abort.signal), previousShutdown);
    setResourceUri(serializeCollaborationWorkspaceRoute({ kind: "home" }));
    setCurrent({ key, scope });
    return () => {
      abort.abort();
      previousShutdown = scope.dispose();
      void previousShutdown.catch(() => undefined);
    };
  }, [accountId, authReady, isAuthenticated, key, token]);
  const host = useMemo(() => ({
    replaceViewResource: (_viewId: string, next: string) => setResourceUri(next),
    pushViewResource: (_viewId: string, next: string) => setResourceUri(next),
  }), []);
  if (!authReady) return <p role="status">{t("正在加载…")}</p>;
  if (!isAuthenticated) return <p>{t("请先登录后使用协作聊天。")}</p>;
  if (!current || current.key !== key) return <p role="status">{t("正在加载…")}</p>;
  const Component = current.scope.Component;
  return <div className="lv-collaboration-lab"><Component key={key} activation={{ viewId: "collaboration-lab", resourceUri }} host={host} /></div>;
}

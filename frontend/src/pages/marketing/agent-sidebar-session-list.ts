import { useCallback, useState } from "react";

import type { LightVelaSession, LightVelaSessionState } from "./agent-chat-panel";

// Agents 子页面会重挂载；只缓存列表数据，操作句柄仍由当前页面的聊天实例提供。
const sessionsByBot = new Map<string, LightVelaSession[]>();

export function useAgentSidebarSessionList(botKey: string | null) {
  const [current, setCurrent] = useState(() => ({
    botKey,
    sessions: botKey ? sessionsByBot.get(botKey) ?? [] : [],
    loading: false,
  }));
  const cachedSessions = botKey ? sessionsByBot.get(botKey) ?? [] : [];
  const sessions = current.botKey === botKey ? current.sessions : cachedSessions;
  const loading = current.botKey === botKey && current.loading;

  const onSessionStateChange = useCallback((state: LightVelaSessionState) => {
    const previousSessions = botKey ? sessionsByBot.get(botKey) ?? [] : [];
    const nextSessions = state.loading && state.sessions.length === 0 && previousSessions.length > 0
      ? previousSessions
      : state.sessions;
    if (botKey && (!state.loading || state.sessions.length > 0)) {
      sessionsByBot.set(botKey, nextSessions);
    }
    setCurrent({ botKey, sessions: nextSessions, loading: state.loading });
  }, [botKey]);

  return { sessions, loading, onSessionStateChange };
}

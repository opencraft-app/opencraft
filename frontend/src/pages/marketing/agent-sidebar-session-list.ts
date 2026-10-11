import { useCallback, useEffect, useState } from "react";

import type { LightVelaSession, LightVelaSessionState } from "./agent-chat-panel";

// 控制台由 agents/layout 常驻，切换子页面不再重挂载；此缓存只兜底控制台整体重挂载（如切换 Bot、重新登录）。
// 只缓存列表数据，操作句柄仍由当前页面的聊天实例提供。
const sessionsByBot = new Map<string, LightVelaSession[]>();
const unreadStorageKey = (botKey: string) => `lightvela:agents:unread-sessions:${botKey}`;

const readUnreadSessionIds = (botKey: string | null): string[] => {
  if (!botKey || typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(unreadStorageKey(botKey));
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((id: unknown): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

export function useAgentSidebarUnreadSessions(botKey: string | null) {
  const [current, setCurrent] = useState<{ botKey: string | null; ids: string[] }>({ botKey: null, ids: [] });

  useEffect(() => {
    setCurrent({ botKey, ids: readUnreadSessionIds(botKey) });
  }, [botKey]);

  const setUnread = useCallback((chatId: string, unread: boolean) => {
    if (!botKey) return;
    const next = new Set(current.botKey === botKey ? current.ids : readUnreadSessionIds(botKey));
    if (unread) next.add(chatId);
    else next.delete(chatId);
    const ids = [...next];
    try {
      if (ids.length > 0) window.localStorage.setItem(unreadStorageKey(botKey), JSON.stringify(ids));
      else window.localStorage.removeItem(unreadStorageKey(botKey));
    } catch {
      // The marker still works for the current page when browser storage is unavailable.
    }
    setCurrent({ botKey, ids });
  }, [botKey, current]);

  return { unreadChatIds: current.botKey === botKey ? current.ids : [], setUnread };
}

export function resolveAgentSidebarEmptySessionState({
  botPaused,
  loading,
  botKey,
  sessionCount,
}: {
  botPaused: boolean;
  loading: boolean;
  botKey: string | null;
  sessionCount: number;
}): "loading" | "default" | null {
  if (sessionCount > 0 || botPaused) return null;
  return loading || botKey === null ? "loading" : "default";
}

export async function runBotScopedSessionPin(
  setPinned: () => Promise<void>,
  isCurrentBot: () => boolean,
  onError: () => void,
  onSettled: () => void,
): Promise<void> {
  try {
    await setPinned();
  } catch {
    if (isCurrentBot()) onError();
  } finally {
    if (isCurrentBot()) onSettled();
  }
}

export function useAgentSidebarSessionList(botKey: string | null) {
  const [current, setCurrent] = useState(() => ({
    botKey,
    sessions: botKey ? sessionsByBot.get(botKey) ?? [] : [],
    loading: botKey !== null && !sessionsByBot.has(botKey),
  }));
  const cachedSessions = botKey ? sessionsByBot.get(botKey) ?? [] : [];
  const sessions = current.botKey === botKey ? current.sessions : cachedSessions;
  const loading = current.botKey === botKey
    ? current.loading
    : botKey !== null && !sessionsByBot.has(botKey);

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

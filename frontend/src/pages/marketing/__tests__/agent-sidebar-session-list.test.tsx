import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { resolveAgentSidebarEmptySessionState, useAgentSidebarSessionList } from "@/pages/marketing/agent-sidebar-session-list";

const session = (chatId: string) => ({ chatId, title: chatId });
const state = (chatId: string | null, loading = false) => ({
  sessions: chatId === null ? [] : [session(chatId)],
  loading,
  historyLoading: false,
});

describe("Agents sidebar session list", () => {
  it("shows no empty-session placeholder while a Bot is paused and restores loading after resume", () => {
    const freshBot = { botKey: "account-paused:bot-a", sessionCount: 0, loading: true };

    expect(resolveAgentSidebarEmptySessionState({ ...freshBot, botPaused: true })).toBeNull();
    expect(resolveAgentSidebarEmptySessionState({ ...freshBot, botPaused: false })).toBe("loading");
    expect(resolveAgentSidebarEmptySessionState({ ...freshBot, loading: false, botPaused: false })).toBe("default");
    expect(resolveAgentSidebarEmptySessionState({ ...freshBot, sessionCount: 1, botPaused: true })).toBeNull();
  });

  it("shows loading immediately for a Bot without a confirmed list", () => {
    const view = renderHook(() => useAgentSidebarSessionList("account-fresh:bot-fresh"));
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.loading).toBe(true);

    act(() => view.result.current.onSessionStateChange(state(null, true)));
    expect(view.result.current.loading).toBe(true);
    act(() => view.result.current.onSessionStateChange(state(null)));
    expect(view.result.current.loading).toBe(false);

    view.unmount();
    const remounted = renderHook(() => useAgentSidebarSessionList("account-fresh:bot-fresh"));
    expect(remounted.result.current.loading).toBe(false);
  });

  it("keeps the same Bot's list across page remounts and during a background reload", () => {
    const first = renderHook(() => useAgentSidebarSessionList("account-a:bot-a"));
    act(() => first.result.current.onSessionStateChange(state("chat-a")));
    first.unmount();

    const next = renderHook(() => useAgentSidebarSessionList("account-a:bot-a"));
    expect(next.result.current.sessions).toEqual([session("chat-a")]);
    expect(next.result.current.loading).toBe(false);

    act(() => next.result.current.onSessionStateChange(state(null, true)));
    expect(next.result.current.sessions).toEqual([session("chat-a")]);
    act(() => next.result.current.onSessionStateChange(state("chat-new")));
    expect(next.result.current.sessions).toEqual([session("chat-new")]);
  });

  it("isolates Bot and account lists, and clears a list when the server confirms it is empty", () => {
    const view = renderHook(({ botKey }) => useAgentSidebarSessionList(botKey), {
      initialProps: { botKey: "account-b:bot-a" },
    });
    act(() => view.result.current.onSessionStateChange(state("chat-a")));
    view.rerender({ botKey: "account-b:bot-b" });
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.loading).toBe(true);
    act(() => view.result.current.onSessionStateChange(state("chat-b")));

    view.rerender({ botKey: "account-b:bot-a" });
    expect(view.result.current.sessions).toEqual([session("chat-a")]);
    view.rerender({ botKey: "account-c:bot-a" });
    expect(view.result.current.sessions).toEqual([]);

    view.rerender({ botKey: "account-b:bot-b" });
    act(() => view.result.current.onSessionStateChange(state(null)));
    expect(view.result.current.sessions).toEqual([]);
    view.unmount();
    const remounted = renderHook(() => useAgentSidebarSessionList("account-b:bot-b"));
    expect(remounted.result.current.sessions).toEqual([]);
  });
});

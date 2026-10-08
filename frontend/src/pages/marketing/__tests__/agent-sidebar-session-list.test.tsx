import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveAgentSidebarEmptySessionState, runBotScopedSessionPin, useAgentSidebarSessionList, useAgentSidebarUnreadSessions } from "@/pages/marketing/agent-sidebar-session-list";

const session = (chatId: string) => ({ chatId, title: chatId });
const state = (chatId: string | null, loading = false) => ({
  sessions: chatId === null ? [] : [session(chatId)],
  loading,
  historyLoading: false,
});

describe("Agents sidebar session list", () => {
  it("ignores a failed pin request after switching Bot", async () => {
    let rejectPin: (reason: Error) => void = () => {};
    let currentBot = "bot-a";
    const pin = new Promise<void>((_resolve, reject) => { rejectPin = reject; });
    const onError = vi.fn();
    const onSettled = vi.fn();
    const pending = runBotScopedSessionPin(() => pin, () => currentBot === "bot-a", onError, onSettled);

    currentBot = "bot-b";
    rejectPin(new Error("pin failed"));
    await pending;

    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("shows pin errors and clears pending state for the current Bot", async () => {
    const onError = vi.fn();
    const onSettled = vi.fn();

    await runBotScopedSessionPin(async () => { throw new Error("pin failed"); }, () => true, onError, onSettled);

    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("persists unread markers per account and Bot until the conversation is opened", () => {
    window.localStorage.clear();
    const first = renderHook(({ botKey }) => useAgentSidebarUnreadSessions(botKey), {
      initialProps: { botKey: "account-unread-a:bot-a" },
    });

    act(() => first.result.current.setUnread("chat-a", true));
    act(() => first.result.current.setUnread("", true));
    expect(first.result.current.unreadChatIds).toEqual(["chat-a", ""]);
    first.unmount();

    const remounted = renderHook(({ botKey }) => useAgentSidebarUnreadSessions(botKey), {
      initialProps: { botKey: "account-unread-a:bot-a" },
    });
    expect(remounted.result.current.unreadChatIds).toEqual(["chat-a", ""]);
    remounted.rerender({ botKey: "account-unread-b:bot-a" });
    expect(remounted.result.current.unreadChatIds).toEqual([]);
    remounted.rerender({ botKey: "account-unread-a:bot-b" });
    expect(remounted.result.current.unreadChatIds).toEqual([]);
    remounted.rerender({ botKey: "account-unread-a:bot-a" });
    expect(remounted.result.current.unreadChatIds).toEqual(["chat-a", ""]);

    act(() => remounted.result.current.setUnread("chat-a", false));
    expect(remounted.result.current.unreadChatIds).toEqual([""]);
    remounted.unmount();
    window.localStorage.clear();
  });

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

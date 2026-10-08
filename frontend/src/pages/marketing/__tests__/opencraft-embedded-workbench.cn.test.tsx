import { savePendingWorkbenchPrompt, readPendingWorkbenchPrompt } from "../workbench-prompt-templates";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LightVelaMultiSessionOptions,
  LightVelaSessionActions,
} from "@/pages/marketing/agent-chat-panel";
import {
  AgentChatMigrationSurface,
  type EmbeddedSessionCommands,
} from "@/pages/marketing/opencraft-embedded-workbench";

import { writeStoredAuthToken } from "@/repositories/http-repositories";
import { installConsoleShowCommand, subscribeConsoleShow } from "@/lib/console-show-event";
import { useEffect, useState } from "react";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/region")>(),
  DEFAULT_LOCALE: "zh-CN", REGION: "cn", isCN: true, isGlobal: false,
}));

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("AgentChatMigrationSurface", () => {
  it("shows a loading surface after enablement until embedded show succeeds", async () => {
    let actions: LightVelaSessionActions | null = null;
    let commands: EmbeddedSessionCommands | null = null;
    const requireActions = (): LightVelaSessionActions => {
      if (actions === null) throw new Error("Embedded session actions are unavailable");
      return actions;
    };
    const requireCommands = (): EmbeddedSessionCommands => {
      if (commands === null) throw new Error("Embedded session commands are unavailable");
      return commands;
    };
    const onSessionStateChange = vi.fn();
    const onSelectedChatIdChange = vi.fn();
    const onOwnerChange = vi.fn();
    const onHasMoreSessionsChange = vi.fn();
    const onSessionMutationStateChange = vi.fn();
    const onTurnCompleted = vi.fn();
    let resolveShow!: () => void;
    const shown = new Promise<void>((resolve) => { resolveShow = resolve; });

    class FakeEmbeddedWorkbench extends HTMLElement {
      configure = vi.fn();
      setLocalization = vi.fn(async () => undefined);
      hide = vi.fn();
      dispose = vi.fn(async () => undefined);
      createConversation = vi.fn(async () => undefined);
      loadMoreConversations = vi.fn(async () => undefined);
      selectConversation = vi.fn();
      renameConversation = vi.fn(async () => undefined);
      deleteConversation = vi.fn(async () => undefined);
      async prepare() {
        this.dispatchEvent(new CustomEvent("opencraft-sessions", {
          detail: {
            sessions: [{ chatId: "thread-1", title: "First", createdAt: 1, updatedAt: 2 }],
            loading: false,
            hasMoreSessions: true,
            error: null,
            selectedChatId: "thread-1",
          },
        }));
      }
      async show() { await shown; }
      async reconnect() {}
    }
    if (!customElements.get("opencraft-embedded-workbench")) {
      customElements.define("opencraft-embedded-workbench", FakeEmbeddedWorkbench);
    }
    const multiSession: LightVelaMultiSessionOptions = {
      selectedChatId: undefined,
      onSessionStateChange,
      onSelectedChatIdChange,
      onSessionActionsChange: (next) => { actions = next; },
    };

    const renderSurface = (enabled: boolean, locale = "en-US", selectedChatId?: string, active = true) => (
      <AgentChatMigrationSurface
        active={active}
        accountId="account-1"
        enabled={enabled}
        instanceId="ins-1"
        locale={locale}
        profileId="sales-123"
        region="intl"
        legacy={<div>Legacy AgentChat</div>}
        multiSession={{ ...multiSession, selectedChatId }}
        onTurnCompleted={onTurnCompleted}
        onOwnerChange={onOwnerChange}
        onHasMoreSessionsChange={onHasMoreSessionsChange}
        onSessionCommandsChange={(next) => { commands = next; }}
        onSessionMutationStateChange={onSessionMutationStateChange}
      />
    );
    const { container, rerender, unmount } = render(renderSurface(false));

    expect(screen.getByText("Legacy AgentChat").parentElement).not.toHaveClass("invisible");
    expect(container.querySelector("opencraft-embedded-workbench")).toBeNull();
    expect(onOwnerChange).not.toHaveBeenCalledWith("opencraft");

    rerender(renderSurface(true));
    const prepared = await waitFor(() => {
      const candidate = container.querySelector("opencraft-embedded-workbench");
      expect(candidate).not.toBeNull();
      return candidate as FakeEmbeddedWorkbench;
    });
    expect(prepared.configure).toHaveBeenCalledWith({
      getSessionToken: expect.any(Function),
      accountId: "account-1",
      apiBase: undefined,
      instanceId: "ins-1",
      profileId: "sales-123",
      region: "intl",
      localization: { ideLocale: "en-US", localeSource: "IDE" },
    });
    expect(screen.queryByText("Legacy AgentChat")).toBeNull();
    expect(screen.getByRole("textbox", { name: "聊聊你的想法，或交给我一件事" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在连接…");
    expect(screen.getByRole("status")).not.toHaveTextContent("正在准备我们的对话");
    resolveShow();
    await waitFor(() => expect(onOwnerChange).toHaveBeenCalledWith("opencraft"));
    rerender(renderSurface(true, "ja-JP"));
    await waitFor(() => expect(prepared.setLocalization).toHaveBeenCalledWith({ ideLocale: "ja-JP", localeSource: "IDE" }));
    expect(container.querySelector("opencraft-embedded-workbench")).toBe(prepared);
    expect(screen.queryByText("Legacy AgentChat")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSessionStateChange).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [expect.objectContaining({ chatId: "thread-1" })],
      loading: false,
    }));
    expect(onSelectedChatIdChange).toHaveBeenCalledWith("thread-1");
    expect(onHasMoreSessionsChange).toHaveBeenCalledWith(true);
    rerender(renderSurface(true, "ja-JP", "thread-1"));
    act(() => prepared.dispatchEvent(new CustomEvent("opencraft-turn-completed", {
      detail: { chatId: "thread-1", turnId: "turn-1" },
    })));
    expect(onTurnCompleted).not.toHaveBeenCalled();
    rerender(renderSurface(true, "ja-JP", "thread-2"));
    act(() => prepared.dispatchEvent(new CustomEvent("opencraft-turn-completed", {
      detail: { chatId: "thread-1", turnId: "turn-2" },
    })));
    expect(onTurnCompleted).toHaveBeenCalledExactlyOnceWith("thread-1");
    rerender(renderSurface(true, "ja-JP", "thread-1", false));
    act(() => prepared.dispatchEvent(new CustomEvent("opencraft-turn-completed", {
      detail: { chatId: "thread-1", turnId: "turn-3" },
    })));
    expect(onTurnCompleted).toHaveBeenCalledTimes(2);
    rerender(renderSurface(true, "ja-JP", "thread-2"));
    const publishRunning = (running: boolean, loading = false) => {
      act(() => prepared.dispatchEvent(new CustomEvent("opencraft-sessions", {
        detail: {
          sessions: [
            { chatId: "thread-1", title: "Background", createdAt: 1, updatedAt: 2, running },
            { chatId: "thread-2", title: "Current", createdAt: 1, updatedAt: 2, running: false },
          ],
          loading, hasMoreSessions: false, error: null, selectedChatId: "thread-2",
        },
      })));
    };
    publishRunning(true);
    publishRunning(false, true);
    expect(onTurnCompleted).toHaveBeenCalledTimes(2);
    publishRunning(false);
    expect(onTurnCompleted).toHaveBeenCalledTimes(3);
    expect(onTurnCompleted).toHaveBeenLastCalledWith("thread-1");
    publishRunning(false);
    expect(onTurnCompleted).toHaveBeenCalledTimes(3);
    expect(actions).not.toBeNull();
    const embedded = container.querySelector("opencraft-embedded-workbench");
    expect(embedded).not.toBeNull();
    const surface = container.firstElementChild;
    expect(surface).toHaveClass("border-0", "rounded-none");
    for (const isDraft of [true, false]) {
      act(() => embedded!.dispatchEvent(new CustomEvent("opencraft-sessions", {
        detail: { sessions: [], loading: false, error: null, selectedChatId: null, isDraft },
      })));
      expect(surface).toHaveClass("border-0", "rounded-none");
    }
    expect(commands).not.toBeNull();
    await requireCommands().loadMoreSessions?.();
    expect((embedded as FakeEmbeddedWorkbench).loadMoreConversations).toHaveBeenCalledOnce();
    await requireCommands().createSession();
    expect((embedded as FakeEmbeddedWorkbench).createConversation).toHaveBeenCalledOnce();
    expect(onSessionMutationStateChange).toHaveBeenCalledWith({
      operation: "create", chatId: "", pending: true, error: null,
    });
    requireActions().renameSession("thread-1", "Renamed");
    expect(onSessionMutationStateChange).toHaveBeenCalledWith({
      operation: "rename", chatId: "thread-1", pending: true, error: null,
    });
    await waitFor(() => expect(onSessionMutationStateChange).toHaveBeenLastCalledWith(null));
    expect((embedded as FakeEmbeddedWorkbench).renameConversation).toHaveBeenCalledWith("thread-1", "Renamed");
    requireActions().deleteSession("thread-1");
    expect(onSessionMutationStateChange).toHaveBeenCalledWith({
      operation: "delete", chatId: "thread-1", pending: true, error: null,
    });
    await waitFor(() => expect(onSessionMutationStateChange).toHaveBeenLastCalledWith(null));
    expect((embedded as FakeEmbeddedWorkbench).deleteConversation).toHaveBeenCalledWith("thread-1");

    rerender(renderSurface(false));
    await waitFor(() => expect(container.querySelector("opencraft-embedded-workbench")).toBeNull());
    expect(screen.getByText("Legacy AgentChat").parentElement).not.toHaveClass("invisible");
    expect(onOwnerChange).toHaveBeenLastCalledWith("legacy");
    expect(actions).toBeNull();
    expect(commands).toBeNull();
    expect(onHasMoreSessionsChange).toHaveBeenLastCalledWith(false);

    rerender(renderSurface(true));
    const replacement = await waitFor(() => {
      const candidate = container.querySelector("opencraft-embedded-workbench");
      expect(candidate).not.toBeNull();
      return candidate as FakeEmbeddedWorkbench;
    });
    await waitFor(() => expect(onOwnerChange).toHaveBeenLastCalledWith("opencraft"));

    replacement.dispatchEvent(new CustomEvent("opencraft-error", {
      detail: { message: "connection lost" },
    }));
    await waitFor(() => expect(onOwnerChange).toHaveBeenLastCalledWith("opencraft"));
    expect(screen.queryByText("Legacy AgentChat")).toBeNull();
    expect(replacement.dispose).not.toHaveBeenCalled();
    expect(actions).not.toBeNull();
    expect(commands).not.toBeNull();

    unmount();
    expect(onOwnerChange).toHaveBeenLastCalledWith("legacy");
  });
  it("never mounts legacy on first entry with the gate already enabled", async () => {
    const legacyMounted = vi.fn();
    function Legacy() { legacyMounted(); return <div>Cold legacy chat</div>; }
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolveShow!: () => void;
    const pendingShow = new Promise<void>((resolve) => { resolveShow = resolve; });
    const show = vi.spyOn(ctor.prototype, "show").mockImplementation(() => pendingShow);
    const surface = (active: boolean) => <AgentChatMigrationSurface active={active} enabled
      instanceId="ins-1" profileId="main" region="cn" legacy={<Legacy />}
      multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    try {
      const { rerender } = render(surface(false));
      expect(legacyMounted).not.toHaveBeenCalled();
      rerender(surface(true));
      await waitFor(() => expect(show).toHaveBeenCalled());
      expect(screen.getByRole("status")).toHaveTextContent("正在连接…");
      expect(legacyMounted).not.toHaveBeenCalled();
      await act(async () => { resolveShow(); await pendingShow; });
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      rerender(surface(false));
      rerender(surface(true));
      expect(legacyMounted).not.toHaveBeenCalled();
    } finally { show.mockRestore(); }
  });

  it("switches with the real show command and retires credentials synchronously on session changes", async () => {
    writeStoredAuthToken("synthetic-first-session");
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      useEffect(() => {
        const release = installConsoleShowCommand();
        const unsubscribe = subscribeConsoleShow(setEnabled);
        return () => { unsubscribe(); release(); };
      }, []);
      return <AgentChatMigrationSurface active enabled={enabled} accountId="account-1"
        instanceId="ins-1" profileId="main" region="cn" legacy={<div>Legacy session</div>}
        multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    }
    const { container } = render(<Harness />);
    const show = () => (window as unknown as { show(): boolean }).show();
    expect(container.querySelector("opencraft-embedded-workbench")).toBeNull();
    act(() => { show(); });
    type Candidate = HTMLElement & { configure: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
    const initial = await waitFor(() => {
      const element = container.querySelector("opencraft-embedded-workbench") as Candidate;
      expect(element).not.toBeNull(); return element;
    });
    const getToken = initial.configure.mock.calls[0]![0].getSessionToken as () => string;
    expect(getToken()).toBe("synthetic-first-session");
    expect(initial.outerHTML).not.toContain("synthetic-first-session");
    act(() => { writeStoredAuthToken("synthetic-second-session"); });
    expect(() => getToken()).toThrow(/session changed/);
    expect(initial.dispose).toHaveBeenCalled();
    const replacement = await waitFor(() => {
      const element = container.querySelector("opencraft-embedded-workbench") as Candidate;
      expect(element).not.toBe(initial); expect(element).not.toBeNull(); return element;
    });
    const replacementToken = replacement.configure.mock.calls[0]![0].getSessionToken as () => string;
    expect(replacementToken()).toBe("synthetic-second-session");
    act(() => { show(); });
    await waitFor(() => expect(container.querySelector("opencraft-embedded-workbench")).toBeNull());
    expect(() => replacementToken()).toThrow(/session changed/);
    expect(screen.getByText("Legacy session")).toBeVisible();
  });

  it("preserves the canvas and unsent input through connection loss and manual retry", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolve!: () => void;
    const reconnect = vi.spyOn(ctor.prototype, "reconnect").mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const surface = (agentPaused: boolean) => <AgentChatMigrationSurface active enabled agentPaused={agentPaused} accountId="account-1"
      instanceId="ins-1" profileId="sales" region="cn" legacy={<div>Legacy</div>}
      multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    const { container, rerender } = render(surface(false));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const element = container.querySelector("opencraft-embedded-workbench")!;
    const input = document.createElement("textarea");
    input.value = "未发送的草稿";
    element.append(input);
    const connection = (phase: string, failureCode: string | null = null) => act(() => element.dispatchEvent(new CustomEvent("opencraft-connection", { detail: { phase, failureCode } })));
    connection("error");
    expect(screen.getByRole("status")).toHaveTextContent("连接暂时中断");
    rerender(surface(true));
    expect(screen.getByRole("status")).toHaveTextContent("Agent 已暂停运行");
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
    expect(reconnect).not.toHaveBeenCalled();
    rerender(surface(false));
    act(() => screen.getByRole("button", { name: "重新连接" }).click());
    expect(reconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在连接…" })).toBeDisabled();
    await act(async () => { resolve(); });
    connection("ready");
    expect(screen.queryByRole("status")).toBeNull();
    rerender(surface(true));
    expect(screen.getByRole("status")).toHaveTextContent("Agent 已暂停运行");
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
    rerender(surface(false));
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector("opencraft-embedded-workbench")).toBe(element);
    expect(input.value).toBe("未发送的草稿");
    expect(screen.queryByText("Legacy")).toBeNull();
    connection("error", "intervention:authentication-required");
    expect(screen.getByRole("status")).toHaveTextContent("登录已过期");
    reconnect.mockRestore();
  });

  it("does not show or adopt a late prepared instance after switching Bot", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolve!: () => void;
    const prepare = vi.spyOn(ctor.prototype, "prepare").mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const show = vi.spyOn(ctor.prototype, "show");
    const owner = vi.fn();
    const surface = (profileId: string) => <AgentChatMigrationSurface active enabled accountId="account-1"
      instanceId="ins-1" profileId={profileId} region="cn" legacy={<div>Legacy</div>} onOwnerChange={owner}
      multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    const { container, rerender } = render(surface("one"));
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    const previous = container.querySelector("opencraft-embedded-workbench")!;
    const resolvePrevious = resolve;
    // Deliver the deadline without waiting 30 seconds in the test.
    // The production timeout is verified separately with fake timers below.
    rerender(surface("two"));
    await waitFor(() => expect(container.querySelector("opencraft-embedded-workbench")).not.toBe(previous));
    await act(async () => { resolvePrevious(); });
    expect(show).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalledWith("opencraft");
    expect(screen.queryByText("Legacy")).toBeNull();
    show.mockRestore();
    prepare.mockRestore();
  });

  it("does not adopt a retired Bot when show resolves after switching", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolveShow!: () => void;
    const pendingShow = new Promise<void>(resolve => { resolveShow = resolve; });
    const prepare = vi.spyOn(ctor.prototype, "prepare")
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const show = vi.spyOn(ctor.prototype, "show").mockImplementationOnce(() => pendingShow);
    const owner = vi.fn();
    const surface = (profileId: string) => <AgentChatMigrationSurface active enabled accountId="account-1"
      instanceId="ins-1" profileId={profileId} region="cn" legacy={<div>Legacy</div>} onOwnerChange={owner}
      multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    try {
      const { container, rerender } = render(surface("one"));
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      const previous = container.querySelector("opencraft-embedded-workbench")!;
      rerender(surface("two"));
      await waitFor(() => expect(container.querySelector("opencraft-embedded-workbench")).not.toBe(previous));
      owner.mockClear();
      await act(async () => { resolveShow(); await pendingShow; });
      expect(owner).not.toHaveBeenCalledWith("opencraft");
      expect(screen.queryByText("Legacy")).toBeNull();
    } finally {
      show.mockRestore();
      prepare.mockRestore();
    }
  });

  it("does not prepare an embedded Bot without a profile", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    const prepare = vi.spyOn(ctor.prototype, "prepare");
    try {
      const { container } = render(<AgentChatMigrationSurface active enabled accountId="account-1"
        instanceId="ins-1" profileId="" region="cn" legacy={<div>Legacy</div>}
        multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);
      expect(container.querySelector("opencraft-embedded-workbench")).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("请检查 AI 伙伴状态后重试");
    } finally { prepare.mockRestore(); }
  });

  it("offers retry after a startup deadline without mounting legacy", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    const prepare = vi.spyOn(ctor.prototype, "prepare").mockImplementation(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      render(<AgentChatMigrationSurface active enabled instanceId="ins-1" profileId="main" region="cn"
        legacy={<div>Legacy</div>} multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(screen.getByRole("status")).toHaveTextContent("连接时间较长");
      expect(screen.getByRole("button", { name: "重新连接" })).toBeEnabled();
      expect(screen.queryByText("Legacy")).toBeNull();
    } finally { cleanup(); vi.useRealTimers(); prepare.mockRestore(); }
  });

  it.each(["prepare", "show"] as const)("does not adopt a failed startup after late %s and rebuilds on retry", async stage => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    const held = vi.spyOn(ctor.prototype, stage).mockImplementationOnce(() => pending);
    const show = stage === "show" ? held : vi.spyOn(ctor.prototype, "show");
    const reconnect = vi.spyOn(ctor.prototype, "reconnect");
    const owner = vi.fn();
    const commands = vi.fn();
    const { container } = render(<AgentChatMigrationSurface active enabled instanceId="ins-1" profileId="sales" region="cn"
      legacy={<div>Legacy</div>} onOwnerChange={owner} onSessionCommandsChange={commands}
      multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);
    await waitFor(() => expect(held).toHaveBeenCalledOnce());
    const previous = container.querySelector("opencraft-embedded-workbench")!;
    act(() => previous.dispatchEvent(new CustomEvent("opencraft-error")));
    expect(screen.getByRole("status")).toHaveTextContent("会话加载失败");
    await act(async () => { resolve(); await pending; });
    expect(owner).not.toHaveBeenCalledWith("opencraft");
    expect(commands).not.toHaveBeenCalledWith(expect.objectContaining({ createSession: expect.any(Function) }));
    if (stage === "prepare") expect(show).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "重新连接" }).click());
    await waitFor(() => expect(owner).toHaveBeenLastCalledWith("opencraft"));
    expect(container.querySelector("opencraft-embedded-workbench")).not.toBe(previous);
    expect(previous.isConnected).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    expect(screen.queryByText("Legacy")).toBeNull();
  });

  it("ignores late show completion and events from the previous Bot", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    const show = vi.spyOn(ctor.prototype, "show").mockImplementationOnce(() => pending);
    const owner = vi.fn();
    const sessions = vi.fn();
    const commands = vi.fn();
    const surface = (profileId: string) => <AgentChatMigrationSurface active enabled instanceId="ins-1" profileId={profileId} region="cn"
      legacy={<div>Legacy</div>} onOwnerChange={owner} onSessionCommandsChange={commands}
      multiSession={{ onSessionStateChange: sessions, onSelectedChatIdChange: vi.fn() }} />;
    const { container, rerender } = render(surface("one"));
    await waitFor(() => expect(show).toHaveBeenCalledOnce());
    const previous = container.querySelector("opencraft-embedded-workbench")!;
    rerender(surface("two"));
    await waitFor(() => expect(owner).toHaveBeenLastCalledWith("opencraft"));
    owner.mockClear(); sessions.mockClear(); commands.mockClear();
    await act(async () => {
      previous.dispatchEvent(new CustomEvent("opencraft-sessions", { detail: { sessions: [{ chatId: "stale" }], loading: false, selectedChatId: "stale" } }));
      previous.dispatchEvent(new CustomEvent("opencraft-connection", { detail: { phase: "error", failureCode: null } }));
      resolve(); await pending;
    });
    expect(owner).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(commands).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a missing non-default profile on the configuration error surface until corrected", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    const prepare = vi.spyOn(ctor.prototype, "prepare");
    const surface = (profileId: string) => <AgentChatMigrationSurface active enabled instanceId="ins-1" profileId={profileId} region="cn"
      legacy={<div>Legacy</div>} multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    const { container, rerender } = render(surface(""));
    expect(screen.getByRole("status")).toHaveTextContent("请检查 AI 伙伴状态后重试");
    expect(container.querySelector("opencraft-embedded-workbench")).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.queryByText("Legacy")).toBeNull();
    rerender(surface("sales"));
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("hands template text to the embedded owner only after cold readiness and consumes it once admitted", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    let resolveShow!: () => void;
    const shown = new Promise<void>(resolve => { resolveShow = resolve; });
    const show = vi.spyOn(ctor.prototype, "show").mockReturnValue(shown);
    const submitPrompt = vi.fn(() => true);
    Object.defineProperty(ctor.prototype, "submitPrompt", { value: submitPrompt, configurable: true });
    savePendingWorkbenchPrompt("profile");
    const pending = readPendingWorkbenchPrompt()!;
    const { container } = render(<AgentChatMigrationSurface active enabled instanceId="ins-1" profileId="sales-123" region="cn"
      legacy={<div>Legacy</div>} multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);
    await waitFor(() => expect(show).toHaveBeenCalled());
    const element = container.querySelector("opencraft-embedded-workbench")!;
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(readPendingWorkbenchPrompt()).toEqual(pending);
    await act(async () => { resolveShow(); await shown; });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledOnce());
    expect(submitPrompt).toHaveBeenCalledWith(`profile:${pending.createdAt}`, expect.stringContaining(pending.prompt));
    expect(readPendingWorkbenchPrompt()).toBeNull();
    act(() => element.dispatchEvent(new CustomEvent("opencraft-sessions", { detail: { sessions: [], loading: false, selectedChatId: null, isDraft: true } })));
    expect(submitPrompt).toHaveBeenCalledOnce();
    delete ctor.prototype.submitPrompt;
  });

  it("retains the pending template on failed admission and never sends while inactive", async () => {
    const ctor = customElements.get("opencraft-embedded-workbench")!;
    vi.spyOn(ctor.prototype, "show").mockResolvedValue(undefined);
    const submitPrompt = vi.fn(() => false);
    Object.defineProperty(ctor.prototype, "submitPrompt", { value: submitPrompt, configurable: true });
    savePendingWorkbenchPrompt("tool");
    const surface = (active: boolean) => <AgentChatMigrationSurface active={active} enabled instanceId="ins-1" profileId="sales-123" region="cn"
      legacy={<div>Legacy</div>} multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;
    const { container, rerender } = render(surface(true));
    await waitFor(() => expect(container.querySelector("opencraft-embedded-workbench")).not.toBeNull());
    const element = container.querySelector("opencraft-embedded-workbench")!;
    act(() => element.dispatchEvent(new CustomEvent("opencraft-connection", { detail: { phase: "ready", failureCode: null } })));
    await waitFor(() => expect(submitPrompt).toHaveBeenCalled());
    expect(readPendingWorkbenchPrompt()?.templateId).toBe("tool");
    submitPrompt.mockClear();
    rerender(surface(false));
    act(() => element.dispatchEvent(new CustomEvent("opencraft-sessions", { detail: { sessions: [], loading: false, selectedChatId: null, isDraft: true } })));
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(readPendingWorkbenchPrompt()?.templateId).toBe("tool");
    delete ctor.prototype.submitPrompt;
  });

  describe("composer placeholder", () => {
    const composer = () => screen.queryByRole("textbox", { name: "聊聊你的想法，或交给我一件事" }) as HTMLTextAreaElement | null;
    const setup = (admit: boolean | (() => boolean), selectedChatId?: string) => {
      const ctor = customElements.get("opencraft-embedded-workbench")!;
      let resolveShow!: () => void;
      const shown = new Promise<void>(resolve => { resolveShow = resolve; });
      const show = vi.spyOn(ctor.prototype, "show").mockImplementation(() => shown);
      const submitPrompt = vi.fn(typeof admit === "function" ? admit : () => admit);
      Object.defineProperty(ctor.prototype, "submitPrompt", { value: submitPrompt, configurable: true });
      render(<AgentChatMigrationSurface active enabled instanceId="ins-1" profileId="sales-123" region="cn"
        legacy={<div>Legacy</div>} multiSession={{ selectedChatId, onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />);
      return {
        show, submitPrompt,
        ready: () => act(async () => { resolveShow(); await shown; }),
        restore: () => { delete (ctor.prototype as { submitPrompt?: unknown }).submitPrompt; },
      };
    };

    it("accepts typing before readiness and hands the queued message over exactly once", async () => {
      const harness = setup(true);
      try {
        await waitFor(() => expect(harness.show).toHaveBeenCalled());
        const input = composer()!;
        expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
        fireEvent.change(input, { target: { value: "帮我写一份周报" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(screen.getByRole("status")).toHaveTextContent("连上后自动发送…");
        expect(input).toHaveAttribute("readonly");
        expect(harness.submitPrompt).not.toHaveBeenCalled();
        await harness.ready();
        await waitFor(() => expect(harness.submitPrompt).toHaveBeenCalledOnce());
        expect(harness.submitPrompt).toHaveBeenCalledWith(expect.stringMatching(/^placeholder:/), "帮我写一份周报");
        await waitFor(() => expect(composer()).toBeNull());
        expect(harness.submitPrompt).toHaveBeenCalledOnce();
      } finally { harness.restore(); }
    });

    it("keeps unsent text after adoption until the user sends it", async () => {
      const harness = setup(true);
      try {
        await waitFor(() => expect(harness.show).toHaveBeenCalled());
        fireEvent.change(composer()!, { target: { value: "还没写完" } });
        await harness.ready();
        expect(composer()).toHaveValue("还没写完");
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
        expect(harness.submitPrompt).not.toHaveBeenCalled();
        fireEvent.keyDown(composer()!, { key: "Enter", shiftKey: true });
        expect(harness.submitPrompt).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await waitFor(() => expect(harness.submitPrompt).toHaveBeenCalledWith(expect.any(String), "还没写完"));
        await waitFor(() => expect(composer()).toBeNull());
      } finally { harness.restore(); }
    });

    it("hides once the real composer is ready when nothing was typed", async () => {
      const harness = setup(true);
      try {
        await waitFor(() => expect(composer()).not.toBeNull());
        await harness.ready();
        await waitFor(() => expect(composer()).toBeNull());
        expect(harness.submitPrompt).not.toHaveBeenCalled();
      } finally { harness.restore(); }
    });

    it("retains the text and allows a retry when the embedded owner refuses admission", async () => {
      let admit = false;
      const harness = setup(() => admit);
      try {
        await waitFor(() => expect(harness.show).toHaveBeenCalled());
        fireEvent.change(composer()!, { target: { value: "你好" } });
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await harness.ready();
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("未能发送，请重试"));
        expect(composer()).toHaveValue("你好");
        expect(composer()).not.toHaveAttribute("readonly");
        admit = true;
        fireEvent.click(screen.getByRole("button", { name: "发送" }));
        await waitFor(() => expect(composer()).toBeNull());
        expect(harness.submitPrompt).toHaveBeenCalledTimes(2);
        expect(new Set(harness.submitPrompt.mock.calls.map(call => (call as unknown[])[0])).size).toBe(2);
      } finally { harness.restore(); }
    });

    it("keeps the loading state for an existing thread", async () => {
      const harness = setup(true, "thread-1");
      try {
        await waitFor(() => expect(harness.show).toHaveBeenCalled());
        expect(composer()).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("你的 AI 伙伴，马上就来");
      } finally { harness.restore(); }
    });
  });

});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LightVelaMultiSessionOptions,
  LightVelaSessionActions,
} from "@/pages/marketing/agent-chat-panel";
import {
  AgentChatMigrationSurface,
  type EmbeddedSessionCommands,
} from "@/pages/marketing/opencraft-embedded-workbench";

afterEach(cleanup);

describe("AgentChatMigrationSurface", () => {
  it("keeps legacy authoritative until rollout enablement and embedded show both succeed", async () => {
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
    const onSessionMutationStateChange = vi.fn();
    let resolveShow!: () => void;
    const shown = new Promise<void>((resolve) => { resolveShow = resolve; });

    class FakeEmbeddedWorkbench extends HTMLElement {
      configure = vi.fn();
      hide = vi.fn();
      dispose = vi.fn(async () => undefined);
      createConversation = vi.fn(async () => undefined);
      selectConversation = vi.fn();
      renameConversation = vi.fn(async () => undefined);
      deleteConversation = vi.fn(async () => undefined);
      async prepare() {
        this.dispatchEvent(new CustomEvent("opencraft-sessions", {
          detail: {
            sessions: [{ chatId: "thread-1", title: "First", createdAt: 1, updatedAt: 2 }],
            loading: false,
            error: null,
            selectedChatId: "thread-1",
          },
        }));
      }
      async show() { await shown; }
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

    const renderSurface = (enabled: boolean) => (
      <AgentChatMigrationSurface
        active
        accountId="account-1"
        enabled={enabled}
        instanceId="ins-1"
        profileId="sales-123"
        region="intl"
        legacy={<div>Legacy AgentChat</div>}
        multiSession={multiSession}
        onOwnerChange={onOwnerChange}
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
      accountId: "account-1",
      apiBase: undefined,
      instanceId: "ins-1",
      profileId: "sales-123",
      region: "intl",
    });
    expect(screen.getByText("Legacy AgentChat").parentElement).not.toHaveClass("invisible");
    resolveShow();
    await waitFor(() => expect(onOwnerChange).toHaveBeenCalledWith("opencraft"));
    expect(screen.queryByText("Legacy AgentChat")).toBeNull();
    expect(onSessionStateChange).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [expect.objectContaining({ chatId: "thread-1" })],
      loading: false,
    }));
    expect(onSelectedChatIdChange).toHaveBeenCalledWith("thread-1");
    expect(actions).not.toBeNull();
    const embedded = container.querySelector("opencraft-embedded-workbench");
    expect(embedded).not.toBeNull();
    expect(commands).not.toBeNull();
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
    await waitFor(() => expect(onOwnerChange).toHaveBeenLastCalledWith("legacy"));
    expect(screen.getByText("Legacy AgentChat").parentElement).not.toHaveClass("invisible");
    expect(actions).toBeNull();
    expect(commands).toBeNull();

    unmount();
    expect(onOwnerChange).toHaveBeenLastCalledWith("legacy");
  });
});

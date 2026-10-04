import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { LightVelaSessionActions } from "@/pages/marketing/agent-chat-panel";
import { AgentChatMigrationSurface } from "@/pages/marketing/opencraft-embedded-workbench";

afterEach(() => cleanup());

it("loads sidebar sessions and actions without opening the chat canvas", async () => {
  class FakeEmbeddedWorkbench extends HTMLElement {
    configure = vi.fn();
    hide = vi.fn();
    show = vi.fn(async () => undefined);
    dispose = vi.fn(async () => undefined);
    createConversation = vi.fn(async () => undefined);
    selectConversation = vi.fn();
    renameConversation = vi.fn(async () => undefined);
    deleteConversation = vi.fn(async () => undefined);
    async prepare() {
      this.dispatchEvent(new CustomEvent("opencraft-sessions", {
        detail: {
          sessions: [
            { chatId: "thread-1", title: "First", running: true },
            { chatId: "thread-2", title: "Second", running: false },
          ],
          loading: false,
          error: null,
          selectedChatId: "thread-1",
        },
      }));
    }
  }
  if (!customElements.get("opencraft-embedded-workbench")) {
    customElements.define("opencraft-embedded-workbench", FakeEmbeddedWorkbench);
  }

  const onSessionStateChange = vi.fn();
  const onSelectedChatIdChange = vi.fn();
  let actions: LightVelaSessionActions | null = null;
  const { container, unmount } = render(
    <AgentChatMigrationSurface
      active={false}
      preloadSessions
      accountId="account-1"
      enabled
      instanceId="ins-1"
      profileId="main"
      region="cn"
      legacy={<div>Legacy chat</div>}
      multiSession={{
        selectedChatId: undefined,
        onSessionStateChange,
        onSelectedChatIdChange,
        onSessionActionsChange: (next) => { actions = next; },
      }}
    />,
  );

  await waitFor(() => expect(onSessionStateChange).toHaveBeenCalledWith(expect.objectContaining({
    sessions: expect.arrayContaining([expect.objectContaining({ chatId: "thread-1", running: true })]),
  })));
  const element = container.querySelector("opencraft-embedded-workbench") as FakeEmbeddedWorkbench;
  expect(element).not.toBeNull();
  expect(element.hide).toHaveBeenCalled();
  expect(element.show).not.toHaveBeenCalled();
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(actions).not.toBeNull();
  element.dispatchEvent(new CustomEvent("opencraft-sessions", {
    detail: {
      sessions: [{ chatId: "thread-1", title: "First", running: false }],
      loading: false,
      error: null,
      selectedChatId: "thread-1",
    },
  }));
  await waitFor(() => expect(onSessionStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
    sessions: [expect.objectContaining({ chatId: "thread-1", running: false })],
  })));
  actions!.renameSession("thread-1", "Renamed");
  actions!.deleteSession("thread-1");
  await waitFor(() => {
    expect(element.renameConversation).toHaveBeenCalledWith("thread-1", "Renamed");
    expect(element.deleteConversation).toHaveBeenCalledWith("thread-1");
  });

  unmount();
  onSelectedChatIdChange.mockClear();
  const next = render(
    <AgentChatMigrationSurface
      active
      preloadSessions
      accountId="account-1"
      enabled
      instanceId="ins-1"
      profileId="main"
      region="cn"
      legacy={<div>Legacy chat</div>}
      multiSession={{
        selectedChatId: "thread-2",
        onSessionStateChange,
        onSelectedChatIdChange,
      }}
    />,
  );
  const selectedElement = await waitFor(() => {
    const candidate = next.container.querySelector("opencraft-embedded-workbench") as FakeEmbeddedWorkbench;
    expect(candidate?.selectConversation).toHaveBeenCalledWith("thread-2");
    return candidate;
  });
  expect(selectedElement.show).toHaveBeenCalled();
  expect(onSelectedChatIdChange).not.toHaveBeenCalledWith("thread-1");
});

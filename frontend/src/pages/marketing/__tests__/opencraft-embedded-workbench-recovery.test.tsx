import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentChatMigrationSurface } from "@/pages/marketing/opencraft-embedded-workbench";
import { markEmbeddedWorkbenchModuleReload } from "@/lib/opencraft-embedded-resources";

const moduleState = vi.hoisted(() => ({ load: vi.fn(), reload: vi.fn() }));
vi.mock("@/lib/opencraft-embedded-resources", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/opencraft-embedded-resources")>(),
  loadEmbeddedWorkbench: moduleState.load,
  reloadEmbeddedWorkbenchPage: moduleState.reload,
}));
vi.mock("@/lib/opencraft-embedded-connection", () => ({ useEmbeddedPhysicalConnectionPreparation: () => null }));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));

const surface = (active = true, preloadSessions = false) => <AgentChatMigrationSurface active={active} preloadSessions={preloadSessions}
  enabled instanceId="ins-1" profileId="main" region="cn"
  legacy={null} multiSession={{ onSessionStateChange: vi.fn(), onSelectedChatIdChange: vi.fn() }} />;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL", "/__opencraft/embedded-workbench.js");
  moduleState.load.mockReset().mockRejectedValue(new Error("module unavailable"));
  moduleState.reload.mockReset();
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllEnvs(); });

it("automatically reloads a failed module only once, then offers a manual page reload", async () => {
  const first = render(surface());
  await waitFor(() => expect(moduleState.reload).toHaveBeenCalledOnce());
  expect(screen.getByRole("status")).toHaveTextContent("对话加载失败");
  expect(screen.getByRole("button", { name: "重新加载对话" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

  first.unmount();
  render(surface());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("对话加载失败"));
  expect(moduleState.reload).toHaveBeenCalledOnce();
  act(() => screen.getByRole("button", { name: "重新加载对话" }).click());
  expect(moduleState.reload).toHaveBeenCalledTimes(2);
});

it("waits until chat is active before recovering a failed background preload", async () => {
  const view = render(surface(false, true));
  await act(async () => { await Promise.resolve(); });
  expect(moduleState.load).toHaveBeenCalledOnce();
  expect(moduleState.reload).not.toHaveBeenCalled();

  view.rerender(surface(true, true));
  await waitFor(() => expect(moduleState.reload).toHaveBeenCalledOnce());
});

it("does not reload a missing bundled module", async () => {
  vi.stubEnv("NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL", "bundled:opencraft");
  render(surface());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("对话加载失败"));
  expect(moduleState.reload).not.toHaveBeenCalled();
});

it("does not automatically reload when the module loaded but the application failed", async () => {
  expect(markEmbeddedWorkbenchModuleReload()).toBe(true);
  moduleState.load.mockResolvedValue(undefined);
  class BrokenWorkbench extends HTMLElement {
    configure() {}
    prepare() { return Promise.reject(new Error("application failed")); }
    show() { return Promise.resolve(); }
    hide() {}
    dispose() { return Promise.resolve(); }
    createConversation() { return Promise.resolve(); }
  }
  if (!customElements.get("opencraft-embedded-workbench")) {
    customElements.define("opencraft-embedded-workbench", BrokenWorkbench);
  }

  render(surface());
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("对话加载失败"));
  expect(moduleState.reload).not.toHaveBeenCalled();
  expect(markEmbeddedWorkbenchModuleReload()).toBe(true);
  expect(screen.getByRole("button", { name: "重新加载对话" })).toBeEnabled();
});

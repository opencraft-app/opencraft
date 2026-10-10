import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentChatMigrationSurface } from "../opencraft-embedded-workbench";
import { useEmbeddedWorkbenchResourcePreparation } from "@/lib/opencraft-embedded-resources";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("prepares code before Bot discovery, retries failure and shares one load/Application with the surface", async () => {
  vi.stubEnv("NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL", "/__opencraft/embedded-workbench.js");
  let applications = 0;
  const configured = vi.fn();
  class Embedded extends HTMLElement {
    constructor() { super(); applications += 1; }
    configure = configured;
    prepare = async () => {};
    show = async () => {};
    hide = () => {};
    dispose = async () => {};
    createConversation = async () => {};
  }
  function Page({ enabled, active, botReady }: { enabled: boolean; active: boolean; botReady: boolean }) {
    useEmbeddedWorkbenchResourcePreparation(enabled, active);
    return botReady ? <AgentChatMigrationSurface enabled={enabled} active={active}
      instanceId="confirmed-instance" profileId="confirmed-profile" region="cn"
      legacy={<div>Legacy</div>} multiSession={{ onSessionStateChange: () => {}, onSessionActionsChange: () => {}, onSelectedChatIdChange: () => {} }} /> : null;
  }
  const scripts = () => document.head.querySelectorAll<HTMLScriptElement>("script[data-opencraft-embedded-workbench]");
  const script = () => {
    const value = scripts()[0];
    if (!value) throw new Error("Resource load did not start");
    return value;
  };
  const { rerender, unmount } = render(<Page enabled={false} active botReady={false} />);
  expect(scripts()).toHaveLength(0);
  rerender(<Page enabled active={false} botReady={false} />);
  expect(scripts()).toHaveLength(0);
  rerender(<Page enabled active botReady={false} />);
  expect(scripts()).toHaveLength(1);
  expect(applications).toBe(0);
  script().dispatchEvent(new Event("error"));
  await waitFor(() => expect(scripts()).toHaveLength(0));
  rerender(<Page enabled active={false} botReady={false} />);
  rerender(<Page enabled active botReady={false} />);
  expect(scripts()).toHaveLength(1);
  rerender(<Page enabled active botReady />);
  expect(scripts()).toHaveLength(1);
  expect(applications).toBe(0);
  // A retired candidate must not adopt when the shared code load completes.
  rerender(<Page enabled={false} active botReady />);
  customElements.define("opencraft-embedded-workbench", Embedded);
  script().dispatchEvent(new Event("load"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(applications).toBe(0);
  rerender(<Page enabled active botReady />);
  await waitFor(() => expect(configured).toHaveBeenCalledWith(expect.objectContaining({
    instanceId: "confirmed-instance", profileId: "confirmed-profile",
  })));
  expect(applications).toBe(1);
  rerender(<Page enabled active={false} botReady />);
  rerender(<Page enabled active botReady />);
  expect(applications).toBe(1);
  unmount();
  for (const script of scripts()) script.remove();
});

import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createCloudDesktopWorkbenchPanelPlugin } from "../../plugins/cloud-desktop/src/index";
import { createLightVelaCloudDesktopAdapter, createLightVelaDesktopViewerPort } from "../../plugins/lightvela-platform/src/desktop";
import type { LightVelaAccountSnapshot } from "../../plugins/lightvela-platform/src/account/lightvela-account-service";
import { createRfbDesktopAdapter } from "../../plugins/cloud-desktop/src/rfb";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";

for (const [key, value] of Object.entries(buildCodexThemeCssProperties("light"))) {
  document.documentElement.style.setProperty(key, value);
}

// Synthetic product/control plane only. Real panel, Vela provider, adapter and
// noVNC decoder are used; this must never be imported by application bootstrap.
const target = { conversationId: "conversation:test", serverId: "server:test", environmentId: "environment:test", principalId: "account:test" };
const media = createRfbDesktopAdapter();
const account = {
  getSnapshot: () => ({ session: { status: "authenticated", epoch: 1 }, region: "cn", authGeneration: 1,
    credentialScope: "synthetic", details: { profile: { id: "account:test" } } }) as LightVelaAccountSnapshot,
  subscribe: () => () => {},
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (path === "/v1/instances/instance%3Atest/desktop/resource" && init?.method === "POST") {
      return { resource_id: "instance:test", generation_id: "prepare:test", state: "prepared" } as T;
    }
    const response = await fetch(path, init);
    if (!response.ok) throw new Error("Synthetic broker request failed");
    return (await response.json()).data as T;
  },
};
const viewer = createLightVelaDesktopViewerPort({ account, attachmentsPath: "/desktop/attachments",
  connectUrl: "wss://synthetic.invalid/desktop/connect",
  // Test-only transport boundary: production requires WSS. No real credentials.
  openSocket: () => new WebSocket(`${location.origin.replace("http:", "ws:")}/desktop/connect`) });
const adapter = createLightVelaCloudDesktopAdapter({
  media: {
    async connect(session, signal) {
      try { return await media.connect(session, signal); }
      catch (error) { console.error("Synthetic desktop connect failed", String(error)); throw error; }
    },
    surfaces: { mount(element, connection) {
      try { return media.surfaces.mount(element, connection); }
      catch (error) { console.error("Synthetic desktop mount failed", String(error)); throw error; }
    } },
  },
  account,
  directory: {
    resolve: id => id === target.conversationId ? { target, instanceId: "instance:test", region: "cn", viewingAllowed: true, revision: "binding:1" } : null,
    subscribe: () => () => {},
  },
  viewer,
});

const runtime = await createWorkbenchPanelReactRuntime();
const locale = new LocaleRuntime([]); await locale.update({ ideLocale: "en-US" });
await runtime.install(createCloudDesktopWorkbenchPanelPlugin(adapter));
const tab = runtime.panels.open("panel:test", "cloud-desktop", { conversationId: target.conversationId });
const Panel = runtime.renderers.getSnapshot().find(item => item.kind === "cloud-desktop")!.Component;
const root = createRoot(document.getElementById("root")!);
root.render(<IntlRuntimeProvider runtime={locale}><Panel tab={tab} ownerId="panel:test" presentationId="presentation:test" /></IntlRuntimeProvider>);

Object.assign(window, { __desktopFixture: {
  async revoke() { await fetch("/revoke", { method: "POST" }); },
  close() { runtime.panels.close("panel:test", "right", tab.id); },
  async dispose() { root.unmount(); await runtime.dispose(); adapter.dispose(); locale.dispose(); },
} });

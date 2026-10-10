import "../../apps/workbench-web/src/runtime/web-crypto-compat";
import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createAppServerWorkbenchRuntime, HostRuntimeRegistry, createConversationBindingStore,
  asConversationScopeId } from "@opencraft/workbench-runtime";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { connectWebSocketAppHost } from "../../apps/workbench-web/src/runtime/websocket-app-host";
import { HostDesktopBackend } from "../../apps/workbench-web/src/runtime/host-desktop-backend";
import { createCloudDesktopWorkbenchPanelPlugin } from "../../plugins/cloud-desktop/src/index";
import { OPENCRAFT_DESKTOP_ATTACH } from "@opencraft/appserver-protocol/desktop";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";

for (const [key, value] of Object.entries(buildCodexThemeCssProperties("light"))) {
  document.documentElement.style.setProperty(key, value);
}

declare const SMOKE_WORKSPACE_ROOT: string;
// Only the upstream model is synthetic. This uses the real browser AppHost,
// Workbench runtime, Codex Thread, Host authority and native framebuffer.
const appHost = connectWebSocketAppHost();
const registry = new HostRuntimeRegistry([{ descriptor: { hostId: "local-codex", label: "Local",
  kind: "codex", transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [] },
  createRuntime: () => createAppServerWorkbenchRuntime({ hostId: "local-codex", hostKind: "codex",
    createTransport: () => appHost.createTransport("local-codex"), autoReconnect: false }) }]);
const bindings = createConversationBindingStore();
let viewingConnections = 0;
const backend = new HostDesktopBackend({ registry, bindings, origin: location.origin,
  openSocket: url => { viewingConnections++; return new WebSocket(url); } });
const runtime = await registry.ensureConnected("local-codex");
const protocol = runtime.resources.protocol;
const started = await protocol.request("thread/start", { cwd: SMOKE_WORKSPACE_ROOT, model: "gpt-test",
  approvalPolicy: "never", sandbox: "danger-full-access" });
const threadId = started.thread.id;
// Missing/undurable threads must not grant even though this is a local owner.
let missingRejected = false;
try { await protocol.request(OPENCRAFT_DESKTOP_ATTACH, { threadId: "not-a-native-thread" }); }
catch { missingRejected = true; }
if (!missingRejected) throw new Error("Missing Thread was granted");
await protocol.request("turn/start", { threadId, input: [{ type: "text", text: "Reply with fixture response", text_elements: [] }] });
for (let i = 0; i < 100; i++) {
  const read = await protocol.request("thread/read", { threadId, includeTurns: false });
  if ((read.thread as any).status?.type === "idle") break;
  await new Promise(resolve => setTimeout(resolve, 50));
  if (i === 99) throw new Error("Synthetic local Turn did not complete");
}
const scope = asConversationScopeId("local-desktop-test-scope");
bindings.register(scope, asHostId("local-codex"));
bindings.bind(scope, createConversationKey(asHostId("local-codex"), threadId));
if (!backend.resolveTarget(scope)) throw new Error("Local desktop discovery failed");
const panels = await createWorkbenchPanelReactRuntime();
await panels.install(createCloudDesktopWorkbenchPanelPlugin({ backend, surfaces: backend.surfaces }));
const locale = new LocaleRuntime([]); await locale.update({ ideLocale: "en-US" });
const root = createRoot(document.getElementById("root")!);
const open = () => {
  const tab = panels.panels.open("local-desktop-panel", "cloud-desktop", { conversationId: scope });
  const Panel = panels.renderers.getSnapshot().find(item => item.kind === "cloud-desktop")!.Component;
  root.render(<IntlRuntimeProvider runtime={locale}><Panel tab={tab} ownerId="local-desktop-panel"
    presentationId="local-desktop-view" /></IntlRuntimeProvider>);
};
open();
Object.assign(window, { __localDesktopFixture: {
  viewingConnections: () => viewingConnections,
  async closeViewer() {
    panels.panels.close("local-desktop-panel", "right", "cloud-desktop");
    return (await protocol.request("thread/read", { threadId, includeTurns: false })).thread.id === threadId;
  },
  open,
  async disconnectHost() { await registry.dispose(); },
  async dispose() {
    root.unmount(); await panels.dispose(); backend.dispose(); bindings.dispose();
    await registry.dispose(); appHost.close(); locale.dispose();
  },
} });

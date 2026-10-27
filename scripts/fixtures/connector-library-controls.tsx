import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot as createRoot } from "../../tests/fixtures/intl-root";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { AuthenticationService, ConnectorApprovalQueue, ConnectorManager, ConnectorRuntime, asConversationScopeId, createConversationBindingStore } from "@opencraft/workbench-runtime";
import { openConnectorConfigurationStore } from "../../apps/workbench-web/src/runtime/connector-configuration-store";
import { ConnectorLibrary } from "../../apps/workbench-web/src/components/connectors/connector-library";
import { useConnectorPresentation } from "../../apps/workbench-web/src/components/connectors/connector-panel";
import { ModalHost } from "../../apps/workbench-web/src/components/modal/modal-host";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

const client = new JsonRpcAppServerClient({ hostId: "fixture-host", transport: new WebSocketTransport(new URLSearchParams(location.search).get("host")!) });
await client.connect({ clientInfo: { name: "connector-library-controls", version: "1" } });
const ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
const bindings = createConversationBindingStore(), scopeId = asConversationScopeId("library-scope"), hostId = asHostId("fixture-host");
bindings.register(scopeId, hostId); bindings.bind(scopeId, createConversationKey(hostId, "library-thread"));
const approvals = new ConnectorApprovalQueue(), runtime = new ConnectorRuntime(ctx.authentication, 30000, { approvals });
const manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, await openConnectorConfigurationStore(), async () => client);
const scope = { hostId, threadId: "library-thread" };
const composer = createComposerController({ type: "existing-thread", key: createConversationKey(hostId, scope.threadId) }, { now: Date.now, createId: () => crypto.randomUUID() });
const probe = { setThemePreference, result: "idle", error: "", available: () => runtime.discover(scope, new AbortController().signal),
  write: async () => { probe.result = "pending"; try { const tool = (await probe.available()).find(t => t.name === "create_note"); if (!tool) throw new Error("No create_note tool"); await runtime.invoke(scope, tool.handle, { content: "isolated note" }, new AbortController().signal); probe.result = "allowed"; } catch (error) { probe.error = error instanceof Error ? error.message : "failure"; probe.result = "denied"; } },
};
Object.assign(window, { connectorProbe: probe }); initializeAppearanceTheme();
function App() {
  const presentation = useConnectorPresentation(manager, approvals, { hostId, scopeId }, () => undefined);
  return <main style={{ padding: 24, height: "100dvh", overflowY: "auto", background: "var(--color-background-surface)" }}>
    <div style={{ width: "min(720px, 100%)", marginBottom: 24 }}><OpenCraftComposer controller={composer} isStreaming={false}
      addMenuContent={presentation.addMenuContent} endActions={presentation.launcher}
      selectionCatalog={{ models: [], permissionProfiles: [] }} onSubmit={async () => {}} onCancel={() => {}} /></div>
    <ConnectorLibrary hostId={hostId} manager={manager} /><ModalHost requests={presentation.requests} />
  </main>;
}
createRoot(document.getElementById("root")!, undefined, "zh-CN").render(<App />);

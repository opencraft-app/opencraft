import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot as createRoot } from "../../tests/fixtures/intl-root";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { AuthenticationService, ConnectorApprovalQueue, ConnectorManager, ConnectorRuntime, asConversationScopeId, createConversationBindingStore } from "@opencraft/workbench-runtime";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { openConnectorConfigurationStore } from "../../apps/workbench-web/src/runtime/connector-configuration-store";
import { useConnectorPresentation } from "../../apps/workbench-web/src/components/connectors/connector-panel";
import { ConnectorNativeServices } from "../../apps/workbench-web/src/components/connectors/connector-native-services";
import { ModalHost } from "../../apps/workbench-web/src/components/modal/modal-host";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

// Only the native Host/OAuth authority is replaced. UI, domain, wire and IDB are real.
const endpoint = new URLSearchParams(location.search).get("host")!;
const client = new JsonRpcAppServerClient({ hostId: "fixture-host", transport: new WebSocketTransport(endpoint) });
await client.connect({ clientInfo: { name: "connector-controls", version: "1" } });
const ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
const bindings = createConversationBindingStore(), scopeId = asConversationScopeId("fixture-scope"), hostId = asHostId("fixture-host");
bindings.register(scopeId, hostId); bindings.bind(scopeId, createConversationKey(hostId, "fixture-thread"));
const approvals = new ConnectorApprovalQueue(), runtime = new ConnectorRuntime(ctx.authentication, 30000, { approvals });
const manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, await openConnectorConfigurationStore(), async () => client);
const composer = createComposerController({ type: "existing-thread", key: createConversationKey(hostId, "fixture-thread") }, { now: Date.now, createId: () => crypto.randomUUID() });
const scope = { hostId, threadId: "fixture-thread" };
let oauthCompletions = 0;
client.subscribeNotification(notification => {
  if (notification.method === "mcpServer/oauthLogin/completed") oauthCompletions++;
});
const probe = {
  result: "idle", setThemePreference,
  mountPresentation: () => root.render(<App />),
  unmountPresentation: () => root.render(null),
  oauthCompletions: () => oauthCompletions,
  snapshot: () => manager.getSnapshot(),
  available: () => runtime.discover(scope, new AbortController().signal),
  write: async () => {
    probe.result = "pending";
    try {
      const tool = (await runtime.discover(scope, new AbortController().signal)).find(tool => tool.name === "write");
      if (!tool) throw new Error("No selected write tool");
      await runtime.invoke(scope, tool.handle, { target: "isolated-document", text: "fixture-only", token: "synthetic-private-value" }, new AbortController().signal);
      probe.result = "allowed";
    } catch { probe.result = "denied"; }
  },
};
Object.assign(window, { connectorProbe: probe });
initializeAppearanceTheme();
function App() {
  const presentation = useConnectorPresentation(manager, approvals, { hostId, scopeId }, () => { (window as any).connectorProbe.managed = true; });
  return <main style={{ padding: 32, minHeight: "100dvh", background: "var(--color-background-surface)" }}>
    <h1>隔离连接器验收</h1><p>只连接本地模拟 Host 和授权服务，不使用真实账号。</p>
    <ConnectorNativeServices hostId={hostId} manager={manager} />
    <div style={{ width: "min(720px, calc(100vw - 32px))", marginTop: 48 }}>
      <OpenCraftComposer
        controller={composer}
        isStreaming={false}
        addMenuContent={presentation.addMenuContent}
        endActions={presentation.launcher}
        selectionCatalog={{ models: [{ id: "fixture", value: "fixture", label: "Fixture", description: null, isDefault: true, defaultEffort: null, efforts: [] }], permissionProfiles: [] }}
        onSubmit={async () => {}}
        onCancel={() => {}}
      />
    </div>
    <ModalHost requests={presentation.requests} />
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);

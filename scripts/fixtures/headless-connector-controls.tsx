import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot as createRoot } from "../../tests/fixtures/intl-root";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { AuthenticationService, ConnectorManager, ConnectorRuntime, asConversationScopeId, createConversationBindingStore } from "@opencraft/workbench-runtime";
import { openConnectorConfigurationStore } from "../../apps/workbench-web/src/runtime/connector-configuration-store";
import { ConnectorLibrary } from "../../apps/workbench-web/src/components/connectors/connector-library";
import { useConnectorPresentation } from "../../apps/workbench-web/src/components/connectors/connector-panel";
import { ModalHost } from "../../apps/workbench-web/src/components/modal/modal-host";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

import { BrowserHeadlessConnectors, connectorApprovals } from "../../apps/workbench-web/src/runtime/headless-connectors";
const remote = await BrowserHeadlessConnectors.open();
const ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
const bindings = createConversationBindingStore(), scopeId = asConversationScopeId("library-scope"), hostId = asHostId("connector-host");
bindings.register(scopeId, hostId); bindings.bind(scopeId, createConversationKey(hostId, "library-thread"));
const approvals = connectorApprovals(remote), runtime = new ConnectorRuntime(ctx.authentication, 30000, { approvals });
const manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, await openConnectorConfigurationStore(), async () => { throw new Error("Headless must not acquire a browser execution client"); }, remote);
const scope = { hostId, threadId: "library-thread" };
const composer = createComposerController({ type: "existing-thread", key: createConversationKey(hostId, scope.threadId) }, { now: Date.now, createId: () => crypto.randomUUID() });
const probe = { setThemePreference, localProviders: () => runtime.listProviders().length,
  selected: () => manager.getSnapshot().configuration.connectors.filter(c => manager.selectionConfirmed(hostId, scopeId, c.id)).length };
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

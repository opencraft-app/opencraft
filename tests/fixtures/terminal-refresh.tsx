import { RemoteBrowserStorage } from "../../apps/workbench-web/src/browser/remote-browser-storage";
import { WorkbenchResourceSync } from "../../apps/workbench-web/src/runtime/workbench-resource-sync";
import React, { useSyncExternalStore } from "react";
import { createIntlTestRoot } from "./intl-root";
import { createAppServerWorkbenchRuntime, ConversationTerminalSessionRegistry } from "@opencraft/workbench-runtime";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createTerminalWorkbenchPanelPlugin } from "../../plugins/terminal/src/index";
import { WorkbenchPanelRuntimeProvider } from "../../apps/workbench-web/src/runtime/panel-runtime-context";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const params = new URLSearchParams(location.search);
const metadata = params.has("sync") ? await RemoteBrowserStorage.create(undefined, async () => {}) : null;
const sync = metadata ? new WorkbenchResourceSync(metadata) : null;
const draft = params.has("draft");
const promoted = params.has("promoted");
const ownerId = draft && !promoted ? "draft-alias" : "refresh-conversation";
const scope = { threadId: draft && !promoted ? null : "refresh-thread", projectId: "refresh-project" };
const mode = params.get("mode");
const host = createAppServerWorkbenchRuntime({
  hostId: "refresh-host",
  autoReconnect: false,
  transport: new MemoryTransport({
    async receive(frame, peer) {
      const request = JSON.parse(frame);
      if (request.id === undefined || typeof request.method !== "string") return;
      const reply = await fetch("/terminal-refresh/rpc", {
        method: "POST",
        body: JSON.stringify({ request, mode, draft }),
      }).then((r) => r.json());
      peer.send(JSON.stringify({ id: request.id, ...reply.response }));
      for (const notification of reply.notifications ?? []) peer.send(JSON.stringify(notification));
    },
  }),
});
await host.connect();
const registry = new ConversationTerminalSessionRegistry(
  () => host,
  undefined,
  (hostId) => {
    void sync?.notify("terminal", hostId);
  },
);
sync?.register("terminal", () => registry.refreshDirectories());
const runtime = await createWorkbenchPanelReactRuntime();
// Restore must also work when the presentation plugin registers after the view.
runtime.panels.ensureOwner(ownerId);
await runtime.install(
  createTerminalWorkbenchPanelPlugin(registry, undefined, async (owner) => {
    await registry.restore("refresh-host", owner, scope, draft && promoted ? ["draft-alias"] : []);
  }),
);
const context = { ownerId, resourceOwnerId: ownerId, hostId: "refresh-host", cwd: "/fixture", ...scope };
function App() {
  const state = useSyncExternalStore(
    (listener) => runtime.panels.subscribeOwner(ownerId, listener),
    () => runtime.panels.getOwnerSnapshot(ownerId),
  );
  const renderers = useSyncExternalStore(runtime.renderers.subscribe, runtime.renderers.getSnapshot);
  const actions = runtime.panels.getToolbarActionSnapshot();
  return (
    <WorkbenchPanelRuntimeProvider runtime={runtime}>
      <AppShell
        foreground={state.right.open ? "tools" : "primary"}
        layoutScope={ownerId}
        mainContentLayout="default"
        header={
          <>
            <button data-testid="new-terminal" onClick={() => actions[0]!.run(context)}>
              New terminal
            </button>
            <button
              data-testid="show-tools"
              onClick={() =>
                runtime.panels.dispatch(ownerId, {
                  type: "set-region-open",
                  region: "right",
                  open: true,
                  allowEmpty: true,
                })
              }
            >
              Show tools
            </button>
          </>
        }
        floatingSidebarHeader={() => null}
        leftPanel={null}
        sidebarOpen={false}
        sidebarWidth={275}
        windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}
        rightPanelKeepMounted
        rightPanelOpen={state.right.open}
        rightPanelFullWidth={state.rightPanelFullWidth}
        onRightPanelOpenChange={(open) =>
          runtime.panels.dispatch(ownerId, { type: "set-region-open", region: "right", open })
        }
        rightPanel={
          <RightPanel
            state={state}
            presentationId="refresh-view"
            renderers={renderers}
            toolbarActions={actions}
            toolbarActionContext={context}
            onAction={(action) => runtime.panels.dispatch(ownerId, action)}
            onCloseTab={(tab) => runtime.panels.close(ownerId, tab.region, tab.id)}
          />
        }
      >
        <p>Terminal refresh fixture</p>
      </AppShell>
    </WorkbenchPanelRuntimeProvider>
  );
}
(window as any).fixture = {
  registry,
  runtime,
  ownerId,
  reconcileMetadata: () => metadata?.reconcile(),
  disconnectMetadata: () => (metadata as any)?.socket?.close(),
  inspect() {
    const directory = registry.getConversationSnapshot(ownerId);
    return {
      ids: directory.sessionIds,
      output: directory.sessionIds.map((id) =>
        registry
          .get(id)!
          .getSnapshot()
          .output.map(({ sequence, stream, deltaBase64 }) => ({ sequence, stream, deltaBase64 })),
      ),
      tabs: runtime.panels.getOwnerSnapshot(ownerId).right.tabs.map((tab) => tab.resource),
    };
  },
};
createIntlTestRoot(document.getElementById("root")!).render(<App />);

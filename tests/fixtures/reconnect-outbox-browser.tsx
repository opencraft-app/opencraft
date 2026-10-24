import React, { useSyncExternalStore } from "react";
import { createIntlTestRoot } from "./intl-root";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { createBrowserConversationOutbox } from "../../apps/workbench-web/src/runtime/browser-conversation-outbox";
import { queuedSubmissionPresentation } from "../../apps/workbench-web/src/queued-submission-presentation";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
let account = "account-one";
const store = createBrowserConversationOutbox({ storage: sessionStorage, scope: () => account });
const runtime = createAppServerWorkbenchRuntime({ hostId: "fixture", outbox: store.forProfile(1),
  autoReconnect: true, reconnectDelaysMs: [100, 200], requestTimeoutMs: 2000,
  createTransport: () => new WebSocketTransport({ url: location.origin.replace(/^http/, "ws") + "/fixture-rpc" }),
});
await runtime.connect();
const lease = await runtime.acquireThread("thread-one"); lease.setRecoveryVisibility(true);
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("fixture", "thread-one") }, { now: Date.now, createId: () => crypto.randomUUID() });
(window as any).fixture = { runtime: runtime.getSnapshot, snapshot: lease.getSnapshot, setThemePreference,
  account: (next: string) => { account = next; store.refreshScope(); }, draft: () => controller.getSnapshot().draft,
  failStorage: () => { Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; },
};
function App() {
  const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  return <main style={{ maxWidth: 850, margin: "32px auto", padding: 12 }} data-authoritative={String(snapshot.authoritative)}>
    <h2>Reconnect outbox</h2>
    <OpenCraftComposer controller={controller} awaitSubmission isStreaming={snapshot.activeTurn !== null}
      availableFollowUpActions={!snapshot.authoritative || snapshot.queuedSubmissions.some(row => row.local)
        ? ["queue"] : (["steer", "queue"] as const).filter(action => runtime.resources.host.canRequest?.(action === "queue" ? "thread/queue/add" : "turn/steer") !== false)}
      queuedSubmissions={snapshot.queuedSubmissions.map(row => queuedSubmissionPresentation(row, false))}
      onSubmit={intent => lease.submit(intent).then(() => true)} onCancel={() => {}}
      onDeleteQueuedSubmission={id => lease.deleteQueuedSubmission(id)} />
  </main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<App />);

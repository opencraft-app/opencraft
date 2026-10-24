import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppServerClientRegistry } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { TurnCompletionObserver } from "@opencraft/workbench-runtime";
import { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { ChatSettings } from "../../apps/workbench-web/src/components/chat-settings";
import { AsyncNoticesProvider } from "../../apps/workbench-web/src/components/async-notices";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { IndexedDbUiPreferenceStore } from "../../apps/workbench-web/src/runtime/indexeddb-ui-preference-store";
import { BrowserTurnNotifications } from "../../apps/workbench-web/src/runtime/browser-turn-notifications";
import { TurnNotificationsProvider } from "../../apps/workbench-web/src/runtime/turn-notifications-context";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "../../apps/workbench-web/src/i18n/workbench-locale";
import "../../apps/workbench-web/src/styles/app.scss";

// Only the remote execution boundary is synthetic; Client, observer, Settings,
// preference storage, Intl and browser Notification/ServiceWorker APIs are real.
const preferences = await UiPreferencesRuntime.open({ installation: await IndexedDbUiPreferenceStore.open({ databaseName: "opencraft-turn-notification-smoke" }) });
const locale = new WorkbenchLocaleController(preferences, { ideLocale: "zh-CN" });
await locale.initialize();
const registry = new AppServerClientRegistry();
const source = new TurnCompletionObserver(registry);
const notifications = new BrowserTurnNotifications();
const clients = new Map<string, any>();
const threads = new Map<string, { id: string; name: string; preview: string; turns: unknown[] }>();
async function connect(hostId: string) {
  const client = registry.create({ hostId, transport: new MemoryTransport({
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      if (message.method === "fixture/notify") peer.send(encodeJsonRpcMessage(message.params as any));
      peer.send(encodeJsonRpcMessage({ id: message.id, result: message.method === "initialize"
        ? { codexHome: "/synthetic", platformFamily: "unix", platformOs: "linux", userAgent: "notification-smoke" }
        : message.method === "thread/read" ? { thread: threads.get(hostId) } : {} }));
    },
  }) });
  await client.connect({ clientInfo: { name: "turn-notification-smoke", version: "1" } });
  clients.set(hostId, client);
}
await connect("host-a"); await connect("host-b"); await connect("host-c");
const opened: unknown[] = [];
let toggleSettings = () => {};
function Probe() {
  const [settings, setSettings] = useState(true);
  toggleSettings = () => setSettings(value => !value);
  return <UiPreferencesProvider runtime={preferences}>
    <WorkbenchIntlProvider controller={locale} target={document.documentElement}>
      <AsyncNoticesProvider>
      <TurnNotificationsProvider source={source} notifications={notifications} openConversation={async location => { opened.push(location); return true; }}>
        <main style={{ padding: 32 }}>{settings ? <ChatSettings /> : <div data-conversation>对话内容</div>}</main>
      </TurnNotificationsProvider>
      </AsyncNoticesProvider>
    </WorkbenchIntlProvider>
  </UiPreferencesProvider>;
}
(window as any).__turnNotificationFixture = {
  context: async (hostId: string, name: string, message: string) => {
    threads.set(hostId, { id: "thread", name, preview: "first message", turns: [] });
    await clients.get(hostId).request("thread/read", { threadId: "thread" });
    await clients.get(hostId).request("fixture/notify", { method: "item/started", params: { threadId: "thread", turnId: "turn-1", item: { id: "user", type: "userMessage", content: [{ type: "text", text: message }] } } });
  },
  notify: (hostId: string, method: string, params: unknown) => clients.get(hostId).request("fixture/notify", { method, params }),
  emit: (hostId: string, turnId: string, status = "completed", method = "turn/completed") => clients.get(hostId).request("fixture/notify", { method, params: { threadId: "thread", turn: { id: turnId, status } } }),
  reconnect: async () => { await registry.remove("host-a"); await connect("host-a"); },
  settings: () => toggleSettings(),
  preference: () => preferences.get("chat.turnNotifications"),
  opened,
};
createRoot(document.getElementById("root")!).render(<StrictMode><Probe /></StrictMode>);

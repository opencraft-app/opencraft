import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { AppServerBotDirectory, AppServerBotConversationResolver, AppServerBotConversationSource, createCordisBotConversationRuntime } from "@opencraft/bot-conversation-appserver";
import { botSelectionResourceUri } from "@opencraft/bot-conversation";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { createBotChatView } from "../../plugins/bot-chat/src/bot-chat-view";
import { BrowserHermesAppServerBridge } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge";
import { parseInstanceProfileBots } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-profile-bots";
import { HermesInstanceBotManagement } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-bot-management";
import { createBotManagementView } from "../../apps/workbench-web/src/components/bot-management";

// Only the remote Hermes/control-plane boundary is simulated. The bridge,
// typed client, Cordis service, directory, resolver, source and View are real.
const rows = new Map<string, Array<{ role: string; text: string; row_id: number }>>([
  ["default", []], ["sales", []],
]);
const calls: Array<{ method: string; params: Record<string, any> }> = [];
const controlCalls: Array<{ method: string; body?: any }> = [];
const names = new Map([["default", "Main Bot"], ["sales", "Sales Bot"]]);
const catalog = () => [...rows.keys()].map(profile => ({ bot_id: profile === "default" ? "fixture-instance" : profile,
  instance_id: "fixture-instance", profile_id: profile === "default" ? "main" : profile, name: names.get(profile)!, status: "ready" }));
let createdCount = 0;
const management = new HermesInstanceBotManagement("fixture-instance", async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  controlCalls.push({ method, body });
  if (method === "GET") return { items: catalog() } as T;
  if (method === "POST") {
    const id = `new-profile-${++createdCount}`;
    rows.set(id, []); names.set(id, body.name);
    return catalog().find(bot => bot.bot_id === id) as T;
  }
  const id = decodeURIComponent(path.split("/").at(-1)!);
  const profile = id === "fixture-instance" ? "default" : id;
  if (method === "PUT") { names.set(profile, body.name); return catalog().find(bot => bot.bot_id === id) as T; }
  const deleted = catalog().find(bot => bot.bot_id === id);
  rows.delete(profile); names.delete(profile); return deleted as T;
});
let generation = 0;
class NativeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  readonly generation = ++generation;
  send(data: string) {
    const request = JSON.parse(data); calls.push(request);
    const params = request.params ?? {};
    const profile = params.profile ?? String(params.session_id ?? "default").replace(/^stored:|^live:/u, "").split(":")[0];
    const payload = () => ({ session_id: `live:${profile}:${this.generation}`, stored_session_id: `stored:${profile}`,
      message_count: rows.get(profile)?.length ?? 0, messages: [], running: false, info: { cwd: "/fixture" } });
    let result: unknown;
    if (request.method === "profiles.list") result = { profiles: [...rows.keys()].map(name => ({ name, canonical_session: { id: `stored:${name}` } })) };
    else if (request.method === "session.list") result = { sessions: [{ id: `stored:${profile}`, profile, title: "Bot Chat", root_title: "Bot Chat", preview: "", started_at: 1,
      message_count: rows.get(profile)?.length ?? 0, source: "desktop" }] };
    else if (["session.resume", "session.activate"].includes(request.method)) result = payload();
    else if (request.method === "prompt.submit") {
      result = { status: "streaming" };
      const messages = rows.get(profile)!;
      messages.push({ role: "user", text: params.text, row_id: messages.length + 1 });
      setTimeout(() => {
        const text = `Reply from ${profile}: ${params.text}`;
        this.event("message.start", params.session_id, {});
        this.event("message.delta", params.session_id, { text });
        messages.push({ role: "assistant", text, row_id: messages.length + 1 });
        this.event("message.complete", params.session_id, { text });
        this.event("session.info", params.session_id, { running: false });
      }, 100);
    } else if (request.method === "session.interrupt") result = { interrupted: true };
    else throw new Error(`Unexpected native method ${request.method}`);
    queueMicrotask(() => this.receive({ jsonrpc: "2.0", id: request.id, result }));
  }
  event(type: string, session_id: string, payload: unknown) { this.receive({ jsonrpc: "2.0", method: "event", params: { type, session_id, payload } }); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close() { this.readyState = WebSocket.CLOSED; }
}
function transport(): DuplexTransport {
  const socket = new NativeSocket();
  const listeners = new Set<(frame: string) => void>();
  const statuses = new Set<(status: TransportStatus) => void>();
  let status: TransportStatus = { state: "idle" };
  const bridge = new BrowserHermesAppServerBridge(socket, {
    instanceId: "fixture-instance",
    resolveProfileBots: async () => parseInstanceProfileBots({ items: catalog() }, "fixture-instance"),
    botManagement: management,
    history: {
      async readMessages(id, request) {
        const profile = id.replace(/^stored:/u, "");
        const all = rows.get(profile)!;
        const end = Math.max(0, all.length - request.offset);
        return { session_id: id, messages: all.slice(Math.max(0, end - request.limit), end) };
      }, dispose() {},
    },
  });
  bridge.onNotification(event => { for (const listener of listeners) listener(JSON.stringify(event)); });
  const publish = (state: TransportStatus["state"]) => { status = { state }; for (const listener of statuses) listener(status); };
  return {
    get status() { return status; },
    async connect() { publish("open"); },
    async send(frame) {
      const request = JSON.parse(frame);
      if (request.id === undefined) return;
      const response = await bridge.handle(request);
      for (const listener of listeners) listener(JSON.stringify(response));
    },
    subscribeMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeStatus(listener) { statuses.add(listener); return () => statuses.delete(listener); },
    async close() { bridge.dispose(); socket.close(); publish("closed"); },
  };
}

async function main() {
  const registry = await createCordisAppServerRegistry();
  const runtime = await createCordisBotConversationRuntime(registry.context);
  const source = new AppServerBotConversationSource(runtime.service);
  const resolver = new AppServerBotConversationResolver(runtime.service);
  const directory = new AppServerBotDirectory(runtime.service, registry.clients);
  const client = registry.clients.create({ hostId: "hermes-fixture", transport: transport() });
  await client.connect({ clientInfo: { name: "hermes-profile-ui-probe", version: "1" } });
  await directory.refresh("hermes-fixture");
  const View = createBotChatView(source, { resolver });
  const Manager = createBotManagementView(directory, async () => {});
  const manageMode = new URLSearchParams(location.search).has("management");
  function Probe() {
    const catalog = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
    const [resourceUri, setResource] = useState<string | null>(null);
    const [managing, setManaging] = useState(manageMode);
    const host = { activeHostId: "local", platform: "web", profiles: [
      { hostId: "local", displayName: "Local", providerId: "local.agent", enabled: true },
      { hostId: "hermes-fixture", displayName: "Hermes 测试实例", providerId: "lightvela.hermes", enabled: true },
    ],
      openView(_id: string, uri: string) { setResource(uri); setManaging(false); },
      replaceViewResource(_id: string, uri: string) { setResource(uri); } } as ExtensionSettingsViewProps["host"];
    if (managing) return <Manager host={host} activation={{ viewId: "manager", resourceUri: null }} contribution={{ id: "manager", title: "Bots", viewType: "manager" }} />;
    return <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", height: "100vh" }}>
      <aside aria-label="Fixture Bot directory">{manageMode && <button onClick={() => setManaging(true)}>管理 Bots</button>}{catalog.entries.map(entry => <button key={entry.bot.botId}
        onClick={() => setResource(botSelectionResourceUri(entry.hostId, entry.bot.botId))}>{entry.bot.name}</button>)}</aside>
      {resourceUri && <View activation={{ viewId: "vela.bot-chat.view", resourceUri }} host={host}
        contribution={{ id: "vela.bot-chat.view", title: "Bot chat", viewType: "vela.bot-chat.surface" }} />}
    </div>;
  }
  (window as any).__hermesFixture = { calls, rows, controlCalls, async reconnect() {
    await client.close();
    // Transport close is final; replace logical client beneath the same Host identity.
    await registry.clients.remove("hermes-fixture");
    const next = registry.clients.create({ hostId: "hermes-fixture", transport: transport() });
    await next.connect({ clientInfo: { name: "hermes-profile-ui-probe", version: "1" } });
    await directory.refresh("hermes-fixture");
  } };
  createRoot(document.getElementById("root")!).render(<Probe />);
}
void main();

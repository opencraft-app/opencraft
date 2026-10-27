import { StrictMode, useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { createBotManagementView } from "../../apps/workbench-web/src/components/bot-management";
import { createBotManagementExtension } from "../../apps/workbench-web/src/runtime/bot-management-extension";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import type { AppServerBotConversationService, AppServerBotDirectory } from "@opencraft/bot-conversation-appserver";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";

// Only directory/connection/conversation I/O is simulated; rendering, policy,
// selection, lifecycle, operation drafts and Radix controls are production code.
initializeAppearanceTheme();
const profile = (hostId: string) => ({ hostId, providerId: `example.${hostId}`, enabled: true, revision: 1 });
const entry = (hostId: string) => ({ hostId, availability: "available", bot: {
  botId: hostId, name: `Bot ${hostId}`, status: "available", revision: 1,
  management: { rename: true, clone: true, delete: true },
} });
let snapshot: any = { hosts: [], entries: [] };
const listeners = new Set<() => void>();
const calls: Array<{ kind: string; hostId: string }> = [];
const held = new Map<string, Array<{ resolve(value?: any): void; reject(error: Error): void }>>();
const hold = new Set<string>(["connect:a"]);
function request(kind: string, hostId: string) {
  calls.push({ kind, hostId });
  const key = `${kind}:${hostId}`;
  if (!hold.has(key)) return Promise.resolve({ data: [] });
  return new Promise<any>((resolve, reject) => held.set(key, [...held.get(key) ?? [], { resolve, reject }]));
}
const directory = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => snapshot,
  refresh: (id: string) => request("refresh", id),
  create: (id: string) => request("create", id),
  update: (id: string) => request("update", id),
  delete: (id: string) => request("delete", id),
} as unknown as AppServerBotDirectory;
const conversations = {
  capability: () => ({ topologies: ["group"], features: { configuration: false } }),
  listConversations: (id: string) => request("groups", id),
} as unknown as AppServerBotConversationService;
const connect = async (id: string) => { await request("connect", id); };
const Generic = createBotManagementView(directory, conversations, connect);
const input = { providerIds: ["example.a"], messages: { noHosts: "Product has no eligible Agent" } };
const extension = createBotManagementExtension(directory, conversations, connect, input);
// Mutation after assembly must not change the retained product policy.
input.providerIds.push("example.b"); input.messages.noHosts = "Mutated";
let Restricted: typeof Generic;
extension.activate({
  views: { register() {} }, navigation: { register() {} },
  internal: { register(_kind: string, value: any) { Restricted = value.Component; } },
} as any);
const Empty = createBotManagementView(directory, conversations, connect, { providerIds: [] });
let configure: (ids: string[], states: any[], kind?: string, revision?: number) => void;
function Fixture() {
  const [profiles, setProfiles] = useState([profile("a")]);
  const [kind, setKind] = useState("generic");
  configure = (ids, hosts, nextKind, revision = 1) => {
    snapshot = { hosts, entries: hosts.filter(h => h.canManageBots).map(h => entry(h.hostId)) };
    setProfiles(ids.map(id => ({ ...profile(id), revision }))); if (nextKind) setKind(nextKind);
    for (const listener of listeners) listener();
  };
  const View = kind === "restricted" ? Restricted : kind === "empty" ? Empty : Generic;
  const host = { platform: "web", activeHostId: "chat-untouched", profiles,
    openView(_id: string, uri: string) { calls.push({ kind: "open", hostId: uri }); },
  } as unknown as ExtensionSettingsViewProps["host"];
  return <View host={host} activation={{ viewId: "manager", resourceUri: null }}
    contribution={{ id: "manager", title: "Bots", viewType: "manager" }} />;
}
(window as any).botPolicyProof = {
  calls, hold,
  configure: (ids: string[], states: any[], kind?: string, revision?: number) => configure(ids, states, kind, revision),
  settle(key: string, fail = false) {
    hold.delete(key);
    for (const task of held.get(key) ?? []) {
      if (fail) task.reject(new Error("Late old Host failure"));
      else task.resolve({ data: [{ conversationId: key, title: `Group ${key}`, topology: "group" }] });
    }
    held.delete(key);
  },
  theme: setThemePreference,
};
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<StrictMode><Fixture /></StrictMode>);

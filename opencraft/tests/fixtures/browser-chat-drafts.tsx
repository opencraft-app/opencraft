import "../../apps/workbench-web/src/runtime/web-crypto-compat";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { AppServerBotConversationSource, type AppServerBotConversationService } from "@opencraft/bot-conversation-appserver";
import { botConversationResourceUri } from "@opencraft/bot-conversation";
import { createConversationKey } from "@opencraft/chat-core";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { createBotChatView } from "../../plugins/bot-chat/src/bot-chat-view";
import { BrowserComposerDrafts } from "../../apps/workbench-web/src/runtime/browser-composer-drafts";

// Only the remote service boundary is synthetic. Source, View and editor are real.
const participants = [
  { participantId: "person", kind: "human" as const, displayName: "You" },
  { participantId: "bot", kind: "bot" as const, displayName: "Bot" },
];
const service = {
  sends: 0,
  subscribe() { return () => {}; },
  async waitForCapability() { return { version: 1 }; },
  async readConversation(_host: string, params: { conversationId: string }) {
    return {
      conversation: { conversationId: params.conversationId, revision: 1, topology: "direct", title: "Bot",
        participantIds: ["person", "bot"], createdAtMs: 1, updatedAtMs: 1 },
      participants, initialMessagesPage: { data: [] }, executions: [], presence: [], interactions: [],
      liveCursor: { epoch: "fixture", nextSeq: 0 },
    };
  },
  async sendMessage() { this.sends++; throw new Error("Reload must not send"); },
};
const source = new AppServerBotConversationSource(service as unknown as AppServerBotConversationService);
const View = createBotChatView(source, {
  drafts: new BrowserComposerDrafts(window.localStorage, "fixture.bot-drafts"),
  resolver: { async resolve() { return createConversationKey("fixture", "a"); } },
});
const locale = new LocaleRuntime([]);
await locale.update({ ideLocale: "en-US" });
document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(buildCodexThemeCssProperties("light"))) document.documentElement.style.setProperty(key, value);
let navigate = (_room: string) => {};
function Probe() {
  const [room, setRoom] = useState("a"); navigate = setRoom;
  const host = { platform: "web", activeHostId: "fixture", replaceViewResource() {} } as ExtensionSettingsViewProps["host"];
  return <View host={host} activation={{ viewId: "draft-fixture", resourceUri: botConversationResourceUri(createConversationKey("fixture", room)) }}
    contribution={{ id: "draft-fixture", title: "Bot", viewType: "draft-fixture" }} />;
}
createRoot(document.getElementById("root")!).render(<IntlRuntimeProvider runtime={locale}><Probe /></IntlRuntimeProvider>);
Object.assign(window, { __draftFixture: { service, navigate: (room: string) => navigate(room) } });

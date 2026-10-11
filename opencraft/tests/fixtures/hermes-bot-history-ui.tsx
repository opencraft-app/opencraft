import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { botConversationResourceUri } from "@opencraft/bot-conversation";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { createBotChatView } from "../../plugins/bot-chat/src/bot-chat-view";
import { createHermesBotHistoryHarness, toolHistory } from "./hermes-bot-history-harness";

async function main() {
  const mode = new URLSearchParams(location.search).get("mode");
  const h = await createHermesBotHistoryHarness(toolHistory(mode === "budget" ? 600 : 130));
  if (mode === "failure") h.failNextOlder();
  const View = createBotChatView(h.source, { resolver: h.resolver });
  const host = { activeHostId: h.key.hostId, platform: "web", profiles: [
    { hostId: h.key.hostId, displayName: "Hermes fixture", providerId: "lightvela.hermes", enabled: true },
  ], openView() {}, replaceViewResource() {} } as ExtensionSettingsViewProps["host"];
  (window as any).__historyFixture = {
    requests: h.requests,
    snapshot: () => h.source.getSnapshot(h.key),
    resync: h.resync,
    dispose: h.dispose,
  };
  createRoot(document.getElementById("root")!).render(
    <IntlProvider locale="en" messages={{}}><div style={{ height: "100vh" }}><View
      activation={{ viewId: "history-fixture", resourceUri: botConversationResourceUri(h.key) }}
      host={host} contribution={{ id: "history-fixture", title: "History", viewType: "vela.bot-chat.surface" }}
    /></div></IntlProvider>,
  );
}
void main();

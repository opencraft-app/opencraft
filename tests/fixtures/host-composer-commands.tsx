import { applyAppearanceThemeToElement } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createComposerController, composerDocumentToPlainText } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { HostConnectionProviderRegistry, createHostComposerCommandPort, findStandaloneHostComposerAction } from "@opencraft/workbench-runtime";

applyAppearanceThemeToElement(document.documentElement);
const calls: unknown[] = [];
const registry = new HostConnectionProviderRegistry();
const unregister = registry.register("fixture", {
  id: "fixture", label: "Fixture", configVersion: 1, targets: ["web"], validate: c => c,
  createTransport() { throw new Error("Fixture has no network"); },
  composerCommands: {
    commands: [
      { name: "status", kind: "prompt", description: { id: "composer.commands.status", defaultMessage: "View status" } },
      { name: "stop", kind: "action", description: { id: "composer.commands.stop", defaultMessage: "Stop current task" } },
    ],
    invoke: async (name, context) => { calls.push([name, context.hostId, context.threadId, context.expectedTurnId]); },
  },
});
const resident = registry.acquire("fixture", "web");
const port = createHostComposerCommandPort({ provider: resident.provider,
  context: { platform: "web", hostId: "fixture-host", profileRevision: 1 },
  protocol: { request: async () => { throw new Error("Unexpected protocol request"); } },
  isCurrent: () => true, acquire: () => registry.acquire("fixture", "web"),
})!;
let sequence = 0;
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("fixture-host", "fixture-thread") },
  { now: Date.now, createId: () => String(++sequence) });
(window as any).__commandsFixture = { calls, retire() { resident.release(); return unregister(); } };
createRoot(document.getElementById("root")!).render(<OpenCraftComposer controller={controller}
  shortcutCommands={port.commands.map(c => ({ name: c.name, description: c.description.defaultMessage }))}
  onSubmit={intent => {
    const action = findStandaloneHostComposerAction(intent, port.commands);
    if (action) return port.invoke(action.name, { threadId: "fixture-thread", expectedTurnId: "captured-turn" }).then(() => true);
    calls.push(["prompt", composerDocumentToPlainText(intent.document).trim()]); return true;
  }}
  selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true,
    description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }} />);

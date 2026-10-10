import { createIntlTestRoot as createRoot } from "./intl-root";
import { CodexComposer } from "@opencraft/codex-composer";
import { createComposerController, legacyContentBlocksToComposer, composerDocumentToPlainText } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { createVoiceInputExtension } from "../../plugins/voice-input/src/extension";
import { useVoiceInputPreference } from "../../apps/workbench-web/src/runtime/use-voice-input-preference";
import type { ComponentType } from "react";
import type { ComposerActionHost } from "@opencraft/extension-react";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";

initializeAppearanceTheme();
setThemePreference("system");

let Voice!: ComponentType<ComposerActionHost>, Settings!: ComponentType;
const dispose: Array<() => void> = [];
const definition = createVoiceInputExtension(undefined, { webSpeech: { usePreferences: useVoiceInputPreference } });
definition.activate({ views: { register() {} }, settings: { registerPage() {} }, subscriptions: { add(value: () => void) { dispose.push(value); } },
  internal: { register(channel: string, value: any) { if (channel === "composerActionRenderer") Voice = value.Component; else if (channel === "platformViewRenderer") Settings = value.Component; } },
} as any);
let sequence = 0;
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("fixture", "thread") }, { now: Date.now, createId: () => String(++sequence) });
const doc = (text: string) => legacyContentBlocksToComposer([{ type: "text", text }]).document;
controller.dispatch({ type: "set-document", document: doc("Original text") });
const sent: string[] = [];
const mutations = { insertText: (text: string) => controller.insertText(text), focus: () => controller.focus(), beginTransientTextInput: controller.beginTransientTextInput };
(window as any).__hunyuanFixture = { sent,
  replace() { controller.dispatch({ type: "replace-content", document: doc("Replacement"), attachments: [], context: [] }); },
  dispose() { for (const release of dispose) release(); },
};
createRoot(document.getElementById("root")!).render(<>
  <div style={{ maxWidth: 760, margin: "24px auto" }}><Settings /></div>
  <CodexComposer controller={controller} onSubmit={intent => { sent.push(composerDocumentToPlainText(intent.document)); return false; }}
    selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true, description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }}
    endActions={<Voice mutations={mutations} disabled={false} platform="web" />} />
</>);

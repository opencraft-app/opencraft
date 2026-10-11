import { createIntlTestRoot as createRoot } from "./intl-root";
import { CodexComposer } from "@opencraft/codex-composer";
import { createComposerController, legacyContentBlocksToComposer, composerDocumentToPlainText } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { CloudSpeechInputProvider } from "../../plugins/voice-input/src/cloud-speech";
import { createVoiceInputAction } from "../../plugins/voice-input/src/voice-input-action";
import { EmbeddedSpeechService } from "../../apps/workbench-web/src/embedded-chat/embedded-speech-service";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";

initializeAppearanceTheme(); setThemePreference("system");
let token = "synthetic-session";
const service = new EmbeddedSpeechService("", () => token);
const provider = new CloudSpeechInputProvider(service);
const Voice = createVoiceInputAction(provider);
let sequence = 0;
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("fixture", "thread") }, { now: Date.now, createId: () => String(++sequence) });
const document = (text: string) => legacyContentBlocksToComposer([{ type: "text", text }]).document;
controller.dispatch({ type: "set-document", document: document("Original text") });
const sent: string[] = [];
declare global { interface Window { embeddedSpeechFixture: { sent: string[]; replace(): void; logout(): void } } }
window.embeddedSpeechFixture = {
  sent,
  replace() { controller.dispatch({ type: "replace-content", document: document("Replacement"), attachments: [], context: [] }); },
  logout() { token = ""; provider.close(); service.close(); },
};
void service.refresh();
createRoot(globalThis.document.getElementById("root")!).render(
  <CodexComposer controller={controller} onSubmit={intent => { sent.push(composerDocumentToPlainText(intent.document)); return false; }}
    selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true, description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }}
    endActions={<Voice mutations={{ insertText: text => controller.insertText(text), focus: () => controller.focus(), beginTransientTextInput: controller.beginTransientTextInput }} disabled={false} platform="web" />} />,
);

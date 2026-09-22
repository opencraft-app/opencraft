import { createIntlTestRoot as createRoot } from "./intl-root";
import { CodexComposer } from "@opencraft/codex-composer";
import { createComposerController, legacyContentBlocksToComposer, composerDocumentToPlainText } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { createVoiceInputAction } from "../../plugins/voice-input/src/voice-input-action";
import type { SpeechInputObserver } from "../../plugins/voice-input/src/speech-input-provider";

const document = (text: string) => legacyContentBlocksToComposer([{ type: "text", text }]).document;
let sequence = 0, observer: SpeechInputObserver | null = null;
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("local", "fixture") }, { now: Date.now, createId: () => String(++sequence) });
const sent: string[] = [];
const provider = { id: "diagnostic", isAvailable: () => true, start(next: SpeechInputObserver) {
  observer = next;
  return { stop() { setTimeout(() => { next.commit("voice result"); next.end(); }, 150); }, cancel() {} };
} };
const Voice = createVoiceInputAction(provider);
const mutations = Object.freeze({ insertText: (text: string) => controller.insertText(text), focus: () => controller.focus(), beginTransientTextInput: controller.beginTransientTextInput });
function seed(text: string) { controller.dispatch({ type: "set-document", document: document(text) }); }
seed("Original text");
const fixture = {
  sent,
  replace: () => controller.dispatch({ type: "replace-content", document: document("Replacement"), attachments: [], context: [] }),
  resetViewState: () => seed("Reset state"),
  lateFinal: () => { observer?.commit("late foreign result"); observer?.end(); },
  reentrantWrite: () => {
    let armed = true;
    const unsubscribe = controller.subscribe(() => {
      if (!armed || !composerDocumentToPlainText(controller.getSnapshot().draft.document).includes("voice result")) return;
      armed = false; fixture.replace(); unsubscribe();
    });
  },
};
(window as any).__ownershipFixture = fixture;
createRoot(window.document.getElementById("root")!).render(<CodexComposer controller={controller}
  onSubmit={intent => { sent.push(composerDocumentToPlainText(intent.document)); return false; }}
  selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true,
    description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }}
  endActions={<Voice mutations={mutations} disabled={false} platform="web" />} />);

import React, { useState } from "react";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { ImageEditorContext } from "@opencraft/extension-react";
import ImageEditor from "../../plugins/image-editor/src/editor";
import editorStyles from "../../plugins/image-editor/src/editor.web.scss?inline";
import * as themes from "@opencraft/design-system/theme-engine";
import type { UserMessageTimelineBlock } from "@opencraft/chat-core";
import { createIntlTestRoot } from "./intl-root";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import appStyles from "../../apps/workbench-web/src/styles/app.scss?inline";

const host = document.getElementById("host");
if (host === null) throw new Error("Missing image preview host");
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = appStyles.replaceAll(":root", ":host");
shadow.append(style);
const presentationRoot = document.createElement("div");
presentationRoot.className = "opencraft-embedded-workbench-root";
shadow.append(presentationRoot);

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#2876c7"/><text x="60" y="260" fill="white" font-size="54">Sent image</text></svg>')}`;
const block: UserMessageTimelineBlock = {
  type: "user-message",
  id: "sent-image",
  sourceItemIds: [],
  message: "",
  content: [{ type: "image", source: image, detail: null }],
  attachments: [],
  messageKind: "user",
  clientId: null,
  steeringStatus: null,
  sentAtMs: null,
  deliveryStatus: null,
  referencesPriorConversation: false,
  reviewMode: false,
  pullRequestFixMode: false,
  autoResolveSync: false,
  goal: false,
  hookFeedback: false,
  commentCount: 0,
  hasExternalAttachments: false,
};

const mode = new URLSearchParams(location.search).get("mode") === "dark" ? "dark" : "light";
const multipleMetadataImages = new URLSearchParams(location.search).has("metadata-multiple");
const metadataDenied = new URLSearchParams(location.search).has("metadata-denied");
const metadataOnly = new URLSearchParams(location.search).has("metadata-only");
function SentImageMessage() {
  const [hydrated, setHydrated] = useState(false);
  if (!metadataOnly) return <UserMessageBlock block={block} />;
  Object.assign(window, { hydrateImageContent: () => setHydrated(true) });
  return <UserMessageBlock block={{ ...block,
    message: "Inspect these images",
    content: hydrated ? (multipleMetadataImages
      ? [{ type: "local-image", source: "/host/second.png", detail: null }, { type: "local-image", source: "/host/IMG_3364.png", detail: null }]
      : [{ type: "local-image", source: "/host/IMG_3364.png", detail: null }]) : [],
    attachments: (multipleMetadataImages ? ["IMG_3364.png", "second.png"] : ["IMG_3364.png"]).map(name => ({
      type: "file", id: name, name, target: `/host/${name}`, mimeType: "image/png", startLine: null, endLine: null,
    })),
  }} />;
}
const metadataCompletions: (() => void)[] = [];
const metadataMedia = {
  conversationId: "preview", hostId: "fixture", cwd: "/host", theme: mode,
  loadMediaSource: async () => {
    const state = window as any;
    state.metadataLoads = (state.metadataLoads ?? 0) + 1;
    await new Promise<void>(resolve => {
      metadataCompletions.push(resolve);
      state.completeMetadataMedia = () => metadataCompletions.splice(0).forEach(complete => complete());
    });
    return metadataDenied ? null : { source: image };
  },
} as const;
for (const [key, value] of Object.entries(themes.buildOpenCraftThemeCssProperties(mode, themes.opencraftNeutralThemePalette[mode]))) presentationRoot.style.setProperty(key, value);
presentationRoot.dataset.theme = mode;
presentationRoot.dataset.uiDensity = new URLSearchParams(location.search).has("touch") ? "touch" : "compact";
presentationRoot.style.minHeight = "100dvh";
presentationRoot.style.background = "var(--color-background-primary)";
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("local", "images") }, { now: () => Date.now(), createId: () => crypto.randomUUID() });
const completions: (() => void)[] = [];
Object.assign(window, { imagePreviewFixture: { controller, switchThread: (id: string) => controller.dispatch({ type: "switch-target", target: { type: "existing-thread", key: createConversationKey("local", id) } }), complete: () => completions.splice(0).forEach(complete => complete()), submissions: 0, files: [] as File[] } });
createIntlTestRoot(presentationRoot).render(
  <WorkbenchPresentationRootProvider target={presentationRoot}>
    <ImageEditorContext.Provider value={{ id: "opencraft.image-editor", Component: ImageEditor, styles: editorStyles }}>
    {metadataOnly ? <ConversationDocumentContext.Provider value={metadataMedia}><SentImageMessage /></ConversationDocumentContext.Provider> : <SentImageMessage />}
    <div style={{ position: "relative", maxWidth: 760, margin: "24px auto", padding: 12 }}>
      <OpenCraftComposer isStreaming={false} controller={controller} portalContainer={presentationRoot} mentionSuggestionsEnabled={false} onCancel={() => {}}
        onSubmit={() => { (window as any).imagePreviewFixture.submissions++; return false; }}
        onResolveAttachment={(file, pending) => { (window as any).imagePreviewFixture.files.push(file); return new Promise(resolve => completions.push(() => resolve({ ...pending, lifecycle: "ready", uri: "file:///synthetic/" + pending.name, error: null }))); }} />
    </div>
    </ImageEditorContext.Provider>
  </WorkbenchPresentationRootProvider>,
);

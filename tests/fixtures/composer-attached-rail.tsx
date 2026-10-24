import React, { useState } from "react";
import { createConversationKey, type TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import * as themes from "@opencraft/design-system/theme-engine";
import { TurnDiffBlock } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { queuedSubmissionPresentation } from "../../apps/workbench-web/src/queued-submission-presentation";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const palettes = {
  neutral: themes.opencraftNeutralThemePalette, canvas: themes.opencraftCanvasThemePalette,
  frost: themes.frostThemePalette, lavender: themes.lavenderThemePalette,
  mist: themes.mistThemePalette, graphite: themes.graphiteThemePalette,
};
const paletteName = params.get("palette") ?? "neutral";
const palette = palettes[paletteName as keyof typeof palettes];
if (!palette) throw new Error(`Unknown fixture palette: ${paletteName}`);
document.documentElement.dataset.theme = mode;
for (const [key, value] of Object.entries(themes.buildOpenCraftThemeCssProperties(mode, palette[mode]))) document.documentElement.style.setProperty(key, value);
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("local", "test") }, { now: () => 100, createId: () => "draft" });
const submission = queuedSubmissionPresentation({ commandId: "queue", clientMessageId: "client", serverSubmissionId: "server", input: [], preview: "检查文件变更，并保留现有操作", operation: "idle", createdAt: 100, pausedReason: null, error: null, state: "queued" }, true);
const block: TurnDiffTimelineBlock = { id: "diff", type: "turn-diff", sourceItemIds: ["diff"], status: "running", unifiedDiff: "", additions: 477, deletions: 15, files: [{ path: "example.ts", additions: 477, deletions: 15 }] };
function Fixture() {
 const [state, setState] = useState("both");
 const [count,setCount] = useState(1);
 Object.assign(window, { setRailState: setState, setRailCount: setCount });
 return <main style={{ minHeight: "100dvh", padding: 12, background: "var(--color-background-primary)", color: "var(--color-text)" }}>
   <div style={{ maxWidth: 760, margin: "80px auto 0", position: "relative" }}>
    <div style={{ position: "absolute", inset: 0, color: "red" }} aria-hidden>正文正文正文正文正文正文正文正文正文正文正文正文</div>
    <OpenCraftComposer controller={controller} isStreaming queuedSubmissions={state === "both" || state === "queue" ? Array.from({length:count},(_,i)=>({...submission,id:`queue-${i}`,renderKey:`client-${i}`})) : []}
      floatingContent={state === "both" || state === "summary" ? <ConversationDocumentContext.Provider value={{ conversationId: null, cwd: null, hostId: null, theme: mode, onReviewTurnDiff: () => { (window as any).reviewCount = ((window as any).reviewCount ?? 0) + 1; } }}><div className="thread-live-changes"><TurnDiffBlock block={block} /></div></ConversationDocumentContext.Provider> : null}
      onSubmit={() => false} onCancel={() => {}} />
   </div>
 </main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);

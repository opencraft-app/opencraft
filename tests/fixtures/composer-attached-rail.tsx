import React, { useState } from "react";
import { createConversationKey, type TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { IconButton } from "@opencraft/design-system-web/button";
import { TabCountIcon } from "@opencraft/design-system-web/action-icons";
import * as themes from "@opencraft/design-system/theme-engine";
import { TurnDiffBlock } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { queuedSubmissionPresentation } from "../../apps/workbench-web/src/queued-submission-presentation";
import { createIntlTestRoot } from "./intl-root";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
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
 const [state, setState] = useState(params.has("cold-queue") ? "none" : "both");
 const [attachmentOnly, setAttachmentOnly] = useState(false);
 const [pausedReason, setPausedReason] = useState<string | null>(null);
 const [count,setCount] = useState(1);
 const [message,setMessage] = useState(submission.preview);
 Object.assign(window, { setRailState: setState, setRailCount: setCount, setRailMessage: setMessage, setRailAttachmentOnly: setAttachmentOnly, setRailPausedReason: setPausedReason });
 return <main style={{ minHeight: "100dvh", padding: 12, background: "var(--color-background-primary)", color: "var(--color-text)" }}>
   <div style={{ maxWidth: 760, margin: "80px auto 0", position: "relative" }}>
    <div style={{ position: "absolute", inset: 0, color: "red" }} aria-hidden>正文正文正文正文正文正文正文正文正文正文正文正文</div>
    <OpenCraftComposer controller={controller} isStreaming queuedSubmissions={state === "both" || state === "queue" ? Array.from({length:count},(_,i)=>({...submission,preview:attachmentOnly ? "" : message,pausedReason,editableContent:attachmentOnly ? {...submission.editableContent,attachments:[{id:"photo",name:"现场截图.png",mimeType:"image/png",size:1,uri:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL20AAAAASUVORK5CYII=",lifecycle:"ready" as const,error:null}]} : submission.editableContent,id:`queue-${i}`,renderKey:`client-${i}`})) : []}
      supportsQueuedSteer onSteerQueuedSubmission={async () => { (window as any).steerCount = ((window as any).steerCount ?? 0) + 1; }}
      navigationActions={params.has('navigation') ? <IconButton size="navigation" surface="floating" aria-label="Tools" onClick={() => { (window as any).navigationCount = ((window as any).navigationCount ?? 0) + 1; }}><TabCountIcon count={1} /></IconButton> : null}
      floatingContent={state === "both" || state === "summary" ? <ConversationDocumentContext.Provider value={{ conversationId: null, cwd: null, hostId: null, theme: mode, onReviewTurnDiff: () => { (window as any).reviewCount = ((window as any).reviewCount ?? 0) + 1; } }}><div className="thread-live-changes"><TurnDiffBlock block={block} /></div></ConversationDocumentContext.Provider> : null}
      onSubmit={() => false} onCancel={() => {}} />
   </div>
 </main>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, params.get('locale') ?? 'en-US').render(
 <AppShell layoutScope="rail-fixture" mainContentLayout="default" header={null} floatingSidebarHeader={() => null}
  rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} sidebarOpen={false} sidebarWidth={275}
  windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
  onSidebarCollapse={() => {}} onSidebarExpand={() => {}} onSidebarResizeEnd={() => {}} onRightPanelOpenChange={() => {}}>
  <Fixture />
 </AppShell>);

import { ComposerTurnChangeSummary } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import React, { useCallback, useState } from "react";
import { ShellPresentationContext } from "../../apps/workbench-web/src/components/shell-presentation";
import type { TimelineStatus, TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { TurnDiffReviewDialog } from "../../apps/workbench-web/src/components/conversation/turn-diff-review-dialog";
import gitCases from "./turn-diff-git-cases.json";
import { reviewDiffForFile } from "../../apps/workbench-web/src/components/conversation/turn-diff-review";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const files = [
  ["2026-10-05-opencraft-ssh-management.checkpoint.md", 3, 1],
  ["docs/context/tasks/2026-10-05-opencraft-ssh-management.md", 5, 0],
  ["opencraft/apps/workbench-web/src/app.tsx", 2, 0],
  [`deep/directory/${"long-basename-".repeat(12)}.css`, 1234, 987],
  ["short.js", 0, 12],
] as const;
const layoutDiff = files.map(([path, added, removed]) => [
  `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
  `@@ -1,${removed} +1,${added} @@`,
  ...Array.from({ length: removed }, () => "-old"),
  ...Array.from({ length: added }, () => "+new"),
].join("\n")).join("\n");
const selectedCase = new URLSearchParams(location.search).get("gitCase");
const diff = selectedCase === "all" ? gitCases.map(entry => entry.diff).join("")
  : gitCases.find(entry => entry.name === selectedCase)?.diff ?? layoutDiff;
const floatingSummary = new URLSearchParams(location.search).has("floatingSummary");
const requestedStatus = new URLSearchParams(location.search).get("turnStatus");
const status: TimelineStatus = floatingSummary ? "streaming" : requestedStatus === "failed" || requestedStatus === "interrupted" ? requestedStatus : "complete";
const withoutAssistant = new URLSearchParams(location.search).has("withoutAssistant");
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) {
  document.documentElement.style.setProperty(key, value);
}
const historyMode = new URLSearchParams(location.search).get("history");
const historicalChanges = Array.from({ length: 14 }, (_, index) => ({ path: `/workspace/src/file-${index}.ts`, kind: { type: "add" }, diff: index === 0 ? "large content\n".repeat(120) : `file ${index}\n` }));
function buildTimeline(hydrated: boolean, loadedItems: readonly string[] = []) { return projectTimeline({
  key: createConversationKey("fixture", "diff-layout"), revision: 1, authoritative: true, phase: "live",
  turns: [{ id: "turn", status, ...(historyMode ? {} : { unifiedDiff: diff }), items: [
    ...historyMode === "multiple" ? historicalChanges.map((change, index) => ({ id: `historical-${index}`, type: "fileChange", payload: {
      status: "completed", changes: [index < 3 && !loadedItems.includes(`historical-${index}`) ? { path: change.path, kind: change.kind } : change],
      ...index < 3 && !loadedItems.includes(`historical-${index}`) ? { historyDetail: { cursor: `fixture-${index}` } } : {} } }))
    : historyMode ? [{ id: "historical-patch", type: "fileChange", payload: { status: "completed", changes: historicalChanges.map((change, index) => !hydrated && historyMode !== "full" && index === 0 ? { path: change.path, kind: change.kind, additions: 0, deletions: 0 } : change),
      ...!hydrated && historyMode !== "full" ? { historyDetail: { cursor: "fixture" } } : {} } }] : [],
    { id: "question", type: "userMessage", payload: { text: "Update files" } },
    ...withoutAssistant ? [] : [{ id: "answer", type: "agentMessage", payload: { text: "Updated.", completed: true, phase: "final_answer" } }],
  ] }],
}, createDefaultTimelineProjectorRegistry()); }
function Fixture() {
  const shellTest = new URLSearchParams(location.search).has("shellPresentation");
  const [panelMode, setPanelMode] = useState("chat");
  const [hydrated, setHydrated] = useState(false);
  const [loadedItems, setLoadedItems] = useState<readonly string[]>([]);
  const timeline = buildTimeline(hydrated, loadedItems);
  const loadItemDetails = useCallback(async (ids: readonly string[], signal: AbortSignal) => {
    const calls = Number(document.documentElement.dataset.detailCalls ?? "0") + 1;
    document.documentElement.dataset.detailCalls = String(calls);
    document.documentElement.dataset.detailIds = JSON.stringify(ids);
    const wait = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, historyMode === "slow" ? 20_000 : 300);
      signal.addEventListener("abort", () => { clearTimeout(timer); document.documentElement.dataset.detailAborted = "true"; reject(new Error("aborted")); }, { once: true });
    });
    if (historyMode === "multiple") {
      for (const id of ids) {
        await wait();
        if (signal.aborted) return;
        setLoadedItems(previous => [...previous, id]);
      }
      return;
    }
    await wait();
    if (signal.aborted) return;
    if (historyMode === "failure" && calls === 1) throw new Error("fixture read failed");
    setHydrated(true);
  }, []);
  const [review, setReview] = useState<{ block: TurnDiffTimelineBlock; path: string | null } | null>(null);
  return (
  <ShellPresentationContext.Provider value={shellTest ? { sidebarOpen: false, sidebarFloating: false, rightPanelOpen: panelMode !== "chat", rightPanelFullWidth: panelMode === "tools", toggleSidebar() {}, dismissSidebarAfterSelection() {}, toggleRightPanel() {} } : null}>
  {shellTest ? <nav aria-label="Fixture presentation">{["chat", "tools", "split"].map(mode => <button key={mode} onClick={() => setPanelMode(mode)}>{mode}</button>)}</nav> : null}
  <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
    {!floatingSummary ? <Conversation onLoadItemDetails={loadItemDetails} timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
      documentContext={{ conversationId: "diff-layout", hostId: "fixture", cwd: "/workspace", theme,
        onReviewTurnDiff: (block, path) => {
          document.documentElement.dataset.reviewPath = path ?? "";
          document.documentElement.dataset.reviewDiff = reviewDiffForFile(block.unifiedDiff, path ?? null);
          if (new URLSearchParams(location.search).has("review")) setReview({ block, path: path ?? null });
        } }}
      onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} /> : null}
    {floatingSummary ? <ComposerTurnChangeSummary timeline={timeline} turnId="turn" documentContext={{ conversationId: "fixture", cwd: "/workspace", theme,
      onReviewTurnDiff: (block, path) => setReview({ block, path: path ?? null }) }} /> : null}
    {review !== null ? <TurnDiffReviewDialog onLoadItemDetails={loadItemDetails} block={timeline.frames.find(frame => frame.changeSummary?.id === review.block.id)?.changeSummary ?? review.block} initialPath={review.path} onClose={() => setReview(null)} /> : null}
  </TimelineBlockRendererProvider>
  </ShellPresentationContext.Provider>
  );
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);

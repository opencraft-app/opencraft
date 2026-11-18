import React, { useContext, useState } from "react";
import { flushSync } from "react-dom";
import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot } from "./intl-root";
import { asTurnId, createConversationKey, type TimelineSnapshot, type TimelineBlock } from "@opencraft/chat-core";
import { createConversationDisplayContinuity } from "@opencraft/workbench-runtime";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { TurnDiffBlock } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { Conversation, type ConversationRestoreSnapshot } from "../../apps/workbench-web/src/components/conversation";
import { AsyncQuestionContext } from "../../apps/workbench-web/src/components/conversation-renderers/render-contexts";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { useConversationDisplay } from "../../apps/workbench-web/src/runtime/use-conversation-display";
import "../../apps/workbench-web/src/styles/app.scss";

type Row = { id: string; height: number };
const probe = window as any;
probe.events = []; probe.samples = []; probe.loads = 0; probe.ready = 0;
const resourceOnly = new URLSearchParams(location.search).has("resourceOnly");
const resources = new URLSearchParams(location.search).has("resources");
const cached = new URLSearchParams(location.search).has("cached");
const initialOldHeight = new URLSearchParams(location.search).has("shortOld") ? 240 : 900;
const noOlder = new URLSearchParams(location.search).has("noOlder");
const initialTailHeight = new URLSearchParams(location.search).has("longTail") ? 1000 : 120;
const key = createConversationKey("fixture", "cold-history");
const makeTimeline = (rows: Row[], revision: number, streaming: boolean): TimelineSnapshot => ({
  key, revision, authoritative: true, phase: "live", anchorFrameIds: new Map(),
  frames: rows.map<TimelineSnapshot["frames"][number]>(row => ({ type: "assistant", id: `frame-${row.id}`, turnId: asTurnId(row.id),
    status: row.id === "tail" && streaming ? "streaming" : "complete", durationMs: row.id === "old" ? 71000 : null, displayDurationMs: row.id === "old" ? 71000 : null,
    hookStats: resources && row.id === "old" ? { count: 1, blockedCount: 0, errorCount: 0, blockedMessages: [], blockedSources: [], entries: [], feedbackMessages: [], runs: [] } : null,
    changeSummary: resources && row.id === "old" ? { type: "turn-diff" as const, id: "old-diff", sourceItemIds: [], status: "complete" as const, unifiedDiff: "", additions: 4, deletions: 0,
      files: Array.from({ length: 4 }, (_, i) => ({ path: "src/file-" + i + ".ts", additions: 1, deletions: 0 })) } : undefined, anchors: [],
    blocks: [...(row.id === "old" ? [{ type: "command-execution", id: "old-work", sourceItemIds: [], command: "pwd", callId: null, cwd: null, processId: null, startedAtMs: null, turnInProgress: false, output: "/fixture", exitCode: 0, durationMs: 12, actions: [], automaticApprovalReviews: [], status: "completed" } as TimelineBlock] : []), { type: "text", id: row.id, text: String(row.height), sourceItemIds: [],
      streaming: row.id === "tail" && streaming, completed: !(row.id === "tail" && streaming), phase: "final_answer" }],
  })).flatMap(frame => resourceOnly && frame.turnId === "old" ? [
    { ...frame, type: "user" as const, id: "old-input-frame", hookStats: null, changeSummary: undefined,
      durationMs: null, displayDurationMs: null, blocks: [{ type: "text" as const, id: "old-input", text: "24", sourceItemIds: [], streaming: false, completed: true, phase: "final_answer" as const }] },
    { ...frame, durationMs: null, displayDurationMs: null, blocks: [] },
  ] : [frame]),
});
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({ name: "geometry-probe", types: ["text", "command-execution"], priority: 0,
  component: ({ block }) => {
    const questions = useContext(AsyncQuestionContext), document = useContext(ConversationDocumentContext);
    if (block.type === "command-execution") return <pre data-work-probe={block.id} style={{ height: 144, margin: 0 }}>{block.command}{"\n"}{block.output}</pre>;
    const height = Number((block as any).text);
    return <div data-probe={block.id} data-can-answer={questions.answer !== null} data-can-fork={document.onForkTurn !== undefined}
      style={{ height, background: "var(--color-background-panel)", overflow: "hidden" }}>
      {Array.from({ length: Math.ceil(height / 24) }, (_, i) => <p key={i} data-line={`${block.id}-${i}`} style={{ margin: 0, height: 24 }}>Message {block.id} · line {i}</p>)}
    </div>;
  },
});
ctx.timelineBlockRenderers.register({ name: "turn-resource", types: ["turn-diff"], priority: 0,
  component: ({ block }) => block.type === "turn-diff" ? <TurnDiffBlock block={block} /> : null });
const values = new Map<string, string>();
const storage = { load: async (key: string) => values.get(key) ?? null,
  save: async (key: string, value: string) => { values.set(key, value); },
  remove: async (key: string) => { values.delete(key); } };
if (cached) await createConversationDisplayContinuity({ namespace: "probe", storage }).observe(makeTimeline([
  { id: "old", height: initialOldHeight }, { id: "tail", height: initialTailHeight },
], 1, false), false);
const owner = createConversationDisplayContinuity({ namespace: "probe", storage });
const continuity = { ...owner, getScope: () => "probe", subscribe: () => () => {} };
let finishPage: ((rows: Row[]) => void) | undefined;
function App() {
  const [rows, setRows] = useState<Row[]>([{ id: "tail", height: initialTailHeight }]);
  const [revision, setRevision] = useState(1), [streaming, setStreaming] = useState(!cached);
  const [live, setLive] = useState(!cached), [hasOlder, setHasOlder] = useState(!noOlder), [loading, setLoading] = useState(false);
  const [view, setView] = useState(1), [mounted, setMounted] = useState(true);
  const [restore, setRestore] = useState<ConversationRestoreSnapshot | null>(null);
  const timeline = React.useMemo(() => live ? makeTimeline(rows, revision, streaming) : null, [rows, revision, streaming, live]);
  const { selection } = useConversationDisplay(continuity, key, timeline, hasOlder);
  probe.source = selection.source;
  probe.startLive = () => setLive(true);
  probe.grow = (height: number) => { setStreaming(true); setRows(r => r.map(row => row.id === "tail" ? { ...row, height } : row)); setRevision(v => v + 1); };
  probe.complete = () => { setStreaming(false); setRevision(v => v + 1); };
  probe.prepend = (id: string, height: number) => { setRows(r => [{ id, height }, ...r]); setRevision(v => v + 1); };
  probe.prependBatch = (older: Row[]) => flushSync(() => {
    setRows(r => [...older, ...r]); setRevision(v => v + 1);
  });
  probe.resizeRow = (id: string, height: number) => flushSync(() => {
    setRows(r => r.map(row => row.id === id ? { ...row, height } : row)); setRevision(v => v + 1);
  });
  probe.clearRows = () => flushSync(() => { setRows([]); setRevision(v => v + 1); });
  probe.release = (older: Row[] = [{ id: "old", height: initialOldHeight }]) => finishPage?.(older);
  probe.leave = () => setMounted(false);
  probe.cache = () => { setLive(false); setRows([{ id: "tail", height: initialTailHeight }]); setStreaming(false); setHasOlder(true); };
  probe.restore = restore;
  probe.return = () => { setView(v => v + 1); setMounted(true); };
  const loadOlder = async () => {
    probe.loads++; probe.events.push({ event: "load-start", at: performance.now() }); setLoading(true);
    const older = await new Promise<Row[]>(resolve => { finishPage = resolve; });
    if (older.length) { setRows(r => [...older, ...r]); setRevision(v => v + 1); }
    setHasOlder(false); setLoading(false); probe.events.push({ event: "load-end", at: performance.now() });
    return "stop" as const;
  };
  return <main style={{ height: "100dvh", width: "100%" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      {mounted && <Conversation key={view} timeline={selection.timeline} scrollPolicy="natural"
        readOnlyTurnIds={selection.source === "mixed" ? selection.cachedTurnIds : undefined}
        onLoadOlder={live && hasOlder ? loadOlder : undefined} history={{ cursor: rows[0]?.id ?? null, hasOlder, loading }}
        onAnswerAsyncQuestion={selection.source === "cache" ? undefined : async () => {}}
        documentContext={{ conversationId: key.threadId, hostId: key.hostId, cwd: null, theme: "light",
          turnActions: { fork: true, reviewDiff: true },
          onReviewTurnDiff: selection.source === "cache" ? undefined : () => { probe.reviews = (probe.reviews ?? 0) + 1; },
          onForkTurn: selection.source === "cache" ? undefined : async () => { probe.forks = (probe.forks ?? 0) + 1; } }}
        initialRestoreSnapshot={restore} onRestoreSnapshotChange={setRestore}
        onVisibleContentReady={() => { probe.ready++; probe.events.push({ event: "ready", at: performance.now() }); }} visibleContentReadyKey={view}
        footer={<textarea aria-label="Draft" defaultValue="Keep this draft" style={{ height: 70, width: "100%" }} />}
      />}
    </TimelineBlockRendererProvider>
  </main>;
}
function sample() {
  const element = document.querySelector('[data-probe="tail"]'), root = document.querySelector(".thread-scroll");
  if (element && root && probe.samples.length < 10000) probe.samples.push({ at: performance.now(),
    top: element.getBoundingClientRect().top, bottom: element.closest(".thread-turn")!.getBoundingClientRect().bottom,
    scrollTop: root.scrollTop, height: root.scrollHeight, ready: probe.ready });
  requestAnimationFrame(sample);
}
requestAnimationFrame(sample);
createIntlTestRoot(document.getElementById("root")!).render(<App />);

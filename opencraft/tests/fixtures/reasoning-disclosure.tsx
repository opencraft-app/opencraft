import React, { useEffect, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline,
  type TimelineSourceItem, type TimelineSourceTurn } from "@opencraft/chat-core";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation, type ConversationRestoreSnapshot } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildCodexThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const probe = window as any;
let restore: ConversationRestoreSnapshot | null = null;
const text = "First returned line\nCurrent returned line";

function reasoning(engine: string, content = text, completed = false): TimelineSourceItem {
  return { id: "reason", type: "reasoning", payload: {
    summary: engine === "codex" ? [content] : [], content: !content ? [] : engine === "codex" ? ["Alternate returned detail"] : [content],
    completed, status: completed ? "completed" : "inProgress",
  } };
}

// The reported regression: one response with 60 tools interleaved by thirteen
// protocol reasoning Items that never returned readable text.
const emptyCycleCounts = [8, 6, 4, 4, 5, 5, 1, 5, 4, 4, 2, 5, 7];
function longEmptyResponse(engine: string, withClock: boolean): TimelineSourceTurn {
  const items: TimelineSourceItem[] = emptyCycleCounts.flatMap((count, cycle) => [
    ...Array.from({ length: count }, (_, index): TimelineSourceItem => ({
      id: `long-tool-${cycle}-${index}`, type: "commandExecution", payload: {
        command: `echo cycle-${cycle}-tool-${index}`, status: "completed", exitCode: 0,
      },
    })),
    { ...reasoning(engine, "", true), id: `long-empty-reason-${cycle}` },
  ]);
  items.push({ id: "long-answer", type: "agentMessage", payload: {
    text: "Long response final answer", phase: "final_answer", completed: true,
  } });
  return { id: "turn", status: "complete", items, ...(withClock ? {
    startedAtMs: 1_000, firstTurnWorkItemStartedAtMs: 1_050,
    finalAssistantStartedAtMs: 5_000, completedAtMs: 5_100, durationMs: 4_100,
  } : {}) };
}

function Demo() {
  const [engine, setEngine] = useState("codex");
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [revision, setRevision] = useState(0);
  const [turn, setTurn] = useState<TimelineSourceTurn>({ id: "turn", status: "streaming", items: [reasoning("codex")] });
  probe.update = (action: string, selectedEngine = engine) => {
    setRevision(value => value + 1);
    if (action === "restore") { setMounted(false); return; }
    if (action === "reset" || action === "empty") {
      restore = null; setEngine(selectedEngine); setGeneration(value => value + 1);
      setTurn({ id: "turn", status: "streaming", items: [reasoning(selectedEngine, action === "empty" ? "" : text)] }); return;
    }
    if (action === "long-empty" || action === "long-empty-clock") {
      restore = null; setEngine(selectedEngine); setGeneration(value => value + 1);
      setTurn(longEmptyResponse(selectedEngine, action === "long-empty-clock")); return;
    }
    if (action === "middle-empty") {
      restore = null; setEngine(selectedEngine); setGeneration(value => value + 1);
      setTurn({ id: "turn", status: "streaming", items: [
        { id: "before-bash", type: "commandExecution", payload: { command: "echo earlier", status: "completed", exitCode: 0 } },
        { id: "before-read", type: "commandExecution", payload: { command: "cat earlier.ts", status: "completed", exitCode: 0 } },
        reasoning(selectedEngine, ""),
        { id: "after-bash", type: "commandExecution", payload: { command: "echo later", status: "completed", exitCode: 0 } },
        { id: "after-read", type: "commandExecution", payload: { command: "cat later.ts", status: "completed", exitCode: 0 } },
      ] }); return;
    }
    if (action === "reasoning-only-complete") {
      restore = null; setEngine(selectedEngine); setGeneration(value => value + 1);
      setTurn({ id: "turn", status: "complete", startedAtMs: 1_000,
        firstTurnWorkItemStartedAtMs: 1_050, finalAssistantStartedAtMs: 10_000,
        completedAtMs: 10_050, durationMs: 9_000, items: [
          reasoning(selectedEngine, text, true),
          { id: "answer", type: "agentMessage", payload: { text: "Final answer", phase: "final_answer", completed: true } },
        ] }); return;
    }
    setTurn(current => {
      if (action === "middle-fill") return { ...current, items: current.items.map(item => item.type === "reasoning" ? reasoning(engine) : item) };
      if (action === "grow") return { ...current, items: [reasoning(engine, text + "\nNew returned line")] };
      if (action === "tools") return { ...current, items: [...current.items,
        { id: "bash", type: "commandExecution", payload: { command: "echo tool", status: "completed", exitCode: 0 } },
        { id: "read", type: "commandExecution", payload: { command: "cat file.ts", status: "completed", exitCode: 0,
          commandActions: [{ type: "read", name: "file.ts", path: "file.ts" }] } }] };
      if (action === "complete") return { ...current, status: "complete", items: [...current.items.map(item => item.type === "reasoning"
        ? { ...item, payload: { ...(item.payload as object), completed: true, status: "completed" } } : item),
        { id: "answer", type: "agentMessage", payload: { text: "Final answer", phase: "final_answer", completed: true } }] };
      if (action === "prepend") return { ...current, items: [
        { id: "history", type: "agentMessage", payload: { text: "Earlier commentary", phase: "commentary", completed: true } }, ...current.items] };
      return current;
    });
  };
  // Let the real View emit its cleanup receipt before recreating it, as a
  // route return does. This is not a timer or a separate preference store.
  useEffect(() => { if (!mounted) { setGeneration(value => value + 1); setMounted(true); } }, [mounted]);
  const timeline = projectTimeline({ key: createConversationKey(engine, "thread"), revision, authoritative: true,
    phase: "live", turns: [turn] }, registry);
  return <div data-revision={revision} style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      {mounted ? <Conversation key={generation} timeline={timeline} scrollPolicy="natural" initialRestoreSnapshot={restore}
        onRestoreSnapshotChange={value => { restore = value; }}
        footer={<div style={{ height: 48 }}>Composer fixture</div>} /> : null}
    </TimelineBlockRendererProvider>
  </div>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, params.get("locale") === "zh" ? "zh-CN" : "en-US").render(<Demo />);

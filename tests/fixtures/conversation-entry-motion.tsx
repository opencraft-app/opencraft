import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot } from "./intl-root";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceTurn } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({name: "entry-probe", priority: 0, types: ["text", "command-execution"],
  component: ({block}) => <div>{block.type === "text" ? block.text : "Tool output"}</div>});
const start = Date.now() - 2500;
function running(id: string): TimelineSourceTurn {
  return {id, status: "streaming", startedAtMs: start, firstTurnWorkItemStartedAtMs: start,
    items: [{id: `${id}:user`, type: "userMessage", payload: {content: [{type: "text", text: "Run tests"}]}},
      {id: `${id}:tool`, type: "commandExecution", payload: {command: "pwd", status: "completed"}},
      {id: `${id}:tool2`, type: "commandExecution", payload: {command: "bash -lc echo-running", status: "inProgress"}}]};
}
function Demo() {
  const [revision, setRevision] = useState(0);
  const [scope, setScope] = useState("A");
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<"live" | "syncing" | "painted">("live");
  const [turns, setTurns] = useState<readonly TimelineSourceTurn[]>([running("A")]);
  (window as any).entryFixture = {
    theme: setThemePreference,
    restore(next: string) {setScope(next); setPhase("live"); setTurns([running(next)]); setGeneration(n => n + 1);},
    switchInPlace(next: string) {setScope(next); setPhase("live"); setTurns([running(next)]);},
    beginRecovery() {setPhase("syncing"); setTurns([]); setGeneration(n => n + 1);},
    preview() {setPhase("syncing"); setTurns([running(scope)]);},
    confirm() {setPhase("live"); setTurns([running(scope)]);},
    reconnect() {setPhase("syncing");},
    emptyLive() {setPhase("live"); setTurns([]); setGeneration(n => n + 1);},
    liveWork() {setTurns([running(scope)]);},
    finish() {setTurns([{...running(scope), status: "complete", durationMs: 3600, finalAssistantStartedAtMs: start + 3600,
      items: [{id: `${scope}:tool`, type: "commandExecution", payload: {command: "pwd", status: "completed"}},
        {id: `${scope}:answer`, type: "agentMessage", payload: {text: "Done", phase: "final_answer"}}]}]);},
  };
  const controls = (window as any).entryFixture;
  for (const name of Object.keys(controls)) {
    const action = controls[name];
    controls[name] = (...args: unknown[]) => {setRevision(n => n + 1); return action(...args);};
  }
  const timeline = projectTimeline({key: createConversationKey("fixture",scope), phase, authoritative: phase === "live", revision: 1, turns}, createDefaultTimelineProjectorRegistry());
  return <div data-fixture-revision={revision} style={{width: "100%", height: "100vh"}}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
    <Conversation key={generation} timeline={timeline} scrollPolicy="natural" />
  </TimelineBlockRendererProvider></div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);

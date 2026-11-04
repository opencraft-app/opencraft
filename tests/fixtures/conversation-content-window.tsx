import React, { useEffect, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceItem } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { Conversation, type ConversationRestoreSnapshot } from "../../apps/workbench-web/src/components/conversation";
import { WorkbenchPresentationActivityProvider } from "../../apps/workbench-web/src/components/workbench-presentation-activity";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const context = new Context();
await context.plugin(TimelineBlockRendererRegistryService);
await context.plugin(BuiltinTimelineRendererPlugin);
const registry = createDefaultTimelineProjectorRegistry();
const probe = window as unknown as { append: () => void; restore: () => void; grouped: () => void };
let restore: ConversationRestoreSnapshot | null = null;
function Demo() {
  const [count, setCount] = useState(500);
  const [generation, setGeneration] = useState(0);
  const [grouped, setGrouped] = useState(false);
  const [mounted, setMounted] = useState(true);
  useEffect(() => { if (!mounted) { setGeneration(value => value + 1); setMounted(true); } }, [mounted]);
  probe.append = () => setCount(value => value + 1);
  probe.restore = () => setMounted(false);
  probe.grouped = () => setGrouped(true);
  const items: TimelineSourceItem[] = [{ id: "prompt", type: "userMessage", payload: { content: [{ type: "inputText", text: "Long activity prompt" }] } }];
  for (let index = 0; index < count; index++) {
    items.push({ id: `cmd-${index}`, type: "commandExecution", payload: { command: `echo activity-${index}`, status: "completed", exitCode: 0, aggregatedOutput: `Output ${index}` } });
    if (!grouped) items.push({ id: `reason-${index}`, type: "reasoning", payload: { summary: [`Thought ${index}\n\nReasoning detail ${index}`], content: [`Reasoning detail ${index}`], completed: true } });
    if (!grouped && index % 8 === 0) items.push({ id: `comment-${index}`, type: "agentMessage", payload: {
      text: `Commentary ${index}\n\n` + Array.from({ length: 8 }, (_, line) => `- Reading detail ${index}-${line}`).join("\n"),
      phase: "commentary", completed: true,
    } });
  }
  const timeline = projectTimeline({ key: createConversationKey("codex", "content-window"), revision: count,
    authoritative: true, phase: "live", turns: [{ id: "turn", status: "streaming", items }] }, registry);
  return <div style={{ width: "100vw", height: "100dvh" }}><WorkbenchPresentationActivityProvider active>
    <TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
      {mounted ? <Conversation key={generation} timeline={timeline} scrollPolicy="natural" initialRestoreSnapshot={restore}
        onRestoreSnapshotChange={value => { restore = value; }} documentContext={{ theme: "light", hostId: "codex", conversationId: "content-window", cwd: "/work" }}
        footer={<textarea aria-label="Draft" defaultValue="Keep this draft" style={{ width: "100%", height: 60 }} />} /> : null}
    </TimelineBlockRendererProvider>
  </WorkbenchPresentationActivityProvider></div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);

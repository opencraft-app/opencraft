import React from "react";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { webBuiltinTimelineRendererComponents } from "../../apps/workbench-web/src/components/conversation";
import { createIntlTestRoot } from "./intl-root";
import styles from "../../apps/workbench-web/src/styles/app.scss?inline";

const root = document.getElementById("root")!;
const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);
root.className = "opencraft-embedded-workbench-root";
root.style.cssText = "max-width:860px;margin:auto;padding:16px;--color-text:#21272b;--color-text-tertiary:#77818a;--color-background-surface:white;--opencraft-chat-font-size:15px";
const first = '<realtime_delegation><TrAnScRiPt_DeLtA>assistant: Use &lt;main&gt; &amp; tests\nuser: Inspect the app.</TrAnScRiPt_DeLtA><InPuT>Inspect the app.</InPuT></realtime_delegation>';
const later = '<realtime_delegation><source>transcript_tail_flush</source><transcript_delta>assistant: &lt;img src=x onerror="window.transcriptExecuted=true"&gt;</transcript_delta><input>Continue.</input></realtime_delegation>';
const source = {
  key: createConversationKey("fixture", "synthetic-voice"), revision: 1, phase: "live" as const, authoritative: true, turns: [{
    id: "voice", status: "complete" as const, params: { input: [{ type: "text", text: first }], clientUserMessageId: "leading" },
    items: [
      { id: "realtime-delegation-leading", type: "userMessage", payload: { content: [{ type: "text", text: first }], clientId: "leading" } },
      { id: "working", type: "commandExecution", payload: { command: "synthetic check", status: "completed" } },
      { id: "realtime-delegation-next", type: "userMessage", payload: { content: [{ type: "text", text: later }], clientId: "next" } },
    ],
  }],
};
const snapshot = projectTimeline(source, createDefaultTimelineProjectorRegistry());
const Transcript = webBuiltinTimelineRendererComponents.realtimeTranscript;
const blocks = snapshot.frames.flatMap(frame => frame.blocks).filter(block => block.type === "realtime-transcript");
createIntlTestRoot(root).render(<main>{blocks.map(block => <Transcript key={block.id} block={block} richText={true} />)}</main>);

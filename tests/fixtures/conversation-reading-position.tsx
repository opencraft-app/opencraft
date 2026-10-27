import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot } from "./intl-root";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation, type ConversationRestoreSnapshot } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const code = (word: string) => `const value = "${word.repeat(220)}";`;
const table = (tail = "") => `| ${Array.from({length: 12}, (_, i) => "Column " + i).join(" | ")} |\n| ${Array.from({length: 12}, () => "---").join(" | ")} |\n| ${Array.from({length: 12}, (_, i) => "Reader cell " + i + " details").join(" | ")} |${tail}`;
const source = (tail = "", replaced = false) => `Reader.\n\n\`\`\`typescript\n${code(replaced ? "other" : "wide")}${tail}\n\`\`\`\n\n\`\`\`text\n${code("second")}\n\`\`\`\n\n${table(tail ? "\n| " + Array.from({length: 12}, () => "Append").join(" | ") + " |" : "")}`;
const snapshots = new Map<string, ConversationRestoreSnapshot>();
function Demo() {
 const [scope, setScope] = useState("A");
 const [visible, setVisible] = useState(true);
 const [generation, setGeneration] = useState(0);
 const [tail, setTail] = useState("");
 const [replaced, setReplaced] = useState(false);
 const [fresh, setFresh] = useState(false);
 const [revision, setRevision] = useState(0);
 (window as any).readerFixture = {
  theme: setThemePreference,
  hide() { setVisible(false); },
  show(next = scope, isFresh = false) { setScope(next); setFresh(isFresh); setGeneration(n => n + 1); setVisible(true); },
  append() { setTail(t => t + "\n// appended source"); },
  replace() { setReplaced(true); },
  snapshots() { return [...snapshots]; },
 };
 for(const key of ["theme", "hide", "show", "append", "replace"]) {
  const fn = (window as any).readerFixture[key];
  (window as any).readerFixture[key] = (...args: any[]) => { setRevision(n => n + 1); fn(...args); };
 }
 const timeline = projectTimeline({ key: createConversationKey("fixture", scope), revision, authoritative: true, phase: "live", turns: [{id: "turn", status: "complete", items: [{id: "answer", type: "agentMessage", payload: {text: source(tail, replaced), phase: "final_answer"}}]}]}, createDefaultTimelineProjectorRegistry());
 return <main data-revision={revision} style={{height: "100dvh", width: "100%"}}><button data-focus-guard>Keep focus</button><div style={{height: "calc(100% - 32px)"}}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>{visible ? <Conversation key={scope + generation} scrollPolicy="natural" timeline={timeline} initialRestoreSnapshot={fresh ? null : snapshots.get(scope)} onRestoreSnapshotChange={snapshot => snapshots.set(scope, snapshot)} /> : null}</TimelineBlockRendererProvider></div></main>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);

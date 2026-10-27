import React, { useState } from "react";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceItem } from "@opencraft/chat-core";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import { createIntlTestRoot } from "./intl-root";
import styles from "../../apps/workbench-web/src/styles/app.scss?inline";

const root = document.getElementById("root")!;
const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
root.className = "opencraft-embedded-workbench-root";
root.style.cssText = "padding:16px;max-width:860px;margin:auto;--color-text:#21272b;--color-text-tertiary:#77818a;--color-background-surface:white;--opencraft-chat-font-size:15px;display:flex;flex-direction:column;gap:20px";
const name = "受众😀.md", path = "/host/attachments/file/content-note.md";
const text = (value: string) => ({ type: "text", text: value });
const mention = { type: "mention", name, path };
const locator = `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
const staged = (message: string) => [text(message), { ...text(locator), text_elements: [{ placeholder: "opencraft:staged-file:v1", byte_range: { start: 0, end: new TextEncoder().encode(locator).length } }] }, mention];
const server = (id: string, clientId: string, content: unknown, attached = false): TimelineSourceItem => ({ id, type: "userMessage", payload: { clientId, content, ...(attached ? { attachments: [{ id: "durable-file", name, path, mimeType: "text/markdown" }] } : {}) } });
const phases = ["composer", "acknowledged", "staged", "steering-pending", "steering-accepted", "duplicate-echo", "saved-client", "saved-span", "saved-steer"] as const;
function Fixture() {
  const [phase, setPhase] = useState<(typeof phases)[number]>("composer");
  const index = phases.indexOf(phase);
  const items: TimelineSourceItem[] = index === 0 ? [] : [server("primary-server", "primary", index >= 2 ? staged("Inspect the file") : [text("ordinary echo must not win")], index >= 2)];
  if (index >= 3) items.push({ id: "work", type: "agentMessage", payload: { text: "Working" } }, { id: "local-steer", type: "steeringUserMessage", payload: { clientUserMessageId: "steer", status: index >= 4 ? "accepted" : "pending", input: [text("Also check mobile"), mention] } });
  if (index >= 4) items.push(server("steer-server", "steer", staged("Also check mobile"), true));
  if (index >= 5) items.push(server("steer-server-latest", "steer", staged("Also check mobile"), true), { id: "marker", type: "steered", payload: {} });
  const saved = phase.startsWith("saved-");
  if (saved) {
    const content = staged("Inspect the file").map(part => {
      if (phase !== "saved-span" || !("text_elements" in part)) return part;
      const { text_elements, ...textPart } = part;
      return { ...textPart, textElements: text_elements.map(({ byte_range, ...span }) => ({ ...span, byteRange: byte_range })) };
    });
    items.splice(0, items.length, ...(phase === "saved-steer" ? [
      { id: "saved-steer", type: "steeringUserMessage", payload: { content: [text("Saved steer")], status: "accepted" } },
      server("saved-steer-echo", "", [text("Saved steer")]),
    ] : [server("primary-server", "primary", content)]));
  }
  const params = phase === "saved-steer" ? undefined : phase === "saved-client"
    ? { input: [text("Inspect the file"), mention], clientId: "primary" }
    : { input: [text("Inspect the file"), mention], clientUserMessageId: "primary" };
  const snapshot = projectTimeline({ key: createConversationKey("fixture", "normalization"), revision: index, phase: "live", authoritative: true, turns: [{ id: "turn", status: "streaming", params, items }] }, createDefaultTimelineProjectorRegistry());
  (window as any).messageAnchors = [...snapshot.anchorFrameIds.keys()];
  const messages = snapshot.frames.flatMap(frame => frame.blocks).filter(block => block.type === "user-message");
  return <>
    <nav aria-label="Synthetic phases" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{phases.map(value => <button key={value} onClick={() => setPhase(value)}>{value}</button>)}</nav>
    <main data-phase={phase}>{messages.map(block => <section key={block.id} data-client={block.clientId} data-sources={JSON.stringify(block.sourceItemIds)}><UserMessageBlock block={block} /></section>)}</main>
  </>;
}
createIntlTestRoot(root).render(<WorkbenchPresentationRootProvider target={root}>
  <ConversationDocumentContext.Provider value={{ conversationId: "fixture", cwd: "/workspace", hostId: "fixture", theme: "light", onOpenResource: target => { document.documentElement.dataset.opened = target; } }}><Fixture /></ConversationDocumentContext.Provider>
</WorkbenchPresentationRootProvider>);

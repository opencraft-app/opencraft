import React, { useState } from "react";
import { createTurnChangeSummary } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties, frostThemePalette } from "@opencraft/design-system/theme-engine";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { TurnDiffBlock } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" || params.get("theme") === "frost" ? "dark" : "light";
const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme, params.get("theme") === "frost" ? frostThemePalette[theme] : undefined))) document.documentElement.style.setProperty(key, value);
if (params.get("touch")) document.documentElement.dataset.touchInteraction = "true";

function file(path: string, added: number, removed: number) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, () => "-old"), ...Array.from({ length: added }, () => "+new")].join("\n");
}
const path = "src/components/conversation/turn-diff-resource.tsx";
const diff = [file(path, 9, 1), file("docs/design.md", 2, 0), file("assets/client.css", 0, 3), file(`directory/${"very-long-filename-".repeat(12)}.js`, 12, 0)].join("\n");

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [hasChanges, setHasChanges] = useState(true);
  const current = revision === 0 ? diff : diff + "\n" + file(path, revision * 2, 0);
  const cards = {
    live: createTurnChangeSummary("live", "streaming", current)!,
    multiple: createTurnChangeSummary("multiple", "complete", current)!,
    single: createTurnChangeSummary("single", "complete", file("src/main.ts", 2, 0))!,
    large: createTurnChangeSummary("large", "complete", file("large.js", 5_001, 0))!,
    binary: createTurnChangeSummary("binary", "complete", "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ")!,
    mixed: createTurnChangeSummary("mixed", "complete", file("small.js", 1, 0) + "\n" + file("large.js", 5_001, 0))!,
  };
  return <main style={{ padding: 16, maxWidth: 760, margin: "0 auto", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 24 }}>
    <button id="update" onClick={() => setRevision(revision + 1)}>Update resource</button>
    <button id="clear" onClick={() => setHasChanges(!hasChanges)}>Toggle resource</button>
    <ConversationDocumentContext.Provider value={{ conversationId: "fixture", cwd: "/workspace", hostId: "fixture", theme,
      onReviewTurnDiff: (block, selected) => { document.documentElement.dataset.review = `${block.id}:${selected ?? "all"}`; },
      onOpenResource: (target) => { document.documentElement.dataset.openFile = target; } }}>
      {hasChanges ? Object.entries(cards).map(([name, block]) => <div data-card={name} key={name}><TurnDiffBlock block={block} /></div>) : null}
    </ConversationDocumentContext.Provider>
    <ConversationDocumentContext.Provider value={{ conversationId: "fixture", cwd: null, hostId: "fixture", theme }}>
      <div data-card="readonly"><TurnDiffBlock block={cards.single} /></div>
    </ConversationDocumentContext.Provider>
  </main>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, locale).render(<Fixture />);

import React, { useState } from "react";
import type { TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TurnDiffBlock } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
function Fixture() {
  const [counts, setCounts] = useState([66, 0]);
  Object.assign(window, { updateCounts: setCounts });
  const block: TurnDiffTimelineBlock = { id: "diff", type: "turn-diff", sourceItemIds: ["diff"], status: "running", unifiedDiff: "",
    additions: counts[0]!, deletions: counts[1]!, files: [{ path: "example.ts", additions: counts[0]!, deletions: counts[1]! }] };
  return <div style={{ padding: 32 }}><TurnDiffBlock block={block} /></div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);

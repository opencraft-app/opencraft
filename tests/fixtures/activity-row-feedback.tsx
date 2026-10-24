import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityDisclosure } from "../../apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure";
import { ActivitySummaryRow } from "../../apps/workbench-web/src/components/conversation-renderers/activity/activity-summary-row";
import { AgentActivityGroupDisclosure } from "../../apps/workbench-web/src/components/agent-activity-group-disclosure";
import { TerminalActivityIcon } from "../../apps/workbench-web/src/components/activity-glyphs";
import "../../apps/workbench-web/src/styles/app.scss";
import { buildOpenCraftThemeCssProperties, opencraftNeutralThemePalette } from "../../packages/design-system/src/theme-engine";

const mode = new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = mode;
for (const [name, value] of Object.entries(buildOpenCraftThemeCssProperties(mode, opencraftNeutralThemePalette[mode]))) {
  document.documentElement.style.setProperty(name, value);
}
const command = "python3 - <<'PY' from pathlib import Path; print('long running command 中文状态') " .repeat(6);

function Demo() {
  const [running, setRunning] = useState(false);
  const [summaryKey, setSummaryKey] = useState("initial");
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setRunning(value => !value)}>Toggle running</button>
    <button onClick={() => { setSummaryKey("next"); setRunning(false); }}>Settle with deferred label</button>
    <p data-row="body">正文与执行记录 / Conversation and process summaries</p>
    <section data-row="disclosure"><ActivityDisclosure icon={<TerminalActivityIcon />} summary="Running command"
      running={running} open={open} onOpenChange={setOpen}><p>Output</p></ActivityDisclosure></section>
    <section data-row="summary"><ActivitySummaryRow icon={<TerminalActivityIcon />} summary="Compacting context" running={running} /></section>
    <section data-row="long-command"><ActivitySummaryRow icon={<TerminalActivityIcon />} summary={`Running ${command}`} running={running} /></section>
    <section data-row="completed-command"><ActivitySummaryRow icon={<TerminalActivityIcon />} summary={`Ran ${command}`} /></section>
    <section data-row="group"><AgentActivityGroupDisclosure icon={<TerminalActivityIcon />} summary={summaryKey === "initial" ? "Initial summary" : "Next summary"}
      summaryKey={summaryKey} summaryTransition="deferred" running={running} hasRunningRows defaultExpanded>
      <p>Running child owns glyph motion</p>
    </AgentActivityGroupDisclosure></section>
  </>;
}
createRoot(document.getElementById("root")!).render(<Demo />);

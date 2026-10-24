import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityDisclosure } from "../../apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure";
import { ActivitySummaryRow } from "../../apps/workbench-web/src/components/conversation-renderers/activity/activity-summary-row";
import { AgentActivityGroupDisclosure } from "../../apps/workbench-web/src/components/agent-activity-group-disclosure";
import { TerminalActivityIcon } from "../../apps/workbench-web/src/components/activity-glyphs";
import "../../apps/workbench-web/src/styles/app.scss";

function Demo() {
  const [running, setRunning] = useState(false);
  const [summaryKey, setSummaryKey] = useState("initial");
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setRunning(value => !value)}>Toggle running</button>
    <button onClick={() => { setSummaryKey("next"); setRunning(false); }}>Settle with deferred label</button>
    <section data-row="disclosure"><ActivityDisclosure icon={<TerminalActivityIcon />} summary="Running command"
      running={running} open={open} onOpenChange={setOpen}><p>Output</p></ActivityDisclosure></section>
    <section data-row="summary"><ActivitySummaryRow icon={<TerminalActivityIcon />} summary="Compacting context" running={running} /></section>
    <section data-row="group"><AgentActivityGroupDisclosure icon={<TerminalActivityIcon />} summary={summaryKey === "initial" ? "Initial summary" : "Next summary"}
      summaryKey={summaryKey} summaryTransition="deferred" running={running} hasRunningRows defaultExpanded>
      <p>Running child owns glyph motion</p>
    </AgentActivityGroupDisclosure></section>
  </>;
}
createRoot(document.getElementById("root")!).render(<Demo />);

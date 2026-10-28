import React, { useCallback, useState } from "react";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { CommandBlock } from "../../apps/workbench-web/src/components/conversation-renderers/activity/command-and-review-renderers";
import { HistoryItemDetailContext } from "../../apps/workbench-web/src/components/conversation-renderers/render-contexts";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key,value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key,value);
const probe = window as unknown as { detailReads: number; completeDetail(): void; hide(): void; cancelled: boolean; disconnect(): void; reconnect(): void };
probe.detailReads = 0; probe.cancelled = false;
function Demo() {
  const [full,setFull] = useState(false), [visible,setVisible] = useState(true), [generation,setGeneration] = useState(0);
  probe.reconnect = () => setGeneration(value => value + 1);
  probe.hide = () => setVisible(false);
  const load = useCallback(async (ids: readonly string[], signal: AbortSignal) => {
    if (ids[0] !== "command") throw Error("Wrong Item");
    probe.detailReads++;
    await new Promise<void>((resolve,reject) => {
      probe.disconnect = () => reject(Object.assign(Error("disconnected"), {code:"ABORTED"}));
      probe.completeDetail = () => { setFull(true); resolve(); };
      signal.addEventListener("abort", () => { probe.cancelled=true; reject(Error("cancelled")); }, { once:true });
    });
  }, []);
  const timeline = projectTimeline({ key:createConversationKey("fixture","details"), revision:generation*2+(full?1:0), authoritative:true,phase:"live",
    turns:[{ id:"turn",status:"complete",items:[{id:"command",type:"commandExecution",payload:{id:"command",type:"commandExecution",command:"echo history",status:"completed",aggregatedOutput:full?"BEGIN\n" + "完整正文🙂\n".repeat(200) + "EXACT_COMPLETE_SUFFIX":null,...(!full?{historyDetail:{cursor:"epoch", readGeneration:generation}}:{})}}]}]},createDefaultTimelineProjectorRegistry());
  const block=timeline.frames[0]!.blocks[0]!;
  if(block.type!=="command-execution")throw Error("Wrong projection");
  return <HistoryItemDetailContext.Provider value={load}><main style={{padding:24}}>{visible?<CommandBlock block={block}/>:null}</main></HistoryItemDetailContext.Provider>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo/>);

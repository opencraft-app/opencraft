import React, { useState } from "react";
import type { TimelineBlock } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { createIntlTestRoot } from "./intl-root";
import { GeneratedImageBlock } from "../../apps/workbench-web/src/components/conversation-renderers/tool/tool-renderers";
import { ConversationDocumentContext } from "../../apps/workbench-web/src/components/conversation/document-context";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import "../../apps/workbench-web/src/styles/app.scss";

const root = document.getElementById("root")!;
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const probe = Object.assign(window as any, { imageHistory: { failFiles: false, requests: 0, releases: 0 } }).imageHistory;
type Image = Extract<TimelineBlock, { type: "image" }>;
function Demo() {
  const [image, setImage] = useState<Image>({type:"image",id:"image",sourceItemIds:[],uri:null,savedPath:"/synthetic/generated.png",generated:true,
    alt:null,transparentBackground:false,failure:null,status:"complete"});
  probe.set = (value: Partial<Image>) => setImage(previous => ({...previous,...value}));
  return <WorkbenchPresentationRootProvider target={root}><ConversationDocumentContext.Provider value={{
    conversationId:"fixture",hostId:"synthetic-host",cwd:"/synthetic",theme,
    loadMediaSource: async request => {
      probe.requests++;
      if(probe.failFiles) return null;
      const response=await fetch("/fixture-image",{signal:request.signal});
      const source=URL.createObjectURL(await response.blob());
      return {source,release:()=>{probe.releases++;URL.revokeObjectURL(source);}};
    },
  }}><GeneratedImageBlock block={image}/></ConversationDocumentContext.Provider></WorkbenchPresentationRootProvider>;
}
createIntlTestRoot(root).render(<Demo/>);

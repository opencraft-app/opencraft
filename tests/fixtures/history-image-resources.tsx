import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Context } from "@deepseek-ai/cordis";
import { BlobResourceService } from "@opencraft/blob-resources";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import { createAppServerMediaSourceLoader } from "../../apps/workbench-web/src/runtime/appserver-media-loader";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(BlobResourceService); await ctx.plugin(TimelineBlockRendererRegistryService); await ctx.plugin(BuiltinTimelineRendererPlugin);
const runtime = { resources: { host: { getConnectionGeneration: () => 1 } } } as any;
const loader = createAppServerMediaSourceLoader(runtime, ctx.blobResources, "fixture");
const registry = createDefaultTimelineProjectorRegistry(), root = document.getElementById("root")!, probe = window as any;
document.documentElement.dataset.theme = "light";
for (const [key,value] of Object.entries(buildOpenCraftThemeCssProperties("light"))) document.documentElement.style.setProperty(key,value);
document.head.insertAdjacentHTML("beforeend", "<style>html,body,#root{height:100%;margin:0}#root{background:var(--color-background-surface);color:var(--color-text)}textarea{margin:12px;width:calc(100% - 24px);box-sizing:border-box;font:inherit}</style>");
probe.fixture = { ready: false, detailReads: 0 };
const consumePendingLatestTurnSubmitPlacement = () => null;
function Demo() {
  const [turns,setTurns] = useState<any[]>([]), [draft,setDraft] = useState("");
  useEffect(() => { void fetch("/fixture-history" + location.search).then(r=>r.json()).then(setTurns); }, []);
  const detail = useCallback(async (ids: readonly string[],signal: AbortSignal) => {
    probe.fixture.detailReads++;
    const response = await fetch("/fixture-detail?item=" + encodeURIComponent(ids[0]!), { signal });
    if (!response.ok) throw Error("Detail unavailable");
    const item = await response.json();
    setTurns(previous=>previous.map(t=>({ ...t, items: t.items.map((old: any)=>old.id===item.id?item:old) })));
  }, []);
  const timeline = useMemo(() => turns.length ? projectTimeline({ key: createConversationKey("fixture","history"), revision:1, authoritative:true, phase:"live",
    turns:turns.map(t=>({ id:t.id, status:"complete", items:t.items.map((i:any)=>({ id:i.id,type:i.type,payload:i })) })) },registry):null,[turns]);
  const readyKey = useMemo(()=>({}),[turns]);
  return <WorkbenchPresentationRootProvider target={root}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation
    timeline={timeline} scrollPolicy="response-placement" threadDetailLevel="STEPS_COMMANDS" visibleContentReadyKey={readyKey}
    consumePendingLatestTurnSubmitPlacement={consumePendingLatestTurnSubmitPlacement}
    onVisibleContentReady={()=>{ if(turns.length)probe.fixture.ready=true; }} onLoadItemDetails={detail}
    documentContext={{ hostId:"fixture",conversationId:"history",theme:"light",cwd:null,loadMediaSource:loader }}
    footer={<textarea aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)}/>}/></TimelineBlockRendererProvider></WorkbenchPresentationRootProvider>;
}
createIntlTestRoot(root).render(<Demo/>);

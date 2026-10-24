import React, { useSyncExternalStore } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { ConversationRecoveryNotice } from "../../apps/workbench-web/src/components/conversation-recovery";
import { createConversationRecoveryDiagnostic, useConversationRecoveryDiagnostic } from "../../apps/workbench-web/src/runtime/conversation-recovery-diagnostic";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { reportRecoveryEvent } from "../../apps/workbench-web/src/runtime/recovery-diagnostics";
import "../../apps/workbench-web/src/styles/app.scss";
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const trace: Record<string, string | number>[] = [];
const progressTrace: unknown[] = [];
const runtime = createAppServerWorkbenchRuntime({hostId:"fixture",autoReconnect:true,reconnectDelaysMs:[500,1000,2000],requestTimeoutMs:2500,
  createTransport:()=>new WebSocketTransport({url:location.origin.replace(/^http/,"ws")+"/fixture-rpc"}),
  onRecoveryEvent:event=>{trace.push({...event});reportRecoveryEvent(event);},
});
runtime.subscribe(()=>progressTrace.push(runtime.getSnapshot().residentThreads.map(row=>row.recovery)));
await runtime.connect();
const lease = await runtime.acquireThread("s"); lease.setRecoveryVisibility(true);
(window as any).recovery = { trace, progressTrace, navigation:lease.getNavigation(), snapshot:lease.getSnapshot, revalidate:()=>lease.retryRestore(), loadOlder:()=>lease.loadOlder(), runtime:runtime.getSnapshot };
function Demo() {
 const host = useSyncExternalStore(runtime.subscribe,runtime.getSnapshot,runtime.getSnapshot);
 const state = useSyncExternalStore(lease.subscribe,lease.getSnapshot,lease.getSnapshot);
 const progress=host.phase!=="ready"?host.recovery:host.residentThreads.find(row=>row.threadId==="s")?.recovery;
 const diagnostic=useConversationRecoveryDiagnostic({scope:"fixture",failed:state.error!==null,active:!state.authoritative,stage:host.phase!=="ready"?"connection":"history",error:state.error,runtime:host.phase,transport:host.transport,progress});
 return <div style={{width:"100vw",height:"100vh",position:"relative","--thread-content-top-inset":"0px"} as React.CSSProperties} data-authoritative={String(state.authoritative)}>
 <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
 <Conversation timeline={state.timeline} threadDetailLevel="STEPS_PROSE" scrollPolicy="response-placement"
 footer={<textarea aria-label="Unsent draft" defaultValue="Draft preserved across recovery" />} />
 </TimelineBlockRendererProvider>
 {!state.authoritative ? <ConversationRecoveryNotice failed={state.error!==null} reconnecting={host.phase!=="ready"} diagnostic={diagnostic} /> : null}
 </div>;
}
createRoot(document.getElementById("root")!).render(<Demo />);

// Component boundary only: terminal diagnostic rendering does not invoke a Host.
(window as any).recovery.showErrorDiagnostic = () => {
 const target=document.createElement('div');target.id='copy-diagnostic-fixture';target.style.cssText='position:fixed;inset:20px;z-index:1000;background:var(--background,white);overflow:auto';document.body.append(target);
 const diagnostic={...createConversationRecoveryDiagnostic({stage:'history',runtime:'ready',error:{code:'TIMEOUT'},transport:{state:'open',attemptId:'11111111-1111-4111-8111-111111111111'}}),viewKey:'copy-fixture'};
 createRoot(target).render(<ConversationRecoveryNotice failed reconnecting={false} diagnostic={diagnostic} />);
};

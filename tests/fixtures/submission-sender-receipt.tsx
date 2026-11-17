import React from "react";
import { createWebChatRenderRuntime, WebChatRenderRuntimeProvider } from "@opencraft/chat-render-web";
import { createIntlTestRoot } from "./intl-root";
import { createConversationDisplayContinuity, selectConversationDisplay } from "@opencraft/workbench-runtime";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import type { MessageSender } from "@opencraft/appserver-protocol";
import { UserMessageBlock } from "../../apps/workbench-web/src/components/conversation/user-message";
import { WorkbenchPresentationRootProvider } from "../../apps/workbench-web/src/components/workbench-presentation-root";
import appStyles from "../../apps/workbench-web/src/styles/app.scss?inline";

const host = document.getElementById("host")!;
const shadow = host.attachShadow({mode:"open"});
const style = document.createElement("style"); style.textContent=appStyles.replaceAll(":root",":host");shadow.append(style);
const presentation=document.createElement("div");presentation.className="opencraft-embedded-workbench-root";
presentation.style.cssText="max-width:760px;margin:24px auto;padding:16px;--color-text:#21272b;--color-text-tertiary:#77818a;--color-background-surface:white";shadow.append(presentation);
const root=createIntlTestRoot(presentation);
const chatRendering=await createWebChatRenderRuntime();
const intent:SubmitIntent={commandId:"command",clientMessageId:"message",target:{type:"new-thread",draftId:"draft",execution:{hostId:"host",workspace:{cwd:null,runtimeWorkspaceRoots:[]}}},document:{version:1,blocks:[{type:"paragraph",children:[{type:"text",text:"Accepted input before native echo"}]}]},attachments:[],context:[],selections:{},options:{autoContext:false},createdAt:1};
const storage={load:async()=>null,save:async()=>{},remove:async()=>{}};
const fallback:MessageSender={kind:"employee",loginName:"legacy-fallback"};
const receipt:SubmissionReceipt={commandId:"command",clientMessageId:"message",hostId:"host",threadId:"thread",turnId:null,acceptedAt:1,replayed:false};
function paint(sender:MessageSender|null|undefined, echo=false){
 const continuity=createConversationDisplayContinuity({namespace:"receipt-browser",storage});
 continuity.retainSubmission(intent,{...receipt,...(sender===undefined?{}:{sender})},fallback);
 const submission=continuity.peekSubmission("host","thread")!;
 // Synthetic native data crosses the same display-authority selection as the real View.
 const canonical=echo?{...submission,authoritative:true,phase:"live" as const,frames:submission.frames.map(f=>({...f,blocks:f.blocks.map(b=>b.type==="user-message"?{...b,sender:null}:b)}))}:null;
 const selected=selectConversationDisplay({key:submission.key,timeline:canonical,cached:null,submission});
 const block=selected.timeline!.frames[0]!.blocks[0]!;
 if(block.type!=="user-message")throw Error("missing submitted message");
 root.render(<WebChatRenderRuntimeProvider runtime={chatRendering}><WorkbenchPresentationRootProvider target={presentation}><UserMessageBlock block={block}/></WorkbenchPresentationRootProvider></WebChatRenderRuntimeProvider>);
}
Object.assign(window,{paintReceipt:paint});
paint({kind:"employee",loginName:"verified-author"});

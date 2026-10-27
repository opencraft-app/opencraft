import { ExternalLinkIcon as ExternalLink } from "@opencraft/design-system-web/action-icons";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConversationReferenceProvider, type ConversationReferencePort } from "@opencraft/composer-editor";
import { encodeConversationRef, parseConversationRef, type ConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { createWorkbenchThreadLocation } from "@opencraft/workbench-runtime";
import { SettingsButton } from "@opencraft/extension-react";
import { useIntl } from "@opencraft/i18n/react";
import { ModalSurface } from "./modal";
import { useAsyncNotices } from "./async-notices";
import type { AppServerHostCatalog } from "../runtime/workbench-application-services";
import "./conversation-reference-surface.scss";
interface Entry { turnId:string; itemId:string; role:string; text:string; offset:number }
interface History { entries:Entry[]; nextCursor:string|null; truncated:boolean }
interface Target { reference:string; hostId:string }
export function ConversationReferenceSurface({catalog,hostId,children}:{catalog:AppServerHostCatalog;hostId:string;children:ReactNode}) {
  const intl=useIntl(), notices=useAsyncNotices();
  const [target,setTarget]=useState<Target|null>(null), [history,setHistory]=useState<History|null>(null);
  const [draft,setDraft]=useState(""),[pending,setPending]=useState(false),[loading,setLoading]=useState(false);
  const [requestId,setRequestId]=useState<string|null>(null),[delivery,setDelivery]=useState<string|null>(null);
  const activeTarget=useRef<Target|null>(null);
  const epoch=useRef(0),sendKey=useRef(crypto.randomUUID()),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;};},[]);
  const text=(id:string,defaultMessage:string)=>intl.formatMessage({id,defaultMessage});
  const failure=()=>notices.error({key:"conversation-reference",message:text("conversation.reference.unavailable","Could not confirm the operation. Keep your message and review the delivery before retrying.")});
  const command=useCallback((id:string,body:Record<string,unknown>)=>catalog.agentRuntimes.request(id,"opencraft/collaboration",body),[catalog.agentRuntimes]);
  const load=async (t:Target,cursor?:string)=>{
    const generation=++epoch.current; setLoading(true);
    try {const result=await command(t.hostId,{action:"read",reference:t.reference,...(cursor?{cursor}:{})});
      if(!mounted.current||generation!==epoch.current)return;
      const page=result.history as unknown as History;
      setHistory(previous=>cursor&&previous?{...page,entries:[...previous.entries,...page.entries]}:page);
    }catch{if(mounted.current&&generation===epoch.current)failure();}
    finally{if(mounted.current&&generation===epoch.current)setLoading(false);}
  };
  const open=useCallback((reference:string)=>{
    if(!parseConversationRef(reference))return;
    const t={reference,hostId};activeTarget.current=t;setTarget(t);setDraft("");setHistory(null);setRequestId(null);setDelivery(null);sendKey.current=crypto.randomUUID();void load(t);
  },[hostId,command,intl,notices]);
  const port=useMemo<ConversationReferencePort>(()=>({open,async search(query,signal){
    const source=query.target.type==="new-thread"?query.target.execution.hostId:query.target.key.hostId;
    if(!catalog.threadManagement.capabilities(source).reference)return [];
    const r=await command(source,{action:"discover",search:query.query});
    if(signal?.aborted)return [];
    return ((r.conversations??[]) as {ref:ConversationRef;title:string}[]).slice(0,query.limit).map(c=>({id:encodeConversationRef(c.ref),kind:"mention",label:c.title,detail:text("conversation.reference.label","Conversation"),uri:encodeConversationRef(c.ref),metadata:{mentionKind:"thread"}}));
  }}),[open,command,catalog.threadManagement,intl]);
  const navigate=async(reference:string,source:string)=>{
    const ref=parseConversationRef(reference);if(!ref)return;
    // A route/host hint never overrides resource identity.
    const r=await command(source,{action:"reference",threadId:ref.threadId});
    if(encodeConversationRef(r.ref as unknown as ConversationRef)!==encodeConversationRef(ref))throw Error("Different server");
    await catalog.navigate(createWorkbenchThreadLocation(source,ref.threadId));
  };
  const referenceAvailable=catalog.threadManagement.capabilities(hostId).reference===true;
  const boot=useRef(false);
  useEffect(()=>{
    if(boot.current||!referenceAvailable)return;
    const ref=parseConversationRef(window.location.href);if(!ref)return;boot.current=true;
    void navigate(encodeConversationRef(ref),hostId).catch(failure);
  },[hostId,referenceAvailable]);
  const send=async()=>{
    if(!target||pending||!draft.trim())return;setPending(true);
    const current=target;
    try{const r=await command(current.hostId,{action:"send",reference:current.reference,content:draft,idempotencyKey:sendKey.current});
      if(!mounted.current||current!==activeTarget.current)return;
      setRequestId(String(r.requestId));setDelivery("accepted");setDraft("");sendKey.current=crypto.randomUUID();
    }catch{if(mounted.current)failure();}finally{if(mounted.current)setPending(false);}
  };
  const status=async()=>{if(!target||!requestId)return;const current=target;try{const r=await command(current.hostId,{action:"delivery",requestId});if(mounted.current&&current===activeTarget.current)setDelivery(String(r.state));}catch{if(mounted.current&&current===activeTarget.current)failure();}};
  const statusText=delivery===null?null:delivery==="submitted"||delivery==="injected"?text("conversation.reference.submitted","The target accepted the message")
    :delivery==="cancelled"?text("conversation.reference.cancelled","Cancelled")
    :delivery==="rejected"?text("conversation.reference.rejected","The message could not be delivered")
    :delivery==="unknown"?text("conversation.reference.unknown","Delivery needs review")
    :text("conversation.reference.queued","Waiting for the target conversation");
  return <ConversationReferenceProvider value={port}><div style={{display:"contents"}} onClickCapture={event=>{
    const anchor=(event.target as Element).closest?.("a[href]");const href=anchor?.getAttribute("href");
    if(!href||!parseConversationRef(href))return;event.preventDefault();event.stopPropagation();open(href);
  }}>{children}</div>{target?<ModalSurface label={text("conversation.reference.label","Conversation")} onDismiss={()=>{if(pending)return;epoch.current++;activeTarget.current=null;setTarget(null);}} appearance="utility" className="conversation-reference-surface">
    <div className="conversation-reference-surface__heading"><h2>{text("conversation.reference.label","Conversation")}</h2><SettingsButton aria-label={text("conversation.reference.open","Open conversation")} title={text("conversation.reference.open","Open conversation")} onClick={()=>{void navigate(target.reference,target.hostId).then(()=>setTarget(null)).catch(failure);}}><ExternalLink size={16} aria-hidden="true" /></SettingsButton></div>
    <div className="conversation-reference-surface__history" aria-busy={loading}>
      {history?.entries.map(e=><div key={JSON.stringify([e.turnId,e.itemId,e.offset])}><small>{e.role==="user"?text("conversation.reference.user","User"):text("conversation.reference.assistant","Assistant")}</small><p>{e.text}</p></div>)}
      {!history?<SettingsButton disabled={loading} onClick={()=>{void load(target);}}>{loading?text("common.loading","Loading…"):text("common.retry","Retry")}</SettingsButton>:null}
      {history?.nextCursor?<SettingsButton disabled={loading} onClick={()=>{void load(target,history.nextCursor!);}}>{text("conversation.reference.more","Read more")}</SettingsButton>:null}
    </div>
    <form onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label={text("conversation.reference.message","Message to this conversation")} placeholder={text("conversation.reference.message","Message to this conversation")} maxLength={16384} value={draft} disabled={pending} onChange={e=>{setDraft(e.target.value);sendKey.current=crypto.randomUUID();}}/>
      <div className="conversation-reference-surface__actions"><span role="status">{statusText}</span>{requestId?<SettingsButton type="button" onClick={()=>{void status();}}>{text("conversation.reference.check","Check delivery")}</SettingsButton>:null}<SettingsButton variant="primary" type="submit" disabled={pending||!draft.trim()}>{pending?text("conversation.reference.sending","Sending…"):text("conversation.reference.send","Send message")}</SettingsButton></div>
    </form>
  </ModalSurface>:null}</ConversationReferenceProvider>;
}

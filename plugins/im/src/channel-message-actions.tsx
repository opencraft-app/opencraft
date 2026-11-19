import {combineAbortSignals} from '@opencraft/appserver-client/transport';
import {ConversationAvatar} from './channel-chat-ui';
import {useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {ModalContent} from '@opencraft/design-system-web/modal-content';
import {Button} from '@opencraft/design-system-web/button';
import {downloadBlob} from '@opencraft/design-system-web/download';
import {SettingsPanel,SettingsTextInput} from '@opencraft/extension-react';
import {useIntl} from '@opencraft/i18n/react';
import {createClientId} from '@opencraft/composer-core';
import type {ChannelMessage,ChannelSummary} from '@opencraft/appserver-protocol';
import type {ChannelsClient} from './channel-client';
import {messageFile,forwardChannelMessage,copyChannelImage} from './channel-message-transfer';
type Action='forward'|'download'|'copyImage'|'share';
type Selection={action:Action;message:ChannelMessage;keys:Map<string,string>};
/** Conversation-owned action lifetime survives row recycling; it never owns the composer draft. */
export function useChannelMessageActions({client,source,signal,active}:{client:ChannelsClient;source:string;signal:AbortSignal;active:boolean}){
 const intl=useIntl(),[selection,setSelection]=useState<Selection>(),[feedback,setFeedback]=useState(''),[groups,setGroups]=useState<ChannelSummary[]>(),[query,setQuery]=useState(''),[target,setTarget]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[file,setFile]=useState<File>();
 const owner=useRef<AbortController|undefined>(undefined),locked=useRef(false),activeRef=useRef(active);activeRef.current=active;
 const failed=()=>intl.formatMessage({id:'im.actions.failed',defaultMessage:'Could not complete this action. Check access and try again.'});
 function close(){owner.current?.abort();owner.current=undefined;locked.current=false;setSelection(undefined);setBusy(false);setError('');}
 useEffect(()=>()=>owner.current?.abort(),[source,signal]);
 useEffect(()=>{if(!active||signal.aborted)close();},[active,signal]);
 function begin(action:Action,message:ChannelMessage){
  if(!activeRef.current||signal.aborted)return;close();setFeedback('');setGroups(undefined);setTarget('');setQuery('');setFile(undefined);
  const current=new AbortController();owner.current=current;const request=combineAbortSignals([signal,current.signal]).signal,selected={action,message,keys:new Map<string,string>()};
  const present=()=>owner.current===current&&!request.aborted;
  const report=()=>{if(present()){setError(failed());setSelection(selected);setBusy(false);locked.current=false;}};
  if(action==='forward'){
   setSelection(selected);void client.list(request).then(value=>{if(present())setGroups(value.groups.filter(g=>g.canSend&&g.id!==source));},report);return;
  }
  const load=()=>messageFile(client,source,message,request);
  if(action==='share')setSelection(selected);
  let job:Promise<unknown>;
  try{job=action==='copyImage'?copyChannelImage(load,request):load().then(value=>{if(!present())return;if(action==='share'){setFile(value);if(!navigator.canShare?.({files:[value]}))setError(intl.formatMessage({id:'im.actions.shareUnavailable',defaultMessage:'This device cannot share this file. Download it instead.'}));}else downloadBlob(value,value.name);});}
  catch{report();return;}
  void job.then(()=>{if(present()&&action!=='share')setFeedback(intl.formatMessage(action==='copyImage'?{id:'common.copied',defaultMessage:'Copied'}:{id:'im.actions.downloadStarted',defaultMessage:'Download started'}));},report);
 }
 async function send(){
  const current=owner.current,s=selection;if(!s||!current||locked.current||!target||!activeRef.current)return;
  const combined=combineAbortSignals([signal,current.signal]),request=combined.signal;locked.current=true;setBusy(true);setError('');
  let key=s.keys.get(target);if(!key){key='forward:'+createClientId();s.keys.set(target,key);}
  try{await forwardChannelMessage(client,source,s.message,target,key,request);request.throwIfAborted();if(owner.current!==current)return;
   setFeedback(intl.formatMessage({id:'im.actions.forwarded',defaultMessage:'Forwarded. Check the destination for external delivery status.'}));close();
  }catch{if(owner.current===current&&!request.aborted){setError(failed());locked.current=false;setBusy(false);}}finally{combined.dispose();}
 }
 function share(){if(!file||locked.current||!owner.current||!activeRef.current)return;const current=owner.current;locked.current=true;setBusy(true);
  void navigator.share({files:[file]}).then(()=>{if(owner.current===current)close();},e=>{if(owner.current===current){locked.current=false;setBusy(false);if(e?.name!=='AbortError')setError(failed());}});
 }
 const title=intl.formatMessage(selection?.action==='forward'?{id:'im.actions.forward',defaultMessage:'Forward'}:selection?.action==='share'?{id:'im.actions.share',defaultMessage:'Share attachment…'}:{id:'im.actions.attachment',defaultMessage:'Attachment'});
 const dialog=selection?<Dialog.Root open onOpenChange={open=>{if(!open&&!locked.current)close();}}><ModalContent className="im-message-action-dialog" onEscapeKeyDown={event=>{if(locked.current)event.preventDefault();}} onInteractOutside={event=>{if(locked.current)event.preventDefault();}}><SettingsPanel title={<Dialog.Title asChild><span>{title}</span></Dialog.Title>} footer={<><Button variant="secondary" disabled={busy} onClick={close}>{intl.formatMessage({id:'common.cancel',defaultMessage:'Cancel'})}</Button>{selection.action==='forward'?<Button disabled={!target||busy} loading={busy} onClick={()=>void send()}>{intl.formatMessage({id:'im.actions.forward',defaultMessage:'Forward'})}</Button>:selection.action==='share'?<Button disabled={!file||busy||!navigator.canShare?.({files:[file]})} onClick={share}>{intl.formatMessage({id:'im.actions.shareNow',defaultMessage:'Share file'})}</Button>:null}</>}>
 <Dialog.Description className="im-message-action-description">{selection.action==='forward'?intl.formatMessage({id:'im.actions.disclosure',defaultMessage:'The destination members will be able to read the forwarded message or attachment.'}):intl.formatMessage({id:'im.actions.fileHint',defaultMessage:'Share or download the original attachment. A filename alone is not a copied file.'})}</Dialog.Description>
 <p className="im-message-action-preview">{selection.message.attachment?.name??selection.message.text}</p>
 {selection.action==='forward'?<><label htmlFor="im-forward-search">{intl.formatMessage({id:'im.actions.destination',defaultMessage:'Destination conversation'})}</label><SettingsTextInput id="im-forward-search" type="search" value={query} onChange={e=>setQuery(e.currentTarget.value)} disabled={busy}/><div className="im-message-action-destinations" role="group" aria-label={intl.formatMessage({id:'im.actions.destination',defaultMessage:'Destination conversation'})}>{groups===undefined?<p role="status">{intl.formatMessage({id:'common.loading',defaultMessage:'Loading…'})}</p>:groups.filter(g=>g.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(g=><Button key={g.id} variant="ghost" aria-pressed={target===g.id} disabled={busy} onClick={()=>setTarget(g.id)}><ConversationAvatar group={g}/><span className="im-message-action-destination-title">{g.title}</span></Button>)}{groups?.filter(g=>g.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length===0?<p>{intl.formatMessage({id:'im.actions.noDestination',defaultMessage:'No available conversation'})}</p>:null}</div></>:selection.action==='share'&&!file&&!error?<p role="status">{intl.formatMessage({id:'common.loading',defaultMessage:'Loading…'})}</p>:null}
 {error?<p role="alert" className="im-message-action-error">{error}</p>:null}{selection.action==='share'&&file?<Button variant="secondary" onClick={()=>downloadBlob(file,file.name)}>{intl.formatMessage({id:'im.actions.download',defaultMessage:'Download attachment'})}</Button>:null}{error&&(selection.action!=='forward'||groups===undefined)?<Button variant="secondary" onClick={()=>begin(selection.action,selection.message)}>{intl.formatMessage({id:'common.retry',defaultMessage:'Retry'})}</Button>:null}
 </SettingsPanel></ModalContent></Dialog.Root>:null;
 return{begin,dialog,feedback};
}

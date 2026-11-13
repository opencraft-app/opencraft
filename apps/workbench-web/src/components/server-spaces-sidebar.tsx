import { FocusScope } from "@radix-ui/react-focus-scope";
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { Button, IconButton } from '@opencraft/design-system-web/button';
import { NavigationList, NavigationItem } from '@opencraft/design-system-web/navigation';
import { ServerIcon, PeopleIcon, AddIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon } from '@opencraft/design-system-web/action-icons';
import { SettingsTextInput } from '@opencraft/extension-react';
import { DEFAULT_SERVER_SPACE, type ServerSpaceMember } from '@opencraft/appserver-protocol/server-spaces';
import type { ServerSpacesController } from '../runtime/use-server-spaces';
import './server-spaces-sidebar.scss';

type View = 'servers'|'create'|'members'|'join'|'invite';
export function ServerSpacesContent({controller,open,onSelected,onClose}:{controller:ServerSpacesController;open:boolean;onSelected(spaceId:string):void;onClose():void}) {
  const intl=useIntl(),inputId=useId();
  const [view,setView]=useState<View>('servers');
  const [name,setName]=useState(''),[code,setCode]=useState('');
  const [memberLists,setMemberLists]=useState<Record<string,ServerSpaceMember[]>>({});
  const members=memberLists[controller.selected]??[];
  const [busy,setBusy]=useState(false),[error,setError]=useState(false),[copied,setCopied]=useState(false);
  const [invitation,setInvitation]=useState<string|null>(null);
  const frame=useRef<HTMLDivElement>(null);
  const intent=useRef(0),mounted=useRef(true);
  const depth=view==='servers'?0:1;
  const space=controller.directory?.spaces.find(s=>s.id===controller.selected);
  const title=intl.formatMessage({id:'serverSpaces.title',defaultMessage:'Servers'});
  const backLabel=intl.formatMessage({id:'serverSpaces.back',defaultMessage:'Back'});
  useEffect(()=>()=>{mounted.current=false;intent.current++;},[]);
  useEffect(()=>{intent.current++;setView('servers');setName('');setMemberLists({});setInvitation(null);setError(false);setBusy(false);},[controller.ownerKey]);
  useEffect(()=>{
    const heading=frame.current?.querySelector<HTMLElement>(`[data-server-depth="${depth}"] h2`);
    heading?.focus({preventScroll:true});
  },[view,depth]);
  const go=(next:View)=>{intent.current++;setError(false);setBusy(false);setView(next);};
  const back=()=>{if(depth>0)go('servers');else onClose();};
  const run=async(action:(current:()=>boolean)=>Promise<void>)=>{
    if(busy)return;const current=++intent.current;setBusy(true);setError(false);
    try {await action(()=>mounted.current&&intent.current===current);}catch {if(mounted.current&&intent.current===current)setError(true);}
    finally {if(mounted.current&&intent.current===current)setBusy(false);}
  };
  const choose=(id:string)=>run(async()=>{if(await controller.select(id)){go('servers');onSelected(id);}});
  const showMembers=()=>{go('members');void run(async current=>{const list=await controller.members(controller.selected);if(current())setMemberLists(previous=>({...previous,[controller.selected]:list}));});};
  const invite=()=>{go('invite');setInvitation(null);setCopied(false);void run(async current=>{
    const result=await controller.command({action:'invite',spaceId:controller.selected}) as {code:string;expiresAt:number};
    if(typeof result.code!=='string'||!Number.isFinite(result.expiresAt))throw new Error('Invalid invitation');
    const url=new URL(window.location.href);url.search='';url.hash='';url.searchParams.set('serverInvite',result.code);
    if(current())setInvitation(url.href);
  });};
  // Invitation links are consumed by an explicitly authenticated Server RPC. They
  // never supply an Actor ID, authenticate a person, or auto-accept membership.
  useEffect(()=>{
    const token=new URL(window.location.href).searchParams.get('serverInvite');
    if(token){setCode(token);setView('join');}
  },[]);
  const create=()=>run(async()=>{
    const result=await controller.command({action:'create',name}) as {spaceId:string};
    if(await controller.select(result.spaceId)){setName('');go('servers');onSelected(result.spaceId);}
  });
  const join=()=>run(async()=>{
    let token=code.trim();try{token=new URL(token).searchParams.get('serverInvite')??token;}catch{/* Raw invitation code. */}
    const result=await controller.command({action:'join',code:token}) as {spaceId:string};
    if(await controller.select(result.spaceId)){setCode('');go('servers');onSelected(result.spaceId);}
  });

  const heading=view==='create'?intl.formatMessage({id:'serverSpaces.create',defaultMessage:'Create Server'}):view==='join'
    ?intl.formatMessage({id:'serverSpaces.join',defaultMessage:'Join Server'}):view==='invite'
      ?intl.formatMessage({id:'serverSpaces.invite',defaultMessage:'Invite members'}):intl.formatMessage({id:'serverSpaces.members',defaultMessage:'Members'});
  const surface=<div className="server-spaces" ref={frame} data-server-view={view} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();back();}
  }}>
    <div className="server-spaces__track" style={{'--server-depth':depth} as CSSProperties}>
      <section className="server-spaces__panel" data-server-depth="0" inert={depth!==0} aria-hidden={depth!==0}>
        <div className="server-spaces__header"><h2 tabIndex={-1}>{title}</h2><IconButton variant="ghost" size="accessory" aria-label={backLabel} onClick={onClose}><ChevronLeftIcon/></IconButton></div>
        <NavigationList label={title} inset="sidebar" className="server-spaces__list">
          {controller.directory?.spaces.map(item=><NavigationItem key={item.id} aria-current={item.id===controller.selected?'page':undefined} disabled={busy} onClick={()=>choose(item.id)}>
            <ServerIcon size={18}/><span className="server-spaces__name">{item.name}<small>{intl.formatMessage({id:'serverSpaces.memberCount',defaultMessage:'{count, plural, one {# member} other {# members}}'},{count:item.memberCount})}</small></span>{item.id===controller.selected?<CheckIcon size={16}/>:null}
          </NavigationItem>)}
          <NavigationItem onClick={()=>go('create')}><AddIcon size={18}/><span>{intl.formatMessage({id:'serverSpaces.create',defaultMessage:'Create Server'})}</span></NavigationItem>
          <NavigationItem onClick={()=>go('join')}><PeopleIcon size={18}/><span>{intl.formatMessage({id:'serverSpaces.join',defaultMessage:'Join Server'})}</span></NavigationItem>
        </NavigationList>
        <div className="server-spaces__actions">
          <p>{space?.name??DEFAULT_SERVER_SPACE}</p>
          <Button variant="ghost" onClick={showMembers} contentLayout="row"><PeopleIcon size={17}/>{intl.formatMessage({id:'serverSpaces.members',defaultMessage:'Members'})}<ChevronRightIcon size={15}/></Button>
          {space?.role==='owner'?<Button variant="ghost" onClick={invite}>{intl.formatMessage({id:'serverSpaces.invite',defaultMessage:'Invite members'})}</Button>:null}
        </div>
        {controller.error?<p className="server-spaces__notice" role="status">{intl.formatMessage({id:'serverSpaces.loadFailed',defaultMessage:'Could not load Servers. Try again.'})}<Button variant="ghost" onClick={()=>void controller.refresh()}>{intl.formatMessage({id:'serverSpaces.retry',defaultMessage:'Try again'})}</Button></p>:null}
      </section>
      <section className="server-spaces__panel" data-server-depth="1" inert={depth!==1} aria-hidden={depth!==1}>
        <div className="server-spaces__header"><IconButton variant="ghost" size="accessory" aria-label={backLabel} onClick={back}><ChevronLeftIcon/></IconButton><h2 tabIndex={-1}>{heading}</h2></div>
        <div className="server-spaces__detail">
          {view==='create'?<form onSubmit={event=>{event.preventDefault();void create();}}>
            <p>{intl.formatMessage({id:'serverSpaces.createDescription',defaultMessage:'A shared space for your members, Agents and conversations.'})}</p>
            <label htmlFor={inputId}>{intl.formatMessage({id:'serverSpaces.name',defaultMessage:'Server name'})}</label>
            <SettingsTextInput id={inputId} value={name} onChange={event=>setName(event.target.value)} maxLength={80} autoComplete="off" disabled={busy}/>
            <Button type="submit" variant="primary" disabled={busy||!name.trim()} aria-busy={busy}>{intl.formatMessage({id:'serverSpaces.create',defaultMessage:'Create Server'})}</Button>
          </form>:null}
          {view==='members'?<><p>{space?.name}</p><ul className="server-spaces__members">{members.map(member=><li key={member.actorId}><PeopleIcon size={18}/><span>{member.displayName}<small>{intl.formatMessage(member.role==='owner'?{id:'serverSpaces.owner',defaultMessage:'Owner'}:{id:'serverSpaces.member',defaultMessage:'Member'})}</small></span>{space?.role==='owner'&&member.role!=='owner'?<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{await controller.command({action:'remove',spaceId:controller.selected,actorId:member.actorId});const list=await controller.members(controller.selected);setMemberLists(previous=>({...previous,[controller.selected]:list}));})}>{intl.formatMessage({id:'serverSpaces.remove',defaultMessage:'Remove'})}</Button>:null}</li>)}</ul></>:null}
          {view==='invite'?<><p>{intl.formatMessage({id:'serverSpaces.invitationDescription',defaultMessage:'Share this invitation with someone who can sign in to this deployment. It expires in 24 hours and can be accepted by one person.'})}</p><p>{intl.formatMessage({id:'serverSpaces.sharing',defaultMessage:'Members can access the Agents and shared conversations in this Server.'})}</p>{invitation?<><SettingsTextInput aria-label={intl.formatMessage({id:'serverSpaces.invitationLink',defaultMessage:'Invitation link'})} value={invitation} readOnly onFocus={event=>event.target.select()}/><Button variant="primary" onClick={()=>void run(async current=>{await navigator.clipboard.writeText(invitation);if(current())setCopied(true);})}>{intl.formatMessage(copied?{id:'serverSpaces.copied',defaultMessage:'Copied'}:{id:'serverSpaces.copy',defaultMessage:'Copy invitation'})}</Button></>:null}</>:null}
          {view==='join'?<form onSubmit={event=>{event.preventDefault();void join();}}><p>{intl.formatMessage({id:'serverSpaces.joinDescription',defaultMessage:'Sign in to this deployment, then enter an invitation link or code to join its Server.'})}</p><label htmlFor={`${inputId}-join`}>{intl.formatMessage({id:'serverSpaces.invitationLink',defaultMessage:'Invitation link'})}</label><SettingsTextInput id={`${inputId}-join`} value={code} onChange={event=>setCode(event.target.value)} autoComplete="off" disabled={busy}/><Button type="submit" variant="primary" disabled={busy||!code.trim()}>{intl.formatMessage({id:'serverSpaces.join',defaultMessage:'Join Server'})}</Button></form>:null}
          {busy?<p role="status">{intl.formatMessage({id:'serverSpaces.working',defaultMessage:'Working…'})}</p>:null}
          {error?<p role="alert">{intl.formatMessage({id:'serverSpaces.actionFailed',defaultMessage:'Could not complete this action. Check your access or invitation and try again.'})}</p>:null}
        </div>
      </section>
    </div>
  </div>;
  return open?<FocusScope asChild trapped loop onMountAutoFocus={event=>{event.preventDefault();frame.current?.querySelector<HTMLElement>(`[data-server-depth="${depth}"] h2`)?.focus({preventScroll:true});}} onUnmountAutoFocus={event=>event.preventDefault()}>{surface}</FocusScope>:surface;
}

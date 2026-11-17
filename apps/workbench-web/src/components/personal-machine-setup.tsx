import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {useIntl} from '@opencraft/i18n/react';
import {Button} from '@opencraft/design-system-web/button';
import {ServerIcon} from '@opencraft/design-system-web/action-icons';
import {SettingsListItem} from '@opencraft/extension-react';
import type {PersonalMachineCommand,PersonalMachinesDirectory} from '@opencraft/appserver-protocol/personal-machines';
export function PersonalMachineSetup({scope,request,onSelectMachine,onBusyChange,enabled=true}:{enabled?:boolean;scope:string;request(command:PersonalMachineCommand):Promise<PersonalMachinesDirectory&{command?:string}>;onSelectMachine?(id:string):Promise<void>|void;onBusyChange(busy:boolean):void}){
  const intl=useIntl(),live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const [command,setCommand]=useState('');
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[copied,setCopied]=useState(false);
  const query=useQuery({queryKey:['personal-machines',scope],enabled,queryFn:async()=>{const result=await request({action:'list'});if(!result||!Array.isArray(result.machines)||typeof result.hubId!=='string')throw new Error('Machine directory unavailable');return result;},retry:false,gcTime:0,refetchInterval:q=>q.state.error&&!q.state.data?false:3000});
  useEffect(()=>{setCommand('');setCopied(false);},[query.data?.enrollmentOrigin]);
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);onBusyChange(true);setFailed(false);try{await action();}catch{if(live.current)setFailed(true);}finally{if(live.current){setBusy(false);onBusyChange(false);}}};
  if(!query.data)return <section className="agent-history">
    <p role="status">{intl.formatMessage(query.isPending?{id:'personalMachines.loading',defaultMessage:'Loading remote machine setup…'}:{id:'personalMachines.unavailable',defaultMessage:'Remote machine setup is unavailable on this connection. Switch to your local OpenCraft or retry.'})}</p>
    {query.isError?<Button variant="secondary" onClick={()=>void query.refetch()}>{intl.formatMessage({id:'onboard.agent.retry',defaultMessage:'Retry'})}</Button>:null}
  </section>;
  return <section className="agent-history">

      <p>{intl.formatMessage({id:'personalMachines.personal',defaultMessage:'Machines connected here belong to you and are used in myself.'})}</p>
      <p>{intl.formatMessage({id:'personalMachines.currentServer',defaultMessage:'The command automatically includes this Server’s remote access address. Run it on the remote machine to connect back here.'})}</p>
      {!query.data.enrollmentOrigin?<p role="status">{intl.formatMessage({id:'personalMachines.noRemoteEntrance',defaultMessage:'This Server has no remote access entrance yet. A connection command will be available once remote access is ready.'})}</p>:null}
      <Button variant="secondary" disabled={busy||!query.data.enrollmentOrigin} loading={busy} onClick={()=>void run(async()=>{const result=await request({action:'create'});if(live.current){setCommand(result.command??'');setCopied(false);await query.refetch();}})}>{intl.formatMessage({id:'personalMachines.generate',defaultMessage:'Generate Bash command'})}</Button>
      {command?<><p>{intl.formatMessage({id:'personalMachines.commandHint',defaultMessage:'Run this private command on the remote machine within 15 minutes. Do not share it.'})}</p><pre className="agent-history__command"><code>{command}</code></pre>
        <Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{await navigator.clipboard.writeText(command);if(live.current)setCopied(true);})}>{intl.formatMessage(copied?{id:'personalMachines.copied',defaultMessage:'Copied'}:{id:'personalMachines.copy',defaultMessage:'Copy command'})}</Button></>:null}
      {query.data.machines.length?<ul className="agent-onboard__list">{query.data.machines.map(machine=><li className="personal-machine-row" key={machine.id}><div className="personal-machine-row__identity"><SettingsListItem icon={<ServerIcon size={18}/>} label={machine.name||intl.formatMessage({id:'personalMachines.pending',defaultMessage:'Waiting for connection'})}
        description={intl.formatMessage(machine.connected?{id:'personalMachines.online',defaultMessage:'Connected'}:machine.phase==='pending'?{id:'personalMachines.pending',defaultMessage:'Waiting for connection'}:{id:'personalMachines.offline',defaultMessage:'Offline'})}
        /></div><span className="personal-machine-row__actions"><Button variant="ghost" disabled={busy||!machine.connected||!onSelectMachine} onClick={()=>void run(async()=>{await onSelectMachine?.('personal:'+machine.id);})}>{intl.formatMessage({id:'personalMachines.agents',defaultMessage:'Choose Agents'})}</Button>
          <Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{await request({action:'revoke',id:machine.id});if(live.current){setCommand('');await query.refetch();}})}>{intl.formatMessage({id:'personalMachines.revoke',defaultMessage:'Revoke'})}</Button></span></li>)}</ul>:null}
      {failed?<p role="alert">{intl.formatMessage({id:'personalMachines.failed',defaultMessage:'Could not complete this action. Try again.'})}</p>:null}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import type { ReadyNativeAgent } from "../runtime/ready-native-agents";
import { useIntl } from '@opencraft/i18n/react';
import { Button } from './ui/button';
import './draft-setup-notice.scss';

/** An actionable projection of the selected Host; never owns a draft or connection. */
export function DraftSetupNotice({ kind, hostName, onConfigure, onRetry, onConnectionSettings, onConnectAgents, onConnectRemoteMachine, readyAgents = [], checkingAgents = false, agentCheckFailed = false, onRetryAgents, onUseAgent }: {
  readonly kind: 'models' | 'catalog-error' | 'connection';
  readonly hostName: string;
  readonly readyAgents?: readonly AgentChoice[];
  readonly checkingAgents?: boolean;
  readonly agentCheckFailed?: boolean;
  readonly onRetryAgents?: () => void;
  readonly onUseAgent?: (agent: AgentChoice) => Promise<void>;
  readonly onConfigure?: () => void;
  readonly onRetry: () => void;
  readonly onConnectionSettings: () => void;
  readonly onConnectAgents?: () => void;
  readonly onConnectRemoteMachine?: () => void;
}) {
  const intl = useIntl();
  return <section className="draft-setup-notice thread-layout-width" aria-label={intl.formatMessage({ id: 'welcome.nextStep', defaultMessage: 'Next step' })}>
    <p>{intl.formatMessage(kind === 'models' && readyAgents.length > 0
      ? { id: 'welcome.agents.available', defaultMessage: 'Your connected agents are ready. Choose one to start chatting.' }
      : kind === 'models' && checkingAgents
      ? { id: 'welcome.agents.checking', defaultMessage: 'Checking your connected agents…' }
      : kind === 'models' && agentCheckFailed
      ? { id: 'welcome.agents.failed', defaultMessage: 'Could not check your connected agents. Retry or check the machine connection.' }
      : kind === 'models'
      ? { id: 'welcome.models.required', defaultMessage: 'Set up a usable model on {host}, or select one that is already configured.' }
      : kind === 'catalog-error'
        ? { id: 'welcome.models.failed', defaultMessage: 'Could not load models from {host}. Try again.' }
        : { id: 'welcome.connection.failed', defaultMessage: 'Could not connect to {host}. Check the connection or retry.' }, { host: hostName })}</p>
    <div className="draft-setup-notice__actions">
      {kind === 'models' && onUseAgent ? readyAgents.map((agent,index) => <ReadyAgentButton variant={index === 0 ? "primary" : "secondary"} key={agent.hostId+':'+agent.modelId} agent={agent} onSelect={onUseAgent} />) : null}
      {kind === 'models' && readyAgents.length === 0 && !checkingAgents && !agentCheckFailed && onConfigure ? <Button variant="primary" onClick={onConfigure}>
        {intl.formatMessage({ id: 'welcome.local.configure', defaultMessage: 'Configure models' })}
      </Button> : null}
      {kind === 'models' && agentCheckFailed && !checkingAgents && readyAgents.length === 0 ? <Button variant="secondary" onClick={onRetryAgents}>{intl.formatMessage({id:'welcome.retry',defaultMessage:'Retry'})}</Button> : null}
      {kind !== 'models' ? <Button variant="secondary" onClick={onRetry}>
        {intl.formatMessage({ id: 'welcome.retry', defaultMessage: 'Retry' })}
      </Button> : null}
      {onConnectAgents && readyAgents.length === 0 && !checkingAgents && !agentCheckFailed ? <Button variant="secondary" onClick={onConnectAgents}>
        {intl.formatMessage({ id: 'onboard.agent.reopenAction', defaultMessage: 'Open agent setup' })}
      </Button> : null}
      {onConnectRemoteMachine && readyAgents.length === 0 && !checkingAgents && !agentCheckFailed ? <Button variant="secondary" onClick={onConnectRemoteMachine}>
        {intl.formatMessage({id:'personalMachines.connect',defaultMessage:'Connect remote machine'})}
      </Button> : null}
      <Button variant="ghost" onClick={onConnectionSettings}>
        {intl.formatMessage({ id: 'welcome.connection.settings', defaultMessage: 'Connection settings' })}
      </Button>
    </div>
  </section>;
}


type AgentChoice = ReadyNativeAgent & {hostId:string;hostName:string};
function ReadyAgentButton({agent,onSelect,variant}:{agent:AgentChoice;onSelect:(agent:AgentChoice)=>Promise<void>;variant:"primary"|"secondary"}) {
 const intl=useIntl(),live=useRef(true);const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 return <><Button variant={variant} loading={busy} onClick={()=>{setBusy(true);setFailed(false);void Promise.resolve().then(()=>onSelect(agent)).catch(()=>{if(live.current)setFailed(true);}).finally(()=>{if(live.current)setBusy(false);});}}>{intl.formatMessage({id:'welcome.agents.use',defaultMessage:'Use {agent} · {host}'},{agent:agent.agentName,host:agent.hostName})}</Button>{failed?<span role="alert">{intl.formatMessage({id:'welcome.agents.switchFailed',defaultMessage:'Could not switch to this agent. Your draft is kept. Try again.'})}</span>:null}</>;
}

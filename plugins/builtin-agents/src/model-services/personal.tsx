import {useIntl} from '@opencraft/i18n/react';
import {defineMessages} from '@opencraft/i18n';
import {useEffect,useRef,useState,type ComponentType} from 'react';
import * as Popover from '@radix-ui/react-popover';
import {SettingsButton,SettingsNotice,SettingsPageHeader,SettingsSelect,SettingsSwitch,SettingsTextInput,type ExtensionSettingsViewProps} from '@opencraft/extension-react';
import {BrandMark} from './brand-mark';
import {NavigationList,NavigationItem} from '@opencraft/design-system-web/navigation';

const personalMessages=defineMessages({
  "onlyMe": {
    "id": "modelServices.personal.onlyMe",
    "defaultMessage": "Only me"
  },
  "sharedForUse": {
    "id": "modelServices.personal.sharedForUse",
    "defaultMessage": "Shared for use"
  },
  "providedByPlatform": {
    "id": "modelServices.personal.providedByPlatform",
    "defaultMessage": "Provided by platform"
  },
  "backToMyModels": {
    "id": "modelServices.personal.backToMyModels",
    "defaultMessage": "Back to my models"
  },
  "modelServices": {
    "id": "modelServices.personal.modelServices",
    "defaultMessage": "Model services"
  },
  "modelConnections": {
    "id": "modelServices.personal.modelConnections",
    "defaultMessage": "Model connections"
  },
  "searchConnections": {
    "id": "modelServices.personal.searchConnections",
    "defaultMessage": "Search connections"
  },
  "addMyConnection": {
    "id": "modelServices.personal.addMyConnection",
    "defaultMessage": "Add my connection"
  },
  "add": {
    "id": "modelServices.personal.add",
    "defaultMessage": "Add"
  },
  "myModels": {
    "id": "modelServices.personal.myModels",
    "defaultMessage": "My models"
  },
  "noPersonalConnectionsYet": {
    "id": "modelServices.personal.noPersonalConnectionsYet",
    "defaultMessage": "No personal connections yet"
  },
  "platformModels": {
    "id": "modelServices.personal.platformModels",
    "defaultMessage": "Platform models"
  },
  "managePlatformConnections": {
    "id": "modelServices.personal.managePlatformConnections",
    "defaultMessage": "Manage platform connections"
  },
  "selectAConnection": {
    "id": "modelServices.personal.selectAConnection",
    "defaultMessage": "Select a connection"
  },
  "loadingModelConnections": {
    "id": "modelServices.personal.loadingModelConnections",
    "defaultMessage": "Loading model connections…"
  },
  "tryAgain": {
    "id": "modelServices.personal.tryAgain",
    "defaultMessage": "Try again"
  },
  "connectionMethod": {
    "id": "modelServices.personal.connectionMethod",
    "defaultMessage": "Connection method"
  },
  "enterAnAPIKey": {
    "id": "modelServices.personal.enterAnAPIKey",
    "defaultMessage": "Enter an API key"
  },
  "signInToACodexSubscription": {
    "id": "modelServices.personal.signInToACodexSubscription",
    "defaultMessage": "Sign in to a Codex subscription"
  },
  "myCodexSubscription": {
    "id": "modelServices.personal.myCodexSubscription",
    "defaultMessage": "My Codex subscription"
  },
  "onlyYouAndYourAssistantsCanUse": {
    "id": "modelServices.personal.onlyYouAndYourAssistantsCanUse",
    "defaultMessage": "Only you and your assistants can use this subscription. Available allowance is determined by the provider."
  },
  "openTheSignInPageAndEnter": {
    "id": "modelServices.personal.openTheSignInPageAndEnter",
    "defaultMessage": "Open the sign-in page and enter this code:"
  },
  "openSignInPage": {
    "id": "modelServices.personal.openSignInPage",
    "defaultMessage": "Open sign-in page"
  },
  "connectsAutomaticallyAfterSignIn": {
    "id": "modelServices.personal.connectsAutomaticallyAfterSignIn",
    "defaultMessage": "Connects automatically after sign-in."
  },
  "cancel": {
    "id": "modelServices.personal.cancel",
    "defaultMessage": "Cancel"
  },
  "signInAndConnect": {
    "id": "modelServices.personal.signInAndConnect",
    "defaultMessage": "Sign in and connect"
  },
  "name": {
    "id": "modelServices.personal.name",
    "defaultMessage": "Name"
  },
  "forExampleMyCodingModel": {
    "id": "modelServices.personal.forExampleMyCodingModel",
    "defaultMessage": "For example: My coding model"
  },
  "service": {
    "id": "modelServices.personal.service",
    "defaultMessage": "Service"
  },
  "model": {
    "id": "modelServices.personal.model",
    "defaultMessage": "Model"
  },
  "apiKey": {
    "id": "modelServices.personal.apiKey",
    "defaultMessage": "API key"
  },
  "availableTo": {
    "id": "modelServices.personal.availableTo",
    "defaultMessage": "Available to"
  },
  "youAndYourAssistantsCanUseThis": {
    "id": "modelServices.personal.youAndYourAssistantsCanUseThis",
    "defaultMessage": "You and your assistants can use this connection, but other people's tasks cannot."
  },
  "save": {
    "id": "modelServices.personal.save",
    "defaultMessage": "Save"
  },
  "connectionSettings": {
    "id": "modelServices.personal.connectionSettings",
    "defaultMessage": "Connection settings"
  },
  "connectionConfigured": {
    "id": "modelServices.personal.connectionConfigured",
    "defaultMessage": "Connection configured"
  },
  "enabled": {
    "id": "modelServices.personal.enabled",
    "defaultMessage": "Enabled"
  },
  "notEnabled": {
    "id": "modelServices.personal.notEnabled",
    "defaultMessage": "Not enabled"
  },
  "usersOnThisPlatform": {
    "id": "modelServices.personal.usersOnThisPlatform",
    "defaultMessage": "Users on this platform"
  },
  "change": {
    "id": "modelServices.personal.change",
    "defaultMessage": "Change"
  },
  "whoCanUseThis": {
    "id": "modelServices.personal.whoCanUseThis",
    "defaultMessage": "Who can use this"
  },
  "accessScope": {
    "id": "modelServices.personal.accessScope",
    "defaultMessage": "Access scope"
  },
  "otherPeopleCanSelectThisConnectionUpstream": {
    "id": "modelServices.personal.otherPeopleCanSelectThisConnectionUpstream",
    "defaultMessage": "Other people can select this connection. Upstream API charges are still billed to the account that owns your key."
  },
  "allowOthersToUse": {
    "id": "modelServices.personal.allowOthersToUse",
    "defaultMessage": "Allow others to use"
  },
  "modelList": {
    "id": "modelServices.personal.modelList",
    "defaultMessage": "Model list"
  },
  "available": {
    "id": "modelServices.personal.available",
    "defaultMessage": "Available"
  },
  "advancedSettings": {
    "id": "modelServices.personal.advancedSettings",
    "defaultMessage": "Advanced settings"
  },
  "serviceAddress": {
    "id": "modelServices.personal.serviceAddress",
    "defaultMessage": "Service address"
  },
  "subscriptionSignInOnlyMe": {
    "id": "modelServices.personal.subscriptionSignInOnlyMe",
    "defaultMessage": "Subscription sign-in · Only me"
  },
  "disableConnection": {
    "id": "modelServices.personal.disableConnection",
    "defaultMessage": "Disable connection"
  },
  "stopsFutureCallsRequestsAlreadySentWill": {
    "id": "modelServices.personal.stopsFutureCallsRequestsAlreadySentWill",
    "defaultMessage": "Stops future calls. Requests already sent will still be billed."
  },
  "disable": {
    "id": "modelServices.personal.disable",
    "defaultMessage": "Disable"
  },
  "noModelServicesAreCurrentlyAvailable": {
    "id": "modelServices.personal.noModelServicesAreCurrentlyAvailable",
    "defaultMessage": "No model services are currently available."
  },
  "myUsage": {
    "id": "modelServices.personal.myUsage",
    "defaultMessage": "My usage"
  },
  "myConnectionUsage": {
    "id": "modelServices.personal.myConnectionUsage",
    "defaultMessage": "My connection usage"
  },
  "usedThisMonth": {
    "id": "modelServices.personal.usedThisMonth",
    "defaultMessage": "Used this month"
  },
  "processingOrUnconfirmed": {
    "id": "modelServices.personal.processingOrUnconfirmed",
    "defaultMessage": "Processing or unconfirmed"
  },
  "tokens": {
    "id": "modelServices.personal.tokens",
    "defaultMessage": "tokens"
  },
  "usageLimit": {
    "id": "modelServices.personal.usageLimit",
    "defaultMessage": "Usage limit"
  },
  "controlsFutureRequestsByTokenCountNot": {
    "id": "modelServices.personal.controlsFutureRequestsByTokenCountNot",
    "defaultMessage": "Controls future requests by token count, not by monetary amount. A single request may exceed its reservation."
  },
  "noPlatformAllowanceConfigured": {
    "id": "modelServices.personal.noPlatformAllowanceConfigured",
    "defaultMessage": "No platform allowance configured"
  },
  "maximumMonthlyUsage": {
    "id": "modelServices.personal.maximumMonthlyUsage",
    "defaultMessage": "Maximum monthly usage"
  },
  "saveLimit": {
    "id": "modelServices.personal.saveLimit",
    "defaultMessage": "Save limit"
  },
  "refresh": {
    "id": "modelServices.personal.refresh",
    "defaultMessage": "Refresh"
  },
  "saving": {
    "id": "modelServices.personal.saving",
    "defaultMessage": "Saving…"
  },
  "monthlyTokens": {
    "id": "modelServices.personal.monthlyTokens",
    "defaultMessage": "{count} tokens / month"
  }
});

export interface PersonalModelConnection {
  kind?:'subscription'|'api-key'|'platform';id:string;name:string;baseUrl:string;protocol:string;enabled:boolean;owned:boolean;scope:'personal'|'team';revision:number;template:boolean;
  models:{id:string;name:string;enabled:boolean}[];
}
export interface PersonalModelsDocument {
  subscriptionAvailable?:boolean;actor:string;period:string;usedTokens:number;heldTokens:number;canManage:boolean;
  limit:{monthlyTokens:number;requestTokens:number;concurrency:number}|null;
  personalLimit:{monthlyTokens:number|null;revision:number};directory:PersonalModelConnection[];
}
const path='/__opencraft_model_gateway';
const errors:Record<string,string>={
  gateway_revision_conflict:'设置已在其他位置修改。请刷新后重试，当前输入已保留。',
  gateway_identity_changed:'登录状态已改变，请重新打开设置。',
  gateway_endpoint_not_approved:'这个服务或模型已不可用，请重新选择。',
  gateway_contribution_forbidden:'无法修改这条连接，请刷新后重试。',
  gateway_sharing_consent_required:'请确认是否允许其他人使用你的额度。',
};
export async function readPersonalModels(fetcher:typeof fetch=globalThis.fetch):Promise<PersonalModelsDocument> {
  const response=await fetcher(path,{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('无法读取我的模型，请稍后重试。');
  const document=await response.json();
  if(typeof document.actor!=='string'||!Array.isArray(document.directory)||!document.personalLimit)throw Error('我的模型暂不可用。');
  return document;
}
export function createPersonalModelServicesView(fetcher:typeof fetch=globalThis.fetch, PlatformView?:ComponentType<ExtensionSettingsViewProps>) {
  return function PersonalModelServicesView(_props:ExtensionSettingsViewProps) {
    const intl=useIntl();
    const [managePlatform,setManagePlatform]=useState(false);
    const [doc,setDoc]=useState<PersonalModelsDocument|null>(null),[selected,setSelected]=useState<string|null>(null);
    const [adding,setAdding]=useState(false),[name,setName]=useState(''),[templateId,setTemplateId]=useState(''),[modelId,setModelId]=useState(''),[key,setKey]=useState('');
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[query,setQuery]=useState('');
    const [scopeOpen,setScopeOpen]=useState(false),[scope,setScope]=useState<'personal'|'team'>('personal'),[consent,setConsent]=useState(false);
    const [connectionType,setConnectionType]=useState('api-key');
    const [login,setLogin]=useState<{sessionId:string;verificationUrl:string;userCode:string;expiresAt:number}|null>(null);
    const [limitDraft,setLimitDraft]=useState(''),[limitOpen,setLimitOpen]=useState(false);
    const lifetime=useRef(0),identity=useRef<string|null>(null),pending=useRef(false);
    const apply=(next:PersonalModelsDocument)=>{
      if(identity.current!==null && identity.current!==next.actor){setLogin(null);setKey('');setName('');setAdding(false);setSelected(null);setScopeOpen(false);setLimitOpen(false);}
      identity.current=next.actor;setDoc(next);
    };
    const refresh=async()=>{const epoch=lifetime.current;try{const next=await readPersonalModels(fetcher);if(epoch===lifetime.current){apply(next);setError('');}}catch(e){if(epoch===lifetime.current)setError((e as Error).message);}};
    useEffect(()=>{void refresh();return()=>{lifetime.current++;};},[]);
    const write=async(body:Record<string,unknown>,success?:(result:any)=>void)=>{
      if(pending.current)return;pending.current=true;setBusy(true);setError('');setMessage('');
      const epoch=lifetime.current,actor=identity.current;
      try {
        const response=await fetcher(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const result=await response.json();
        if(!response.ok)throw Error(errors[result.error]??'未能保存，请检查输入并重试。');
        const next=await readPersonalModels(fetcher);
        if(epoch!==lifetime.current)return;
        apply(next);
        if(next.actor!==actor){setError('登录状态已改变，请重新检查设置。');return;}
        success?.(result);setMessage(body.action==='subscription'?(result.status==='complete'?'订阅已连接':result.status==='pending'?'等待你完成登录':''): '已保存');
      }catch(e){if(epoch===lifetime.current)setError((e as Error).message);}
      finally{pending.current=false;if(epoch===lifetime.current)setBusy(false);}
    };
    const subscriptionResult=(result:any)=>{
      if(result.status==='complete'){setLogin(null);setSelected(result.providerId);setAdding(false);}
      else if(result.login)setLogin(result.login);
      else if(result.status==='error'){setLogin(null);setError('登录未完成，请重新登录。');}
    };
    useEffect(()=>{
      if(!login)return;
      const timer=setInterval(()=>{
        if(Date.now()>=login.expiresAt){setLogin(null);setError('登录已过期，请重新登录。');return;}
        void write({action:'subscription',operation:'poll',sessionId:login.sessionId},subscriptionResult);
      },3000);
      return()=>clearInterval(timer);
    },[login]);
    const connections=doc?.directory??[],templates=connections.filter(c=>c.template&&c.models.length);
    const connection=connections.find(c=>c.id===selected)??connections.find(c=>c.owned)??connections[0];
    const template=templates.find(c=>c.id===templateId)??templates[0],model=template?.models.find(m=>m.id===modelId)??template?.models[0];
    const visible=connections.filter(c=>c.name.toLowerCase().includes(query.toLowerCase()));
    const pick=(id:string)=>{setSelected(id);setAdding(false);setScopeOpen(false);setError('');setMessage('');};
    const add=()=>{setAdding(true);setScopeOpen(false);setError('');setMessage('');};
    const row=(c:PersonalModelConnection)=><NavigationItem key={c.id} className="model-services-personal__connection" aria-current={!adding&&connection?.id===c.id?"page":undefined} onClick={()=>pick(c.id)}><BrandMark kind="provider" id={c.id} size={24}/><span>{c.name}<small>{c.owned?(c.scope==='personal'?intl.formatMessage(personalMessages.onlyMe):intl.formatMessage(personalMessages.sharedForUse)):intl.formatMessage(personalMessages.providedByPlatform)}</small></span></NavigationItem>;
    if(managePlatform&&doc?.canManage&&PlatformView)return <div className="model-services-personal__platform"><SettingsButton variant="quiet" onClick={()=>setManagePlatform(false)}>{intl.formatMessage(personalMessages.backToMyModels)}</SettingsButton><PlatformView {..._props}/></div>;
    return <div className="model-services">
      <SettingsPageHeader title={intl.formatMessage(personalMessages.modelServices)}/>
      <aside className="model-services__navigation" aria-label={intl.formatMessage(personalMessages.modelConnections)}>
        <div className="model-services__search"><SettingsTextInput aria-label={intl.formatMessage(personalMessages.searchConnections)} placeholder={intl.formatMessage(personalMessages.searchConnections)} value={query} onChange={e=>setQuery(e.target.value)}/><SettingsButton aria-label={intl.formatMessage(personalMessages.addMyConnection)} disabled={!doc||busy||!templates.length&&!doc.subscriptionAvailable} onClick={add}>{intl.formatMessage(personalMessages.add)}</SettingsButton></div>
        <details open><summary className="ui-native-disclosure">{intl.formatMessage(personalMessages.myModels)}</summary><NavigationList label={intl.formatMessage(personalMessages.myModels)}>{visible.filter(c=>c.owned).map(row)}</NavigationList>{doc&&!connections.some(c=>c.owned)?<p className="model-services__muted">{intl.formatMessage(personalMessages.noPersonalConnectionsYet)}</p>:null}</details>
        <details open><summary className="ui-native-disclosure">{intl.formatMessage(personalMessages.providedByPlatform)}</summary><NavigationList label={intl.formatMessage(personalMessages.platformModels)}>{visible.filter(c=>!c.owned).map(row)}</NavigationList></details>
        {doc?.canManage&&PlatformView?<SettingsButton variant="quiet" disabled={busy} onClick={()=>setManagePlatform(true)}>{intl.formatMessage(personalMessages.managePlatformConnections)}</SettingsButton>:null}
      </aside>
      <div className="model-services__main">
        <div className="model-services__mobile-select"><SettingsSelect aria-label={intl.formatMessage(personalMessages.selectAConnection)} value={adding?'':connection?.id??''} onChange={e=>pick(e.target.value)}><option value="">{intl.formatMessage(personalMessages.selectAConnection)}</option>{connections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</SettingsSelect><SettingsButton aria-label={intl.formatMessage(personalMessages.addMyConnection)} disabled={!doc||busy||!templates.length&&!doc.subscriptionAvailable} onClick={add}>{intl.formatMessage(personalMessages.add)}</SettingsButton></div>
        <div className="model-services__detail">
          {!doc?<SettingsNotice>{error||intl.formatMessage(personalMessages.loadingModelConnections)}<SettingsButton disabled={busy} onClick={()=>void refresh()}>{intl.formatMessage(personalMessages.tryAgain)}</SettingsButton></SettingsNotice>:null}
          {doc&&adding?<section className="model-services__config" aria-label={intl.formatMessage(personalMessages.addMyConnection)}>
            <header><h2>{intl.formatMessage(personalMessages.addMyConnection)}</h2></header>
            {doc.subscriptionAvailable?<div className="model-services__row"><label htmlFor="personal-model-type">{intl.formatMessage(personalMessages.connectionMethod)}</label><SettingsSelect id="personal-model-type" value={connectionType} disabled={busy||!!login} onChange={e=>setConnectionType(e.target.value)}><option value="api-key">{intl.formatMessage(personalMessages.enterAnAPIKey)}</option><option value="subscription">{intl.formatMessage(personalMessages.signInToACodexSubscription)}</option></SettingsSelect></div>:null}
            {connectionType==='subscription'&&doc.subscriptionAvailable?<><div className="model-services__row"><div><label>{intl.formatMessage(personalMessages.myCodexSubscription)}</label><p>{intl.formatMessage(personalMessages.onlyYouAndYourAssistantsCanUse)}</p></div></div>
            {login?<SettingsNotice><p>{intl.formatMessage(personalMessages.openTheSignInPageAndEnter)}<strong>{login.userCode}</strong></p><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{intl.formatMessage(personalMessages.openSignInPage)}</a><p>{intl.formatMessage(personalMessages.connectsAutomaticallyAfterSignIn)}</p></SettingsNotice>:null}
            <div className="model-services__connection-actions"><SettingsButton disabled={busy} onClick={()=>{if(login)void write({action:'subscription',operation:'cancel',sessionId:login.sessionId},()=>{setLogin(null);setAdding(false);});else setAdding(false);}}>{intl.formatMessage(personalMessages.cancel)}</SettingsButton><SettingsButton variant="primary" disabled={busy||!!login} onClick={()=>void write({action:'subscription',operation:'start'},subscriptionResult)}>{intl.formatMessage(personalMessages.signInAndConnect)}</SettingsButton></div></>:<>
            <div className="model-services__row"><label htmlFor="personal-model-name">{intl.formatMessage(personalMessages.name)}</label><SettingsTextInput id="personal-model-name" value={name} disabled={busy} placeholder={intl.formatMessage(personalMessages.forExampleMyCodingModel)} onChange={e=>setName(e.target.value)}/></div>
            <div className="model-services__row"><label htmlFor="personal-model-service">{intl.formatMessage(personalMessages.service)}</label><SettingsSelect id="personal-model-service" disabled={busy} value={template?.id??''} onChange={e=>{setTemplateId(e.target.value);setModelId('');setKey('');}}>{templates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</SettingsSelect></div>
            <div className="model-services__row"><label htmlFor="personal-model-model">{intl.formatMessage(personalMessages.model)}</label><SettingsSelect id="personal-model-model" disabled={busy} value={model?.id??''} onChange={e=>setModelId(e.target.value)}>{template?.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</SettingsSelect></div>
            <div className="model-services__row"><div><label htmlFor="personal-model-key">{intl.formatMessage(personalMessages.apiKey)}</label><p>{template?.baseUrl}</p></div><SettingsTextInput id="personal-model-key" type="password" autoComplete="new-password" spellCheck={false} value={key} disabled={busy} onChange={e=>setKey(e.target.value)}/></div>
            <div className="model-services__row"><div><label>{intl.formatMessage(personalMessages.availableTo)}</label><p>{intl.formatMessage(personalMessages.youAndYourAssistantsCanUseThis)}</p></div><span>{intl.formatMessage(personalMessages.onlyMe)}</span></div>
            <div className="model-services__connection-actions"><SettingsButton disabled={busy} onClick={()=>{setAdding(false);setKey('');}}>{intl.formatMessage(personalMessages.cancel)}</SettingsButton><SettingsButton variant="primary" disabled={busy||!name.trim()||!key.trim()||!template||!model} onClick={()=>void write({action:'contribute',name,apiKey:key,baseUrl:template!.baseUrl,protocol:template!.protocol,model:model!.id,scope:'personal'},result=>{setKey('');setName('');setSelected(result.providerId);setAdding(false);})}>{intl.formatMessage(personalMessages.save)}</SettingsButton></div></>}
          </section>:doc&&connection?<>
            <section className="model-services__config" aria-label={intl.formatMessage(personalMessages.connectionSettings)}>
              <header><BrandMark kind="provider" id={connection.id} size={24}/><h2>{connection.name}</h2></header>
              <div className="model-services__connection-summary"><span>{connection.owned?intl.formatMessage(personalMessages.connectionConfigured): intl.formatMessage(personalMessages.providedByPlatform)} · {connection.enabled?intl.formatMessage(personalMessages.enabled):intl.formatMessage(personalMessages.notEnabled)}</span></div>
              {connection.owned?<div className="model-services__row"><div><label>{intl.formatMessage(personalMessages.availableTo)}</label>{connection.scope==='personal'?<p>{intl.formatMessage(personalMessages.youAndYourAssistantsCanUseThis)}</p>:null}</div><div className="model-services__row-end"><span>{connection.scope==='personal'?intl.formatMessage(personalMessages.onlyMe):intl.formatMessage(personalMessages.usersOnThisPlatform)}</span>
                {connection.kind!=='subscription'?<Popover.Root open={scopeOpen} onOpenChange={open=>{if(busy)return;setScopeOpen(open);if(open){setScope(connection.scope);setConsent(false);}}}><Popover.Trigger asChild><SettingsButton variant="quiet" disabled={busy}>{intl.formatMessage(personalMessages.change)}</SettingsButton></Popover.Trigger><Popover.Portal><Popover.Content className="model-services-actions model-services-personal__scope" align="end" sideOffset={6} collisionPadding={12} aria-label={intl.formatMessage(personalMessages.whoCanUseThis)}>
                  <strong>{intl.formatMessage(personalMessages.whoCanUseThis)}</strong><SettingsSelect aria-label={intl.formatMessage(personalMessages.accessScope)} value={scope} disabled={busy} onChange={e=>{setScope(e.target.value as 'personal'|'team');setConsent(false);}}><option value="personal">{intl.formatMessage(personalMessages.onlyMe)}</option><option value="team">{intl.formatMessage(personalMessages.usersOnThisPlatform)}</option></SettingsSelect>
                  {scope==='team'?<><p>{intl.formatMessage(personalMessages.otherPeopleCanSelectThisConnectionUpstream)}</p><div className="model-services__row"><span>{intl.formatMessage(personalMessages.allowOthersToUse)}</span><SettingsSwitch label={intl.formatMessage(personalMessages.allowOthersToUse)} checked={consent} disabled={busy} onCheckedChange={setConsent}/></div></>:<p>{intl.formatMessage(personalMessages.youAndYourAssistantsCanUseThis)}</p>}
                  <div className="model-services__connection-actions"><SettingsButton disabled={busy} onClick={()=>setScopeOpen(false)}>{intl.formatMessage(personalMessages.cancel)}</SettingsButton><SettingsButton variant="primary" disabled={busy||scope===connection.scope||scope==='team'&&!consent} onClick={()=>void write({action:'scope',provider:connection.id,scope,revision:connection.revision,shareWithTeam:scope==='team'},()=>setScopeOpen(false))}>{intl.formatMessage(personalMessages.save)}</SettingsButton></div>
                  {error?<SettingsNotice tone="error">{error}</SettingsNotice>:null}
                </Popover.Content></Popover.Portal></Popover.Root>:null}
              </div></div>:null}
            </section>
            <section className="model-services__models" aria-label={intl.formatMessage(personalMessages.modelList)}><div className="model-services__model-heading"><h3>{intl.formatMessage(personalMessages.model)}</h3></div>{connection.models.map(m=><div className="model-services__model" key={m.id}><BrandMark kind="model" id={m.id} size={32}/><div><strong>{m.name}</strong><small>{m.id}</small></div><span>{connection.enabled&&m.enabled?intl.formatMessage(personalMessages.available):intl.formatMessage(personalMessages.notEnabled)}</span></div>)}</section>
            <details className="model-services__advanced"><summary className="ui-native-disclosure">{intl.formatMessage(personalMessages.advancedSettings)}</summary><div className="model-services__row"><span>{connection.kind==='subscription'?intl.formatMessage(personalMessages.connectionMethod):intl.formatMessage(personalMessages.serviceAddress)}</span><span>{connection.kind==='subscription'?intl.formatMessage(personalMessages.subscriptionSignInOnlyMe):connection.baseUrl}</span></div>{connection.owned?<div className="model-services__row"><div><label>{intl.formatMessage(personalMessages.disableConnection)}</label><p>{intl.formatMessage(personalMessages.stopsFutureCallsRequestsAlreadySentWill)}</p></div><SettingsButton disabled={busy} onClick={()=>void write({action:'withdraw',provider:connection.id},()=>setSelected(null))}>{intl.formatMessage(personalMessages.disable)}</SettingsButton></div>:null}</details>
          </>:doc?<SettingsNotice>{intl.formatMessage(personalMessages.noModelServicesAreCurrentlyAvailable)}</SettingsNotice>:null}
          {doc&&!adding?<section className="model-services__config" aria-label={intl.formatMessage(personalMessages.myUsage)}><header><h3>{intl.formatMessage(personalMessages.myConnectionUsage)}</h3></header><div className="model-services__row"><span>{intl.formatMessage(personalMessages.usedThisMonth)}</span><span className="model-services__row-end">{doc.usedTokens.toLocaleString()}  {intl.formatMessage(personalMessages.tokens)}</span></div>{doc.heldTokens>0?<div className="model-services__row"><span>{intl.formatMessage(personalMessages.processingOrUnconfirmed)}</span><span className="model-services__row-end">{doc.heldTokens.toLocaleString()}  {intl.formatMessage(personalMessages.tokens)}</span></div>:null}<div className="model-services__row"><div><label>{intl.formatMessage(personalMessages.usageLimit)}</label><p>{intl.formatMessage(personalMessages.controlsFutureRequestsByTokenCountNot)}</p></div><div className="model-services__row-end"><span>{doc.limit?intl.formatMessage(personalMessages.monthlyTokens, { count: Math.min(doc.limit.monthlyTokens,doc.personalLimit.monthlyTokens??Infinity).toLocaleString() }):intl.formatMessage(personalMessages.noPlatformAllowanceConfigured)}</span><SettingsButton variant="quiet" disabled={busy||!doc.limit} onClick={()=>{setLimitDraft(String(doc.personalLimit.monthlyTokens??doc.limit?.monthlyTokens??0));setLimitOpen(!limitOpen);}}>{intl.formatMessage(personalMessages.change)}</SettingsButton></div></div>
          {limitOpen?<div className="model-services__row"><label htmlFor="personal-model-limit">{intl.formatMessage(personalMessages.maximumMonthlyUsage)}</label><div><SettingsTextInput id="personal-model-limit" type="number" min={0} step={1} value={limitDraft} disabled={busy} onChange={e=>setLimitDraft(e.target.value)}/><div className="model-services__connection-actions"><SettingsButton disabled={busy} onClick={()=>setLimitOpen(false)}>{intl.formatMessage(personalMessages.cancel)}</SettingsButton><SettingsButton disabled={busy||limitDraft.trim()===''||!Number.isSafeInteger(Number(limitDraft))||Number(limitDraft)<0} onClick={()=>void write({action:'personalLimit',monthlyTokens:Number(limitDraft),revision:doc.personalLimit.revision},()=>setLimitOpen(false))}>{intl.formatMessage(personalMessages.saveLimit)}</SettingsButton></div></div></div>:null}</section>:null}
          {error&&doc&&!scopeOpen?<SettingsNotice tone="error">{error}<SettingsButton disabled={busy} onClick={()=>void refresh()}>{intl.formatMessage(personalMessages.refresh)}</SettingsButton></SettingsNotice>:null}
          <p className="model-services__status" role="status">{busy?intl.formatMessage(personalMessages.saving):message}</p>
        </div>
      </div>
    </div>;
  };
}

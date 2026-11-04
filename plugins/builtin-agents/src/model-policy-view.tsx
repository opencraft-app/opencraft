import type { ModelListResponse } from '@opencraft/appserver-protocol';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsPanel, SettingsSection, SettingsGroup, SettingsRow, SettingsSwitch, SettingsButton, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import type { HostProtocolRequest } from './local-agent-settings-service';
type Rule={engine:string;model?:string;effort?:string};
type Document={canManage:boolean;revision:number;rules:Rule[]};
const path='/__opencraft_model_policy';
export async function readModelPolicy(fetcher:typeof fetch=globalThis.fetch) {const response=await fetcher(path,{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('Unable to load model restrictions');return await response.json() as Document;}
const engine=(id:string)=>id.startsWith('pi:')?'pi':id.startsWith('dsh-model:')?'dsh':id.startsWith('dsh-acp:')?'dsh-acp':id.startsWith('acp:')?'acp':'codex';
async function modelCatalog(request:HostProtocolRequest,hostId:string) {
 const models:any[]=[];let cursor:string|null=null;const seen=new Set<string>();
 do {const page:ModelListResponse=await request(hostId,'model/list',{cursor,limit:100,includeHidden:true});models.push(...page.data);cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw Error('Repeated model catalog cursor');seen.add(cursor);}}while(cursor);
 return models;
}
export function createModelPolicyView(request:HostProtocolRequest,hostId:string,fetcher:typeof fetch=globalThis.fetch) {
  return function ModelPolicyView(props:ExtensionSettingsViewProps){
    const lifetime=useRef(0);
    const intl=useIntl();const t=(id:string,defaultMessage:string)=>intl.formatMessage({id,defaultMessage});
    const [doc,setDoc]=useState<Document|null>(null),[rules,setRules]=useState<Rule[]>([]),[models,setModels]=useState<any[]>([]),[busy,setBusy]=useState(false);
    const error=()=>props.reportError?.({key:'model-policy',message:t('modelPolicy.error','Unable to save restrictions. Reload and try again.')});
    useEffect(()=>{let active=true;void Promise.all([readModelPolicy(fetcher),Promise.allSettled([...new Set([hostId,'local-codex'])].map(id=>modelCatalog(request,id)))]).then(([d,c])=>{if(active){setDoc(d);setRules(d.rules ?? []);setModels(c.flatMap(result=>result.status==='fulfilled'?result.value:[]));}}).catch(()=>{if(active)error();});return()=>{active=false;lifetime.current++;};},[]);
    if(!doc?.canManage)return null;
    const checked=(rule:Rule)=>rules.some(r=>JSON.stringify(r)===JSON.stringify(rule));
    const toggle=(rule:Rule,value:boolean)=>setRules(previous=>value?[...previous,rule]:previous.filter(r=>JSON.stringify(r)!==JSON.stringify(rule)));
    const save=async()=>{const generation=lifetime.current;setBusy(true);try{const response=await fetcher(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({revision:doc.revision,rules})});if(!response.ok)throw Error();const next=await response.json();if(generation===lifetime.current)setDoc(next);}catch{if(generation===lifetime.current)error();}finally{if(generation===lifetime.current)setBusy(false);}};
    const rows=[...new Map([...models.map(m=>({engine:engine(m.model ?? m.id),model:m.model ?? m.id,label:m.displayName ?? m.id})),...rules.filter(r=>r.model).map(r=>({engine:r.engine,model:r.model!,label:r.model!}))].map(m=>[m.model,m])).values()];
    const efforts=[...new Map([...models.flatMap(m=>(m.supportedReasoningEfforts ?? []).map((e:any)=>({engine:engine(m.model ?? m.id),effort:e.reasoningEffort}))),...rules.filter(r=>r.effort&&!r.model)].map(r=>[r.engine+':'+r.effort,{engine:r.engine,effort:r.effort!}])).values()];
    return <SettingsPanel title={t('modelPolicy.title','Model usage restrictions')}>
      <SettingsSection title={t('modelPolicy.models','Blocked models')}><SettingsGroup>{rows.map(m=>{const rule={engine:m.engine,model:m.model};return <SettingsRow key={m.model} label={m.label}><SettingsSwitch label={m.label} checked={checked(rule)} disabled={busy} onCheckedChange={v=>toggle(rule,v)}/></SettingsRow>;})}</SettingsGroup></SettingsSection>
      <SettingsSection title={t('modelPolicy.efforts','Blocked thinking levels')}><SettingsGroup>{efforts.map(r=>{const label=`${r.engine} · ${r.effort}`;return <SettingsRow key={label} label={label}><SettingsSwitch label={label} checked={checked(r)} disabled={busy} onCheckedChange={v=>toggle(r,v)}/></SettingsRow>;})}</SettingsGroup></SettingsSection>
      <SettingsButton disabled={busy} onClick={()=>void save()}>{t('modelPolicy.save','Save')}</SettingsButton>
    </SettingsPanel>;
  };
}

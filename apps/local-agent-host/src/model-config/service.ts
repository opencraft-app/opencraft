import {readFile} from 'node:fs/promises';
import type {ModelDocument} from './model-document.js';
import {ModelConfigurationRepository} from './repository.js';
import {providerRoute,type RoutedProvider} from './provider-route.js';

export interface ModelCredentialResolver {resolve(reference:string):Promise<string|undefined>}
/** Credential owner seen by an engine composition. Embedded mode: the local model SecretStore. Proxy mode: the
 * account Core, which accepts writes and answers `configured` but never returns a value (`resolve` refuses). */
export interface ModelCredentialPort {
  /** Changes whenever a credential that can affect this engine's projection changes. */
  stamp():Promise<string>;
  resolve(reference:string):Promise<string|undefined>;
  configured(reference:string):Promise<boolean>;
  set(reference:string,value:string):Promise<void>;
  remove(reference:string):Promise<void>;
}
export interface ModelEnginePort {apply(document:ModelDocument,credentials:ModelCredentialResolver):Promise<void>}
export interface ModelApplicationState {state:'pending'|'applied'|'failed';revision:number;error?:string}
/** Safe, actionable configuration failure; engine and credential details stay private. */
export class ModelConfigurationApplyError extends Error {}
/** Credential reference that resolves to this engine's proxy caller token instead of a provider key. */
export const PROXY_CALLER_REFERENCE='OPENCRAFT_PROXY_CALLER_TOKEN';
export interface ProxyCaller {readonly caller:string;readonly baseUrl:string;readonly token:string}
/** OPENCRAFT_PROXY_CALLER_FILE names the caller record published by the model proxy. Absent: embedded mode. */
export async function readProxyCaller(env:NodeJS.ProcessEnv=process.env):Promise<ProxyCaller|null>{
  const path=env.OPENCRAFT_PROXY_CALLER_FILE;if(!path)return null;
  const value=JSON.parse(await readFile(path,'utf8'));
  if(typeof value?.caller!=='string'||!value.caller.startsWith('caller:')||typeof value.token!=='string'||value.token.length<16
    ||typeof value.baseUrl!=='string'||!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/.test(value.baseUrl))throw new ModelConfigurationApplyError('模型代理调用凭据无效，请检查 proxy 服务。');
  return {caller:value.caller,baseUrl:value.baseUrl.replace(/\/$/,''),token:value.token};
}
export {PROXY_PROTOCOLS} from './provider-route.js';
/** How an engine reaches one provider when the deployment runs a model proxy.
 * - `proxy`: through the account Core, which resolves the real credential.
 * - `keyless`: the engine needs no credential (provider-route.ts).
 * - `rejected`: would require the engine to hold a provider key; refused with a user-facing reason. */
export type ProxyRouting={route:'proxy';baseUrl:string}|{route:'keyless'}|{route:'rejected';reason:string};
export function proxyRouting(p:RoutedProvider,caller:ProxyCaller):ProxyRouting{
  const decided=providerRoute(p);
  if(decided.route==='keyless')return decided;
  const name=p.name?.trim()||p.id;
  if(decided.route==='rejected')return {route:'rejected',reason:decided.why==='protocol'
    ?`“${name}”的连接协议不能经模型代理转发。当前部署不允许引擎直接持有模型密钥，请改用 OpenAI 兼容、OpenAI Responses 或 Anthropic Messages 连接。`
    :decided.why==='base-url'?`“${name}”没有填写服务地址。当前部署经模型代理调用模型，请填写该提供商的明确服务地址后再启用。`
    :`“${name}”的服务地址必须使用 HTTPS（或本机地址），模型代理才能转发。`};
  const route=caller.baseUrl+'/providers/'+encodeURIComponent(p.id);
  return {route:'proxy',baseUrl:p.protocol==='anthropic-messages'?route:route+'/v1'};
}
/** Proxy endpoint for a provider, or null when it is not reached through the proxy. */
export function proxyProviderUrl(p:RoutedProvider,caller:ProxyCaller):string|null{
  const routing=proxyRouting(p,caller);return routing.route==='proxy'?routing.baseUrl:null;
}
/** Execution projection only: routed providers point at the proxy with the caller token reference; rejected
 * providers are removed (never connected directly) and a default model on them is cleared. The saved document is
 * unchanged. */
export function proxyProjection(document:ModelDocument,caller:ProxyCaller):ModelDocument{
  const providers=document.providers.flatMap(p=>{const routing=proxyRouting(p,caller);
    return routing.route==='rejected'?[]:routing.route==='proxy'?[{...p,baseUrl:routing.baseUrl,credentialRef:PROXY_CALLER_REFERENCE}]:[p];});
  const defaultModel=document.defaultModel&&providers.some(p=>p.id===document.defaultModel!.providerId)?document.defaultModel:null;
  return {...document,providers,defaultModel};
}
/** Configuration-time refusal: an enabled provider that this proxy-mode engine could only use with a local key.
 * Unchanged providers saved before the switch are tolerated (excluded from execution) so old documents still load. */
export function assertProxyRoutable(previous:ModelDocument,next:ModelDocument,caller:ProxyCaller){
  for(const p of next.providers){
    if(!p.enabled)continue;
    const routing=proxyRouting(p,caller);if(routing.route!=='rejected')continue;
    const before=previous.providers.find(v=>v.id===p.id);
    if(before?.enabled&&JSON.stringify(before)===JSON.stringify(p))continue;
    throw new ModelConfigurationApplyError(routing.reason);
  }
  const d=next.defaultModel,p=d&&next.providers.find(v=>v.id===d.providerId),routing=p&&proxyRouting(p,caller);
  if(routing?.route==='rejected'&&JSON.stringify(previous.defaultModel)!==JSON.stringify(d))throw new ModelConfigurationApplyError(routing.reason);
}
export class ModelConfigurationService {
  application:ModelApplicationState={state:'pending',revision:-1};
  private tail:Promise<void>=Promise.resolve();
  private credentialStamp='';
  private appliedDocument: string | undefined;
  /** `caller` is fixed by the composition: present only in proxy mode, where `credentials` is the account Core port. */
  constructor(readonly repository:ModelConfigurationRepository,readonly credentials:ModelCredentialPort,private readonly engine:ModelEnginePort,readonly caller:ProxyCaller|null=null){}
  async synchronize(force=false){
    const operation=this.tail.then(async()=>{const latest=await this.repository.read();const stamp=await this.credentials.stamp();if(!force&&this.application.revision===latest.revision&&this.credentialStamp===stamp&&this.application.state!=='pending')return;
      try{const caller=this.caller;
        // Proxy mode resolves only the caller token: no provider key, no process environment fallback.
        await this.engine.apply(caller?proxyProjection(latest,caller):latest,{resolve:async reference=>caller?(reference===PROXY_CALLER_REFERENCE?caller.token:undefined):(await this.credentials.resolve(reference))??process.env[reference]});this.application={state:'applied',revision:latest.revision};this.appliedDocument=JSON.stringify(latest)}
      catch(error){this.application={state:'failed',revision:latest.revision,error:error instanceof ModelConfigurationApplyError?error.message:'配置已保存，但当前引擎未能应用。请检查配置后重试。'}}
      this.credentialStamp=stamp;
    });this.tail=operation.catch(()=>undefined);await operation;return this.application;
  }
  async appliedStateCurrent(){
    await this.tail;
    return this.application.state==='applied' && this.appliedDocument===JSON.stringify(await this.repository.read())
      && this.credentialStamp===await this.credentials.stamp();
  }
  async update(revision:number,change:(draft:ModelDocument)=>void){
    const caller=this.caller;
    const saved=await this.repository.update(revision,caller?draft=>{const previous=structuredClone(draft);change(draft);assertProxyRoutable(previous,draft,caller);}:change);
    await this.synchronize();return saved;
  }
}

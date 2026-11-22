import {readFile} from 'node:fs/promises';
import type {ModelDocument} from './model-document.js';
import {ModelConfigurationRepository,ModelCredentialRepository} from './repository.js';

export interface ModelCredentialResolver {resolve(reference:string):Promise<string|undefined>}
export interface ModelEnginePort {apply(document:ModelDocument,credentials:ModelCredentialResolver):Promise<void>}
export interface ModelApplicationState {state:'pending'|'applied'|'failed';revision:number;error?:string}
/** Safe, actionable configuration failure; engine and credential details stay private. */
export class ModelConfigurationApplyError extends Error {}
/** Credential reference that resolves to this engine's proxy caller token instead of a provider key. */
export const PROXY_CALLER_REFERENCE='OPENCRAFT_PROXY_CALLER_TOKEN';
export interface ProxyCaller {readonly caller:string;readonly baseUrl:string;readonly token:string}
/** OPENCRAFT_PROXY_CALLER_FILE names the caller record published by the model proxy. Absent: engines connect directly. */
export async function readProxyCaller(env:NodeJS.ProcessEnv=process.env):Promise<ProxyCaller|null>{
  const path=env.OPENCRAFT_PROXY_CALLER_FILE;if(!path)return null;
  const value=JSON.parse(await readFile(path,'utf8'));
  if(typeof value?.caller!=='string'||!value.caller.startsWith('caller:')||typeof value.token!=='string'||value.token.length<16
    ||typeof value.baseUrl!=='string'||!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/.test(value.baseUrl))throw new ModelConfigurationApplyError('模型代理调用凭据无效，请检查 proxy 服务。');
  return {caller:value.caller,baseUrl:value.baseUrl.replace(/\/$/,''),token:value.token};
}
/** Execution projection only: authenticated providers with an explicit endpoint are reached through the proxy,
 * which resolves the real credential. The saved document is unchanged. */
export function proxyProjection(document:ModelDocument,caller:ProxyCaller):ModelDocument{
  return {...document,providers:document.providers.map(p=>{const baseUrl=proxyProviderUrl(p,caller);return baseUrl?{...p,baseUrl,credentialRef:PROXY_CALLER_REFERENCE}:p;})};
}
/** Proxy endpoint for a provider, or null when it is reached directly (unauthenticated, catalog default endpoint,
 * human contribution/subscription, or a protocol the proxy does not pass through). */
export function proxyProviderUrl(p:{id:string;protocol:string;baseUrl?:string|null;credentialRef?:string|null;authentication?:string;catalogId?:string|null},caller:ProxyCaller):string|null{
  if(p.authentication==='none'||!p.credentialRef||!p.baseUrl||p.catalogId?.startsWith('opencraft-human-')||!['anthropic-messages','openai-responses'].includes(p.protocol))return null;
  const route=caller.baseUrl+'/providers/'+encodeURIComponent(p.id);
  return p.protocol==='anthropic-messages'?route:route+'/v1';
}
export class ModelConfigurationService {
  application:ModelApplicationState={state:'pending',revision:-1};
  private tail:Promise<void>=Promise.resolve();
  private credentialStamp='';
  private appliedDocument: string | undefined;
  constructor(readonly repository:ModelConfigurationRepository,readonly credentials:ModelCredentialRepository,private readonly engine:ModelEnginePort){}
  async synchronize(force=false){
    const operation=this.tail.then(async()=>{const latest=await this.repository.read();const stamp=await this.credentials.stamp();if(!force&&this.application.revision===latest.revision&&this.credentialStamp===stamp&&this.application.state!=='pending')return;
      try{const caller=await readProxyCaller();
        await this.engine.apply(caller?proxyProjection(latest,caller):latest,{resolve:async reference=>caller&&reference===PROXY_CALLER_REFERENCE?caller.token:(await this.credentials.resolve(reference))??process.env[reference]});this.application={state:'applied',revision:latest.revision};this.appliedDocument=JSON.stringify(latest)}
      catch(error){this.application={state:'failed',revision:latest.revision,error:error instanceof ModelConfigurationApplyError?error.message:'配置已保存，但当前引擎未能应用。请检查配置后重试。'}}
      this.credentialStamp=stamp;
    });this.tail=operation.catch(()=>undefined);await operation;return this.application;
  }
  async appliedStateCurrent(){
    await this.tail;
    return this.application.state==='applied' && this.appliedDocument===JSON.stringify(await this.repository.read())
      && this.credentialStamp===await this.credentials.stamp();
  }
  async update(revision:number,change:(draft:ModelDocument)=>void){const saved=await this.repository.update(revision,change);await this.synchronize();return saved;}
}

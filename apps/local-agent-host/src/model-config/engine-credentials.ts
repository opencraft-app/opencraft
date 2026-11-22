import {createHash} from 'node:crypto';
import {fileSecretStore} from '@opencraft/secret-storage/file';
import {validateSecretName,validateSecretValue} from '@opencraft/secret-storage';
import {INVALID_CREDENTIAL_MESSAGE,ModelCredentialRepository} from './repository.js';
import {ModelConfigurationApplyError,readProxyCaller,type ModelCredentialPort,type ProxyCaller} from './service.js';

/** User-visible: the engine asked for a provider key while the deployment keeps keys with the model proxy. */
export const PROXY_MODE_CREDENTIAL_MESSAGE='当前部署的模型密钥由模型代理保管，引擎不能读取。';
const UNAVAILABLE='模型代理暂不可用，凭据未更新。请检查 proxy 服务后重试。';

/** Proxy-mode credential port: provider keys stay with the account Core. Writes and `configured` cross to the
 * Core with this engine's caller token; there is no value readback, so `resolve` always refuses. */
export class ProxyModelCredentials implements ModelCredentialPort {
  private readonly identity:string;
  constructor(private readonly caller:ProxyCaller,private readonly fetchImpl:typeof fetch=fetch){
    this.identity='proxy:'+createHash('sha256').update(caller.caller+'\0'+caller.token).digest('hex');
  }
  /** Engines in proxy mode project only the caller token, so stored keys never change their configuration. */
  async stamp(){return this.identity}
  async resolve(_ref:string):Promise<string|undefined>{throw new ModelConfigurationApplyError(PROXY_MODE_CREDENTIAL_MESSAGE)}
  async configured(ref:string){
    try{validateSecretName(ref)}catch{return false}
    const value=await this.call({op:'describe',refs:[ref]}) as {configured?:Record<string,unknown>};
    return value.configured?.[ref]===true;
  }
  async set(ref:string,value:string){
    try{validateSecretName(ref);validateSecretValue(value)}catch{throw new Error(INVALID_CREDENTIAL_MESSAGE)}
    await this.call({op:'set',ref,value});
  }
  async remove(ref:string){try{validateSecretName(ref)}catch{return}await this.call({op:'unset',ref});}
  private async call(body:Record<string,unknown>):Promise<unknown>{
    let response:Response;
    try{response=await this.fetchImpl(this.caller.baseUrl+'/model-credentials',{method:'POST',redirect:'error',
      headers:{'content-type':'application/json',authorization:'Bearer '+this.caller.token},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});}
    catch(error){throw new Error(UNAVAILABLE,{cause:error})}
    if(response.status===400)throw new Error(INVALID_CREDENTIAL_MESSAGE);
    if(!response.ok)throw new Error(UNAVAILABLE);
    return response.json();
  }
}

/** Composition root for an engine's model credentials. With a proxy caller record (proxy mode) the engine gets no
 * SecretStore over `credentials.json` at all; otherwise (embedded mode) it owns the local file as before. */
export async function engineModelCredentials(directory:string,env:NodeJS.ProcessEnv=process.env):Promise<{credentials:ModelCredentialPort;caller:ProxyCaller|null}>{
  const caller=await readProxyCaller(env);
  return caller?{credentials:new ProxyModelCredentials(caller),caller}:{credentials:new ModelCredentialRepository(fileSecretStore(directory)),caller:null};
}

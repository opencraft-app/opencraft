import type {RuntimeSettingsDescribeResponse,RuntimeSettingsNamespaceView,RuntimeProvidersListResponse,RuntimeSettingsPathOperation} from '@opencraft/appserver-protocol';
import type {DshClient} from '../dsh-client.js';
import {DshClientError} from '../dsh-client.js';
import {ModelConfigurationConflict} from './repository.js';
import {createHash} from 'node:crypto';
import {modelBaseUrlError} from '@opencraft/appserver-protocol';
import type {ConfiguredProvider,ModelDocument} from './model-document.js';
import {ModelConfigurationApplyError,ModelConfigurationService,type ModelEnginePort,type ModelCredentialResolver} from './service.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const modelNamespaces=new Set(['llm-pi-ai','llm-deepseek','agent-default-model']);
const native=(p:ConfiguredProvider)=>p.id==='deepseek-official'&&p.catalogId==='deepseek';
const OLLAMA_CLOUD_ID='ollama-cloud';
function withOllamaCloud(directory:RuntimeProvidersListResponse):RuntimeProvidersListResponse{
  if(directory.providers.some(provider=>provider.provider===OLLAMA_CLOUD_ID))return {...directory,providers:directory.providers.map(provider=>
    provider.provider===OLLAMA_CLOUD_ID?{...provider,declared:false}:provider)};
  return {...directory,providers:[...directory.providers,{
    provider:OLLAMA_CLOUD_ID,displayName:'Ollama Cloud',declared:false,
    settingsNs:'llm-pi-ai',settingsPath:['providers',OLLAMA_CLOUD_ID],active:false,
  }]};
}
function profile(p:ConfiguredProvider){return {displayName:p.name,enabled:p.enabled,...(p.baseUrl?{baseURL:p.baseUrl}:{}),apiKeyEnv:p.credentialRef??'OPENCRAFT_UNBOUND',api:p.protocol,models:p.models.map(({enabled,...m})=>m)}}

/** Engine-specific format exists only in this adapter, never in models.json. */
function sections(doc:ModelDocument,raw:RuntimeSettingsDescribeResponse){
  const p=doc.providers.find(native), base=raw.namespaces.find(n=>n.ns==='llm-deepseek');
  const nativeValue={...object(base?.base),...(p?profile(p):{}),enabled:p?.enabled??false};
  delete nativeValue.api;delete nativeValue.displayName;
  if(p){const defaults=object(base?.base).models;nativeValue.models=p.models.map(({enabled,input,...m})=>({...((Array.isArray(defaults)?defaults:[]).find((v:any)=>v.id===m.id)??{}),...m,...(input?{inputModalities:input}:{})}));}
  return {
    'llm-pi-ai':{providers:Object.fromEntries(doc.providers.filter(p=>!native(p)).map(p=>[p.id,profile(p)])),modelSelection:Object.fromEntries(doc.providers.map(p=>[p.id,p.models.filter(m=>!m.enabled).map(m=>m.id)]))},
    'llm-deepseek':nativeValue,
    'agent-default-model':doc.defaultModel?{provider:doc.defaultModel.providerId,model:doc.defaultModel.modelId,...(doc.defaultModel.reasoningEffort?{reasoningEffort:doc.defaultModel.reasoningEffort}:{})}:{},
  };
}
function protocol(id:string){if(id==='anthropic')return 'anthropic-messages';if(id==='google')return 'google-generative-ai';return 'openai-completions'}
export function fromDshProfile(id:string,value:unknown,disabled:unknown,catalogId?:string):ConfiguredProvider{
  const p=object(value), off=new Set(Array.isArray(disabled)?disabled:[]);
  return {id,name:p.displayName|| (catalogId==='deepseek'?'DeepSeek':id),...(catalogId?{catalogId}:{}),protocol:p.api||protocol(id),baseUrl:p.baseURL||(catalogId==='deepseek'?'https://api.deepseek.com':''),credentialRef:p.apiKeyEnv||null,enabled:p.enabled!==false,
    models:(Array.isArray(p.models)?p.models:[]).map((m:any)=>({id:m.id,...(m.type?{type:m.type}:{}),...(m.name?{name:m.name}:{}),enabled:!off.has(m.id),...(m.contextWindow?{contextWindow:m.contextWindow}:{}),...(m.maxTokens?{maxTokens:m.maxTokens}:{}),...((m.input??m.inputModalities)?.length?{input:m.input??m.inputModalities}:{}),...(m.reasoningEfforts!==undefined?{reasoningEfforts:m.reasoningEfforts}:{})}))};
}

export class DshModelEngineAdapter implements ModelEnginePort {
  constructor(private readonly client:Pick<DshClient,'call'>){}
  async apply(doc:ModelDocument,credentials:ModelCredentialResolver){
    for(const provider of doc.providers){
      const issue=modelBaseUrlError(provider.baseUrl);if(issue)throw new Error(issue);
      if(provider.enabled&&!provider.models.some(model=>model.enabled))throw new ModelConfigurationApplyError(`“${provider.name}”没有已启用模型。请先获取模型，并启用至少一个模型。`);
    }
    const raw=await this.client.call<RuntimeSettingsDescribeResponse>('settings.describe');
    // Resolve everything before changing engine configuration. Values never enter the product document.
    const execution=structuredClone(doc);
    // Speech belongs to the application service. Neither its profiles nor secrets reach DSH.
    execution.providers=execution.providers.filter(p=>p.protocol!=='hunyuan-asr');
    for(const p of execution.providers)p.models=p.models.map(({type,...m})=>m);
    const wanted=new Map<string,string>();let missing=false;
    for(const p of execution.providers){const value=p.credentialRef?await credentials.resolve(p.credentialRef):undefined;if(p.enabled&&!value)missing=true;if(p.credentialRef){const ref=`OPENCRAFT_EXEC_${createHash('sha256').update(p.credentialRef).digest('hex').toUpperCase()}`;if(value)wanted.set(ref,value);p.credentialRef=ref;}}
    const oldProfiles=object(raw.namespaces.find(n=>n.ns==='llm-pi-ai')?.value).providers;
    const oldRefs=[...Object.values(object(oldProfiles)).map(p=>object(p).apiKeyEnv),object(raw.namespaces.find(n=>n.ns==='llm-deepseek')?.value).apiKeyEnv];
    for(const ref of new Set(oldRefs))if(typeof ref==='string'&&ref.startsWith('OPENCRAFT_EXEC_')&&!wanted.has(ref))await this.client.call('credentials.unset',{ref});
    if(missing)throw new Error('Missing model credential');
    for(const [ref,value]of wanted)await this.client.call('credentials.set',{ref,value});
    const projected=sections(execution,raw);
    for(const ns of ['llm-deepseek','llm-pi-ai','agent-default-model'] as const){
      const prior=raw.namespaces.find(n=>n.ns===ns);if(!prior)continue;
      const value=projected[ns];
      const ops:RuntimeSettingsPathOperation[] = Object.entries(value).map(([key,v])=>({op:'set',path:[key],value:v}));
      if(ns==='agent-default-model'&&!doc.defaultModel)ops.push({op:'unset',path:['provider']},{op:'unset',path:['model']});
      if(ns==='llm-deepseek'&&!Object.hasOwn(value,'baseURL'))ops.push({op:'unset',path:['baseURL']});
      if(ns==='agent-default-model'&&!Object.hasOwn(value,'reasoningEffort'))ops.push({op:'unset',path:['reasoningEffort']});
      await this.client.call('settings.mutate',{ns,expectedRevision:prior.revision,ops});
    }
  }
}

/** Compatibility facade for existing runtime model commands; product service owns writes. */
export class DshModelConfigurationBridge {
  private rawSettings:RuntimeSettingsDescribeResponse={writable:true,hasDocument:false,namespaces:[]};
  private rawProviders:RuntimeProvidersListResponse={providers:[]};
  constructor(private readonly client:Pick<DshClient,'call'>,readonly config:ModelConfigurationService){}
  async initialize(){await this.config.repository.initialize();this.rawSettings=await this.client.call('settings.describe');this.rawProviders=withOllamaCloud(await this.client.call('llm.providers'));await this.config.synchronize();}
  private async describe(){
    try{this.rawSettings=await this.client.call('settings.describe')}catch{/* Product configuration remains readable if execution fails. */}
    const doc=await this.config.repository.read(), values=sections(doc,this.rawSettings);
    return {...this.rawSettings,writable:true,hasDocument:true,namespaces:this.rawSettings.namespaces.map(n=>modelNamespaces.has(n.ns)?{...n,revision:doc.revision,value:values[n.ns as keyof typeof values],user:values[n.ns as keyof typeof values]}:n)};
  }
  async call<T>(method:string,payload:Record<string,any>={}):Promise<T>{
    if(method==='credentials.describe'){
      const doc=await this.config.repository.read(),speechRefs=new Set(doc.providers.filter(p=>p.protocol==='hunyuan-asr').map(p=>p.credentialRef));
      const credentials:Record<string,unknown>={};for(const ref of payload.refs??[])credentials[ref]={configured:!!(await this.config.credentials.resolve(ref)??(payload.storedOnly===true||speechRefs.has(ref)?undefined:process.env[ref])),writable:true,source:'opencraft'};
      return {credentials} as T;
    }
    if(method==='credentials.set'){await this.config.credentials.set(payload.ref,payload.value);this.config.application={state:'pending',revision:-1};return {} as T;}
    if(method==='credentials.unset'){await this.config.credentials.remove(payload.ref);this.config.application={state:'pending',revision:-1};return {} as T;}
    if(method==='settings.mutate'&&modelNamespaces.has(payload.ns)){
      const raw=await this.describe();
      try { await this.config.update(payload.expectedRevision,(doc)=>{
        const all=sections(doc,this.rawSettings);const value=structuredClone(all[payload.ns as keyof typeof all]) as Record<string,any>;
        for(const op of payload.ops as RuntimeSettingsPathOperation[]){if(!op.path.length||op.path.some(k=>['__proto__','prototype','constructor'].includes(k)))throw new Error('无效配置路径');let parent=value;for(const key of op.path.slice(0,-1))parent=parent[key]??={};const key=op.path.at(-1)!;if(op.op==='unset')delete parent[key];else parent[key]=op.value;}
        if(payload.ns==='llm-pi-ai'){
          const previous=doc.providers;
          doc.providers=[...previous.filter(native),...Object.entries(object(value.providers)).map(([id,v])=>fromDshProfile(id,v,object(value.modelSelection)[id],previous.find(p=>p.id===id)?.catalogId??(this.rawProviders.providers.some(p=>p.provider===id&&!p.declared)?id:undefined)))];
          if(!doc.providers.some(native)&&Object.hasOwn(object(value.modelSelection),'deepseek-official'))doc.providers.push(fromDshProfile('deepseek-official',all['llm-deepseek'],value.modelSelection['deepseek-official'],'deepseek'));
          for(const p of doc.providers){const disabled=new Set(Array.isArray(object(value.modelSelection)[p.id])?value.modelSelection[p.id]:[]);p.models=p.models.map(m=>({...m,enabled:!disabled.has(m.id)}));}
        }else if(payload.ns==='llm-deepseek'){
          const previous=doc.providers.find(native);
          const p=fromDshProfile(previous?.id??'deepseek-official',value,previous?.models.filter(m=>!m.enabled).map(m=>m.id),'deepseek');
          doc.providers=[...doc.providers.filter(p=>!native(p)),p];
        }else doc.defaultModel=typeof value.provider==='string'&&typeof value.model==='string'?{providerId:value.provider,modelId:value.model,...(value.reasoningEffort?{reasoningEffort:value.reasoningEffort}:{})}:null;
      }); } catch(error) { if(error instanceof ModelConfigurationConflict)throw new DshClientError('settings-conflict',error.message);throw error; }
      const updated=await this.describe();return updated.namespaces.find(n=>n.ns===payload.ns) as T;
    }
    await this.config.synchronize();
    if(method==='settings.describe')return await this.describe() as T;
    if(method==='llm.providers'){
      try{this.rawProviders=withOllamaCloud(await this.client.call('llm.providers'))}catch{/* Use last known catalog metadata. */}
      const doc=await this.config.repository.read();
      const providers=this.rawProviders.providers.filter(p=>!doc.providers.some(v=>v.id===p.provider&&v.protocol==='hunyuan-asr')&&(!p.declared||doc.providers.some(v=>v.id===p.provider))).map(p=>({...p,displayName:doc.providers.find(v=>v.id===p.provider)?.name??p.displayName,active:this.config.application.state==='applied'&&p.active}));
      for(const p of doc.providers)if(!providers.some(v=>v.provider===p.id))providers.push({provider:p.id,displayName:p.name,declared:!p.catalogId,settingsNs:native(p)?'llm-deepseek':'llm-pi-ai',settingsPath:native(p)?[]:['providers',p.id],active:false});
      return {providers} as T;
    }
    if(method==='llm.models'&&this.config.application.state!=='applied')return {groups:[]} as T;
    return this.client.call<T>(method,payload);
  }
}

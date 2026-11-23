import {createHash,randomBytes} from 'node:crypto';
import type {StateDocumentStore} from '@opencraft/document-storage/state';
import {configurationDocument} from './state-documents.js';
import {ModelConfigurationConflict,ModelCredentialRepository} from './repository.js';
import type {RuntimeProviderApplyParams} from '@opencraft/appserver-protocol';

export const IMAGE_GENERATION = Object.freeze({ns:'image-generation',api:'hunyuan-image-v35' as const,
  baseURL:'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation',model:''});
interface ImageProvider {id:string;name:string;baseURL:string;credentialRef:string;enabled:boolean;
  models:{id:string;name?:string;enabled:boolean}[]}
export interface ImageDocument {schemaVersion:1;revision:number;providers:ImageProvider[];defaultModel:{provider:string;model:string}|null}
const IMAGE_DOCUMENT_KEY='image-generation.json';
const empty=():ImageDocument=>({schemaVersion:1,revision:0,providers:[],defaultModel:null});
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&!/[\r\n\0]/u.test(v);
function endpoint(value:string){let url:URL;try{url=new URL(value)}catch{throw Error('图像服务地址无效')}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('图像服务须使用不含认证和查询参数的 HTTPS 地址');return url.toString();}
function validate(doc:ImageDocument){
  if(doc.schemaVersion!==1||!Number.isSafeInteger(doc.revision)||doc.revision<0||!Array.isArray(doc.providers))throw Error('图像配置格式无效');
  const ids=new Set();for(const p of doc.providers){
    if(!/^image-[a-zA-Z0-9._-]{1,120}$/u.test(p.id)||ids.has(p.id)||!text(p.name)||typeof p.enabled!=='boolean'||!/^[_A-Za-z][_A-Za-z0-9]*$/u.test(p.credentialRef)||!Array.isArray(p.models))throw Error('图像提供商配置无效');
    ids.add(p.id);endpoint(p.baseURL);const models=new Set();for(const m of p.models){if(!text(m.id)||models.has(m.id)||typeof m.enabled!=='boolean'||m.name!==undefined&&!text(m.name))throw Error('图像模型配置无效');models.add(m.id);}
  }
  if(doc.defaultModel!==null&&(!doc.defaultModel||!text(doc.defaultModel.provider)||!text(doc.defaultModel.model)))throw Error('默认图像模型无效');
}

/** Host-owned image configuration; never projected into a text execution engine. */
export class ImageGenerationConfiguration {
  constructor(readonly documents:StateDocumentStore,readonly credentials:ModelCredentialRepository){}
  private static parse(value:unknown){if(value===null)return empty();const doc=value as ImageDocument;validate(doc);return doc;}
  async read(){return ImageGenerationConfiguration.parse(await configurationDocument(this.documents.read(IMAGE_DOCUMENT_KEY)));}
  async update(revision:number,change:(doc:ImageDocument)=>void){return configurationDocument(this.documents.update(IMAGE_DOCUMENT_KEY,value=>{
    const current=ImageGenerationConfiguration.parse(value);if(current.revision!==revision)throw new ModelConfigurationConflict();
    const next=structuredClone(current);change(next);next.revision++;validate(next);return{result:next,next};
  }));}
  async apply(params:RuntimeProviderApplyParams){
    const {target}=params;if(!target||!['create','update'].includes(target.kind))throw Error('图像提供商操作无效');
    if(params.api!==undefined&&params.api!==IMAGE_GENERATION.api)throw Error('图像连接协议不可改变');
    const baseURL=endpoint(params.baseURL);
    const credential=params.credential;if(!credential||!['keep','replace','reference'].includes(credential.kind))throw Error('图像服务需要已保存的凭据');
    // A replaced key is written under a fresh reference, then the document CAS switches the provider to it. A writer
    // that loses the CAS removes its own reference, so a committed declaration only ever points at the key written
    // for it, never at a key another writer stored for a different endpoint.
    const replacement=credential.kind==='replace'
      ?'OPENCRAFT_IMAGE_'+createHash('sha256').update(target.id).digest('hex').slice(0,16).toUpperCase()+'_'+randomBytes(8).toString('hex').toUpperCase()
      :undefined;
    const plan=(doc:ImageDocument)=>{
      if(doc.revision!==params.expectedRevision)throw new ModelConfigurationConflict();
      const prior=doc.providers.find(p=>p.id===target.id);
      if(target.kind==='create'?!!prior:!prior)throw Error('图像提供商已变化，请刷新');
      if(prior&&prior.baseURL!==baseURL&&credential.kind==='keep'&&!credential.allowEndpointChange)throw Error('更换地址后请重新提供密钥');
      // A kept credential without a prior provider keeps the original per-provider slot (it may hold no key yet).
      const credentialRef=credential.kind==='reference'?credential.ref:replacement??prior?.credentialRef
        ??'OPENCRAFT_IMAGE_'+createHash('sha256').update(target.id).digest('hex').slice(0,24).toUpperCase();
      const p:ImageProvider={id:target.id,name:params.displayName?.trim()||prior?.name||target.id,baseURL,credentialRef,
        enabled:params.enabled??prior?.enabled??false,models:params.models===undefined?prior?.models??[]:params.models.map(m=>{
          if(m.type!==undefined&&m.type!=='image'||m.contextWindow!==undefined||m.maxTokens!==undefined||m.input!==undefined||m.reasoningEfforts!==undefined)throw Error('图像模型不能声明聊天能力');
          return{id:m.id,...(m.name?{name:m.name}:{}),enabled:prior?.models.find(old=>old.id===m.id)?.enabled??!params.disableNewModels};
        })};
      const next=structuredClone(doc);next.providers=next.providers.filter(p=>p.id!==target.id).concat(p);next.revision++;validate(next);
      return{provider:p,prior,next};
    };
    const {provider:planned}=plan(await this.read());
    const key=credential.kind==='replace'?credential.value:await this.credentials.resolve(planned.credentialRef);
    if(credential.kind==='replace'&&!text(key))throw Error('图像服务凭据无效');
    if(planned.enabled&&(!key||!planned.models.some(m=>m.enabled)))throw Error('请先保存图像密钥并添加已启用模型');
    if(replacement&&credential.kind==='replace')await this.credentials.set(replacement,credential.value);
    let committed:{result:{provider:string;revision:number;saved:true};retired?:string};
    try{
      committed=await configurationDocument(this.documents.update(IMAGE_DOCUMENT_KEY,value=>{
        const {provider:p,prior,next}=plan(ImageGenerationConfiguration.parse(value));
        const retired=prior&&prior.credentialRef!==p.credentialRef&&prior.credentialRef.startsWith('OPENCRAFT_IMAGE_')
          &&!next.providers.some(other=>other.credentialRef===prior.credentialRef)?prior.credentialRef:undefined;
        return{result:{result:{provider:p.id,revision:next.revision,saved:true as const},...(retired?{retired}:{})},next};
      }));
    }catch(error){
      if(replacement)await this.credentials.remove(replacement).catch(()=>undefined);
      throw error;
    }
    // The declaration no longer references the previous dedicated key; a failed removal only leaves an unused entry.
    if(committed.retired)await this.credentials.remove(committed.retired).catch(()=>undefined);
    return committed.result;
  }
  async resolve(){
    for(let attempt=0;attempt<3;attempt++){
      const stamp=await this.credentials.stamp(),doc=await this.read(),selection=doc.defaultModel;
      const provider=doc.providers.find(p=>p.id===selection?.provider),model=provider?.models.find(m=>m.id===selection?.model);
      if(!provider?.enabled||!model?.enabled)return null;
      const apiKey=await this.credentials.resolve(provider.credentialRef);
      if(stamp!==await this.credentials.stamp()||doc.revision!==(await this.read()).revision)continue;
      if(!apiKey)return null;
      return{provider:{id:provider.id,baseUrl:provider.baseURL},model:{id:model.id},apiKey,binding:`${doc.revision}:${stamp}`};
    }
    throw Error('图像配置正在更新，请重试');
  }
  async setEnabled(revision:number,id:string,enabled:boolean){
    const before=await this.read(),prior=before.providers.find(p=>p.id===id);
    if(enabled&&(!prior?.models.some(m=>m.enabled)||!await this.credentials.resolve(prior.credentialRef)))throw Error('请先保存图像密钥并添加已启用模型');
    return this.update(revision,doc=>{const p=doc.providers.find(p=>p.id===id);if(!p)throw Error('图像提供商不存在');p.enabled=enabled;});
  }
  async select(revision:number,selection:ImageDocument['defaultModel']){return this.update(revision,doc=>{
    if(selection){const p=doc.providers.find(p=>p.id===selection.provider);if(!p?.enabled||!p.models.some(m=>m.id===selection.model&&m.enabled))throw Error('请先启用图像提供商和模型');}
    doc.defaultModel=selection;
  });}
  profile(doc:ImageDocument){return{defaultModel:doc.defaultModel,providers:Object.fromEntries(doc.providers.map(p=>[p.id,
    {displayName:p.name,baseURL:p.baseURL,api:IMAGE_GENERATION.api,apiKeyEnv:p.credentialRef,enabled:p.enabled,models:p.models.map(m=>({id:m.id,name:m.name,type:'image'}))}]))};}
  async views(doc:ImageDocument){return Promise.all(doc.providers.map(async p=>{const configured=!!await this.credentials.resolve(p.credentialRef);return{provider:p.id,displayName:p.name,settingsNs:IMAGE_GENERATION.ns,settingsPath:['providers',p.id],declared:true,
    enabled:p.enabled,configured,active:p.enabled&&configured,configuration:{modelDeclarations:true,apis:[IMAGE_GENERATION.api],modelType:'image' as const,canToggle:true,canProbe:false,canCheckSaved:false,canInspectSaved:false}};}));}
}

import {readFile,mkdir,copyFile,chmod,constants} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse} from 'yaml';
import {emptyModelDocument,validateModelDocument} from './model-document.js';
import {ModelConfigurationRepository,ModelCredentialRepository} from './repository.js';
import {readJson} from './json-file.js';
import {fromDshProfile} from './dsh-adapter.js';
import type {RuntimeSettingsDescribeResponse} from '@opencraft/appserver-protocol';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
async function yaml(path:string){let text:string;try{text=await readFile(path,'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}try{return object(parse(text))}catch{throw new Error('旧配置格式无效，未迁移')}}
/** Explicit one-way import; never mirror engine settings back into the product file. */
export async function migrateDshModels(repository:ModelConfigurationRepository,credentials:ModelCredentialRepository,legacyHome:string,base?:RuntimeSettingsDescribeResponse){
  if(await readJson(repository.path)!==null)return {migrated:false,count:(await repository.read()).providers.length};
  const legacy=await yaml(join(legacyHome,'settings.yaml'));
  const doc=emptyModelDocument();
  if(!legacy){await repository.initialize(doc);return {migrated:false,count:0};}
  const pi=object(legacy['llm-pi-ai']);
  for(const [id,p] of Object.entries(object(pi.providers)))doc.providers.push(fromDshProfile(id,p,object(pi.modelSelection)[id]));
  const defaultValue=object(legacy['agent-default-model']);
  if(legacy['llm-deepseek']||defaultValue.provider==='deepseek-official'){
    const baseline=object(base?.namespaces.find(n=>n.ns==='llm-deepseek')?.base);
    const p={...baseline,...object(legacy['llm-deepseek'])};
    if(!Array.isArray(p.models))throw new Error('旧原生模型配置需要引擎目录辅助迁移，未覆盖文件');
    doc.providers.push(fromDshProfile('deepseek-official',p,object(pi.modelSelection)['deepseek-official'],'deepseek'));
  }
  if(defaultValue.provider&&defaultValue.model)doc.defaultModel={providerId:defaultValue.provider,modelId:defaultValue.model,...(defaultValue.reasoningEffort?{reasoningEffort:defaultValue.reasoningEffort}:{})};
  validateModelDocument(doc);
  const oldCredentials=await yaml(join(legacyHome,'.credentials.yaml'));
  const refs=object(oldCredentials?.refs);
  for(const p of doc.providers)if(p.credentialRef&&typeof refs[p.credentialRef]==='string'){
    const existing=await credentials.resolve(p.credentialRef);
    if(existing!==undefined&&existing!==refs[p.credentialRef])throw new Error('凭据引用冲突，未覆盖现有凭据');
  }
  const backup=join(repository.directory,'migration-backups',randomUUID());await mkdir(backup,{recursive:true,mode:0o700});
  for(const file of ['settings.yaml','.credentials.yaml'])try{await copyFile(join(legacyHome,file),join(backup,file),constants.COPYFILE_EXCL);await chmod(join(backup,file),0o600)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  for(const p of doc.providers)if(p.credentialRef&&typeof refs[p.credentialRef]==='string'&&await credentials.resolve(p.credentialRef)===undefined)await credentials.set(p.credentialRef,refs[p.credentialRef]);
  const saved=await repository.initialize(doc);return {migrated:true,count:saved.providers.length};
}

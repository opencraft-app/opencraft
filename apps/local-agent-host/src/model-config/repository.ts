import {join} from 'node:path';
import {stat} from 'node:fs/promises';
import type {StateDocumentStore} from '@opencraft/document-storage/state';
import {emptyModelDocument,validateModelDocument,type ModelDocument} from './model-document.js';
import {readJson,writeJson,locked} from './json-file.js';
import {configurationDocument} from './state-documents.js';

export const MODEL_DOCUMENT_KEY='models.json';
export class ModelConfigurationConflict extends Error {readonly code='settings-conflict';constructor(){super('模型配置已在其他窗口更新，请刷新后重试')}}
export class ModelConfigurationRepository {
  constructor(readonly documents:StateDocumentStore){}
  async read():Promise<ModelDocument>{const value=await configurationDocument(this.documents.read(MODEL_DOCUMENT_KEY));if(value===null)return emptyModelDocument();validateModelDocument(value);return value;}
  async initialize(seed:ModelDocument=emptyModelDocument()){return configurationDocument(this.documents.update(MODEL_DOCUMENT_KEY,(current):{result:ModelDocument}|{result:ModelDocument;next:ModelDocument}=>{
    if(current!==null){validateModelDocument(current);return {result:current};}
    validateModelDocument(seed);return {result:seed,next:seed};
  }))}
  async update(expectedRevision:number,change:(draft:ModelDocument)=>void){return configurationDocument(this.documents.update(MODEL_DOCUMENT_KEY,current=>{
    const base=current===null?emptyModelDocument():current;validateModelDocument(base);
    if(base.revision!==expectedRevision)throw new ModelConfigurationConflict();
    const next=structuredClone(base);change(next);next.revision=base.revision+1;validateModelDocument(next);return {result:next,next};
  }))}
}

/** No secret readback API; adapters receive values only at the execution boundary. */
export class ModelCredentialRepository {
  readonly path:string;
  constructor(directory:string){this.path=join(directory,'credentials.json')}
  async stamp(){try{const s=await stat(this.path,{bigint:true});return `${s.ino}:${s.mtimeNs}:${s.size}`}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'absent';throw error}}
  private async read():Promise<Record<string,string>>{const doc=await readJson(this.path) as {schemaVersion?:unknown;entries?:unknown}|null;if(doc===null)return {};if(doc.schemaVersion!==1||!doc.entries||typeof doc.entries!=='object'||Array.isArray(doc.entries)||Object.values(doc.entries).some(v=>typeof v!=='string'))throw new Error('凭据存储格式无效');return doc.entries as Record<string,string>;}
  async resolve(ref:string){const entries=await this.read();return Object.hasOwn(entries,ref)?entries[ref]:undefined;}
  async set(ref:string,value:string){if(!/^[_A-Za-z][_A-Za-z0-9]*$/.test(ref)||!value||/[\r\n\0]/.test(value))throw new Error('凭据格式无效');await locked(this.path,async()=>{const entries=await this.read();await writeJson(this.path,{schemaVersion:1,entries:{...entries,[ref]:value}})})}
  async remove(ref:string){await locked(this.path,async()=>{const entries=await this.read();delete entries[ref];await writeJson(this.path,{schemaVersion:1,entries})})}
}

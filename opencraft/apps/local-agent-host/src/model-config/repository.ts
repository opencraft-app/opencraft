import {join} from 'node:path';
import {stat} from 'node:fs/promises';
import {emptyModelDocument,validateModelDocument,type ModelDocument} from './model-document.js';
import {readJson,writeJson,locked} from './json-file.js';

export class ModelConfigurationConflict extends Error {readonly code='settings-conflict';constructor(){super('模型配置已在其他窗口更新，请刷新后重试')}}
export class ModelConfigurationRepository {
  readonly path:string;
  constructor(readonly directory:string){this.path=join(directory,'models.json')}
  async read():Promise<ModelDocument>{const value=await readJson(this.path);if(value===null)return emptyModelDocument();validateModelDocument(value);return value;}
  async initialize(seed:ModelDocument=emptyModelDocument()){return locked(this.path,async()=>{if(await readJson(this.path)!==null)return this.read();validateModelDocument(seed);await writeJson(this.path,seed);return seed})}
  async update(expectedRevision:number,change:(draft:ModelDocument)=>void){return locked(this.path,async()=>{const current=await this.read();if(current.revision!==expectedRevision)throw new ModelConfigurationConflict();const next=structuredClone(current);change(next);next.revision=current.revision+1;validateModelDocument(next);await writeJson(this.path,next);return next})}
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

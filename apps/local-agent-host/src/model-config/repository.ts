import type {StateDocumentStore} from '@opencraft/document-storage/state';
import {StateDocumentNotPrivateError} from '@opencraft/document-storage/state-file';
import {SecretStoreCorruptError,validateSecretName,validateSecretValue,type SecretStore} from '@opencraft/secret-storage';
import {emptyModelDocument,validateModelDocument,type ModelDocument} from './model-document.js';
import {configurationDocument} from './state-documents.js';
import type {ModelCredentialPort} from './service.js';

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

/** User-visible over RPC; kept identical to the previous file repository's messages. */
export const INVALID_CREDENTIAL_MESSAGE='凭据格式无效',CORRUPT_CREDENTIALS_MESSAGE='凭据存储格式无效';
/** The credentials file is a symlink, not this user's private (0600) regular file, or oversized; it is neither read nor overwritten. */
export const UNSAFE_CREDENTIALS_MESSAGE='凭据文件权限不安全，未读取';
async function credentialStorage<T>(operation:Promise<T>):Promise<T>{
  try{return await configurationDocument(operation)}catch(error){
    if(error instanceof SecretStoreCorruptError)throw new Error(CORRUPT_CREDENTIALS_MESSAGE,{cause:error});
    // Private reads open with O_NOFOLLOW, so a symlinked file fails with ELOOP before any check.
    if(error instanceof StateDocumentNotPrivateError||(error as NodeJS.ErrnoException|null)?.code==='ELOOP')throw new Error(UNSAFE_CREDENTIALS_MESSAGE,{cause:error});
    throw error;
  }
}
const storableName=(ref:string)=>{try{validateSecretName(ref);return true}catch{return false}};

/** Model credentials over a SecretStore. No secret readback API; adapters
 * receive values only at the execution boundary. Unknown or malformed
 * references resolve as absent, as configuration may name any reference. */
export class ModelCredentialRepository implements ModelCredentialPort {
  constructor(private readonly secrets:SecretStore){}
  /** Changes exactly when a stored credential changes (content-derived). */
  stamp(){return credentialStorage(this.secrets.stamp())}
  async resolve(ref:string){return storableName(ref)?credentialStorage(this.secrets.get(ref)):undefined}
  async configured(ref:string){return await this.resolve(ref)!==undefined}
  async set(ref:string,value:string){
    try{validateSecretName(ref);validateSecretValue(value)}catch{throw new Error(INVALID_CREDENTIAL_MESSAGE)}
    await credentialStorage(this.secrets.set(ref,value));
  }
  async remove(ref:string){if(storableName(ref))await credentialStorage(this.secrets.delete(ref))}
}

import type {ModelDocument} from './model-document.js';
import {ModelConfigurationRepository,ModelCredentialRepository} from './repository.js';

export interface ModelCredentialResolver {resolve(reference:string):Promise<string|undefined>}
export interface ModelEnginePort {apply(document:ModelDocument,credentials:ModelCredentialResolver):Promise<void>}
export interface ModelApplicationState {state:'pending'|'applied'|'failed';revision:number;error?:string}
/** Safe, actionable configuration failure; engine and credential details stay private. */
export class ModelConfigurationApplyError extends Error {}
export class ModelConfigurationService {
  application:ModelApplicationState={state:'pending',revision:-1};
  private tail:Promise<void>=Promise.resolve();
  private credentialStamp='';
  private appliedDocument: string | undefined;
  constructor(readonly repository:ModelConfigurationRepository,readonly credentials:ModelCredentialRepository,private readonly engine:ModelEnginePort){}
  async synchronize(force=false){
    const operation=this.tail.then(async()=>{const latest=await this.repository.read();const stamp=await this.credentials.stamp();if(!force&&this.application.revision===latest.revision&&this.credentialStamp===stamp&&this.application.state!=='pending')return;
      try{await this.engine.apply(latest,{resolve:async reference=>(await this.credentials.resolve(reference))??process.env[reference]});this.application={state:'applied',revision:latest.revision};this.appliedDocument=JSON.stringify(latest)}
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

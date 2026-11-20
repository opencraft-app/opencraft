import type { ActorContext } from '@opencraft/identity-core/actors';
import type { PersonalAssistant, PersonalAssistantRuntimeState, PersonalAssistantModelSelection, PersonalAssistantModelCatalog } from '@opencraft/appserver-protocol';
/** Trusted installation port; no Core store or transport implementation is imported by the runtime. */
export interface PersonalAssistantHostAuthority {
  actors: {authenticateSession(token: string): ActorContext | null};
  personalAssistantAssignments(after?: string): Promise<{items:{assistant:PersonalAssistant;epoch:string;context:ActorContext}[];next:string|null}>;
  provisionPersonalAssistant(context: ActorContext,botId?:string): Promise<{assistant:PersonalAssistant;credential:{credentialId:string;token:string;expiresAt:number}}>;
  personalAssistant(context: ActorContext, method: string, params?: Record<string,unknown>): Promise<unknown>;
  communicate(context: ActorContext, method: string, params?: Record<string,unknown>): Promise<unknown>;
  attachPersonalAssistantHost(host: {state(id:string):PersonalAssistantRuntimeState;wake(id?:string):void;models?():Promise<PersonalAssistantModelCatalog>;validateModel?(model:PersonalAssistantModelSelection):Promise<void>;environments?(context:ActorContext):Promise<import("@opencraft/appserver-protocol").BotEnvironmentCatalog>;validateEnvironment?(environment:import("@opencraft/appserver-protocol").BotEnvironment,context:ActorContext):Promise<void>}): ()=>void;
}
/** Installation adapter only. A sandbox provider must use the existing createSandbox lifecycle;
 * a template reference alone is never sufficient to advertise execution support. */
export interface AssistantEnvironmentProvider {
  close?():Promise<void>;
  templates():Promise<{id:string;name:string}[]>;
  validate?(environment:Extract<import('@opencraft/appserver-protocol').BotEnvironment,{kind:'sandbox'}>):Promise<void>;
  spawn(environment:Extract<import('@opencraft/appserver-protocol').BotEnvironment,{kind:'sandbox'}>,options:{directory:string;profileOptions:Record<string,unknown>;request:(method:string,params:Record<string,unknown>)=>Promise<unknown>}):Promise<{ready:Promise<unknown>;failed():boolean;close():Promise<void>}>;
}
export function createPersonalAssistantHost(options: {directory: string; service: PersonalAssistantHostAuthority;environmentProviders?:Readonly<Record<string,AssistantEnvironmentProvider>>;environmentProvidersFor?:(context:ActorContext)=>Promise<Readonly<Record<string,AssistantEnvironmentProvider>>>;codexBinary?:string;modelSource?: {
    catalog():Promise<PersonalAssistantModelCatalog>;
    resolve(selection:PersonalAssistantModelSelection,context?:{scope?:string;purpose?:'reception'|'context-summary'|'execution'|'memory-propose'|'memory-verify';authorize?:()=>Promise<void>}):Promise<{baseUrl:string;apiKey?:string;reasoningEffort?:string}>;
    activity?(scope:string):PersonalAssistantRuntimeState['modelWait'];
    failure?(scope:string,purpose:'reception'|'context-summary'|'execution'|'memory-propose'|'memory-verify'):{httpStatus:429;kind?:'rate_limit'|'quota_exhausted';retryAt:number}|undefined;
    close?():Promise<void>;
  }}): Promise<{
  state(id: string): PersonalAssistantRuntimeState;
  wake(id?: string): void;
  close(): Promise<void>;
}>;

export function spawnAssistant(options:{directory:string;profileOptions:Record<string,unknown>;request:(method:string,params:Record<string,unknown>)=>Promise<unknown>;executionEnvironment?:{id:string;binding:string;backendId:string;templateId:string;ephemeral:true}}):{ready:Promise<unknown>;failed():boolean;close():Promise<void>};

export interface Rule {engine:string;model?:string;effort?:string}
export const POLICY_PATH: string;
export const engines: string[];
export function parseRules(value:unknown):Rule[];
export function readPolicy(path?:string):{revision:number;rules:Rule[]};
export function denied(rules:Rule[],engine:string,model:string,effort?:string):boolean;
export class ModelPolicyError extends Error {code:number; data:{code:string;kind:string;alternatives:string[]}}
export function assertModelPolicy(path:string|undefined,engine:string,model:string|null|undefined,effort?:string|null,catalog?:Record<string,any>[]):number;
export function projectModels(path:string|undefined,engine:string,models:Record<string,any>[],policy?:{rules:Rule[]}):Record<string,any>[];

export function createDshPolicyBoundary(path?:string,catalog?:(config:Record<string,any>)=>Promise<Record<string,any>[]>):{admit(session:object,turn:number,config:Record<string,any>):Promise<void>};

export function resolvePolicySelection(engine:string,params:Record<string,any>,thread:Record<string,any>,catalog:Record<string,any>[]):{model:string|undefined;effort:string|undefined};

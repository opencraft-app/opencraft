import {THREAD_DEFAULTS_SCOPE,unknownThreadDefaults,type ConversationRef,type ThreadDefaultsBundle,type ThreadDefaultsObservation,type ThreadDefaultsResult} from '@opencraft/appserver-protocol/collaboration';
export class ThreadDefaultsError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
export interface ThreadDefaultsPort {
 assertCurrent():void;
 assertAuthority?():void;
 prepare():Promise<Record<string,unknown>>;
 write(params:Record<string,unknown>,admit:()=>boolean):Promise<unknown>;
 observe():Promise<ThreadDefaultsObservation>;
 diagnostic?(phase:"defaults-write"|"defaults-observe",error:unknown):void;
}
/** Called inside the existing Host Thread operation owner. No ledger or retry. */
export async function applyThreadDefaults(ref:ConversationRef,bundle:ThreadDefaultsBundle,port:ThreadDefaultsPort):Promise<ThreadDefaultsResult> {
 port.assertCurrent();const params=await port.prepare();port.assertCurrent();let attempted=false;
 let requestState:ThreadDefaultsResult['requestState']='unknown';
 try {await port.write(params,()=>{port.assertCurrent();attempted=true;return true;});requestState='acknowledged';}
 catch(error){try{port.diagnostic?.("defaults-write",error);}catch{/* Observation cannot alter settlement. */}if(!attempted)throw error;const code=(error as {code?:unknown}).code;
  if(code===-32601)throw new ThreadDefaultsError(409,'unsupported_capability');
  if(code===-32600||code===-32602)throw new ThreadDefaultsError(400,'thread_defaults_rejected');
 }
 let observation=unknownThreadDefaults(ref);try{observation=await port.observe();}catch(error){try{port.diagnostic?.("defaults-observe",error);}catch{/* Observation is independent. */}/* Never echo a requested value. */}
 if(port.assertAuthority)port.assertAuthority();else port.assertCurrent();return {ref,scope:THREAD_DEFAULTS_SCOPE,includesAlreadyAcceptedInputs:true,includesOtherParticipantsInputs:true,requested:bundle,requestState,observation,actualTurnSettings:null};
}
/** Managed requirements are the existing Native authority, not a new grant. */
export function assertDefaultsRequirements(raw:unknown,bundle:ThreadDefaultsBundle,permission:Record<string,unknown>):void {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(raw,'requirements'))throw new ThreadDefaultsError(503,'requirements_unavailable');
 const requirements=(raw as {requirements:unknown}).requirements;if(requirements===null)return;
 if(!requirements||typeof requirements!=='object'||Array.isArray(requirements))throw new ThreadDefaultsError(503,'requirements_unavailable');
 const r=requirements as Record<string,unknown>;
 const sandbox=bundle.permissionMode==='full'?'danger-full-access':bundle.permissionMode==='accept-edits'?'workspace-write':'read-only';
 for(const [key,selected] of [['allowedApprovalPolicies',permission.approvalPolicy],['allowedSandboxModes',sandbox]] as const){
  const values=r[key];if(values!=null&&(!Array.isArray(values)||values.length>100))throw new ThreadDefaultsError(503,'requirements_unavailable');
  if(Array.isArray(values)&&!values.includes(selected))throw new ThreadDefaultsError(403,'permission_mode_disallowed');
 }
 const profiles=r.allowedPermissionProfiles;if(profiles!=null){
  if(typeof profiles!=='object'||Array.isArray(profiles))throw new ThreadDefaultsError(503,'requirements_unavailable');
  if((profiles as Record<string,unknown>)[String(permission.permissions)]!==true)throw new ThreadDefaultsError(403,'permission_mode_disallowed');
 }
}

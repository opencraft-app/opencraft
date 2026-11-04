import { codexPermissionMode } from '../packages/appserver-protocol/src/permission-modes.ts';
/** Public catalog projection. Never forward arbitrary Host/Native metadata. */
const fault = code => Object.assign(new Error(code), {status: code === 'unsupported_capability' ? 409 : 503, code});
const field = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value) ? value : null;
function page(value, cursor) {
  if (!value || !Array.isArray(value.data) || value.data.length > 1000
    || value.nextCursor != null && (!field(value.nextCursor) || value.nextCursor === cursor)) throw fault('discovery_unavailable');
  return {data:value.data,nextCursor:value.nextCursor ?? null};
}
async function catalog(invoke,method,params) {
  try { return await invoke(method,params); }
  catch (error) { throw fault(error.code === -32601 || error.code === 'unsupported_capability' ? 'unsupported_capability' : 'discovery_unavailable'); }
}
export async function readProjects(invoke, serverId, cursor) {
  const result=page(await catalog(invoke,'project/list',{limit:30,cursor}),cursor);
  const projects=result.data.map(row=> {
    if (!field(row.id,256) || !field(row.name,512) || !Array.isArray(row.roots) || row.roots.length > 100) throw fault('discovery_unavailable');
    return {id:row.id,name:row.name,roots:row.roots.map(root=> {
      if (!field(root.path) || !root.path.startsWith('/')) throw fault('discovery_unavailable');
      return {path:root.path};
    })};
  });
  return {serverId,projects,nextCursor:result.nextCursor,supported:true,source:'host/project/list',observedAt:Date.now()};
}
export async function readModels(invoke, serverId, cursor) {
  const result=page(await catalog(invoke,'model/list',{limit:30,cursor,includeHidden:false}),cursor);
  const models=result.data.filter(row=>row.hidden !== true && row.policySelectable !== false).map(row=> {
    if (!field(row.id,512) || !field(row.model,512) || !Array.isArray(row.supportedReasoningEfforts)) throw fault('discovery_unavailable');
    const reasoningEfforts=row.supportedReasoningEfforts.map(option=> {
      if (!field(option.reasoningEffort,128)) throw fault('discovery_unavailable');
      return option.reasoningEffort;
    });
    const serviceTiers=Array.isArray(row.serviceTiers) ? row.serviceTiers.map(tier=> {
      if (!field(tier.id,128)) throw fault('discovery_unavailable');
      return tier.id;
    }) : null;
    return {id:row.id,model:row.model,reasoningEfforts,serviceTiers};
  });
  return {serverId,models,nextCursor:result.nextCursor,supported:true,source:'native/model/list+model-policy',observedAt:Date.now()};
}
export async function readOptions(invoke, ref) {
  let thread;
  try { ({thread}=await invoke('thread/read',{threadId:ref.threadId,includeTurns:false,sourceRead:true})); }
  catch (error) {
    // Only protocol incompatibility is unsupported; timeout/provider failures
    // remain unavailable, never a cached observation of the current settings.
    if (error.code !== -32601 && error.code !== 'unsupported_capability') throw error;
    return options(ref,null,false);
  }
  if (thread?.id !== ref.threadId) throw fault('conversation_unavailable');
  const observedAt=Date.now(), model=field(thread.model,512),reasoningEffort=field(thread.reasoningEffort,128);
  return {...options(ref,model || reasoningEffort ? {model,reasoningEffort,scope:'thread-current-or-last-persisted',source:'native/thread/read',observedAt} : null,true),
    optionCatalog:await readOptionCatalog(invoke,field(thread.cwd),model)};
}
function options(ref,nativeConfirmedConfiguration,supported) {
  return {ref,modelCatalog:null,supported,source:supported?'native/thread/read':'unknown',observedAt:Date.now(),nativeConfirmedConfiguration,
    permissionCeiling:{supported:false,value:null,source:'unknown'},options:{supported:false,value:null,source:'unknown'},actualTurnSettings:null};
}

/** A bounded observation of existing Native/Host policy. Never an authorization token. */
export async function readOptionCatalog(invoke, cwd, model, {permissionsOnly=false}={}) {
  const observe = async (source, read) => {
    try { return {supported:true,source,observedAt:Date.now(),...await read()}; }
    catch(error) {
      if (error.code !== 'unsupported_capability') throw error;
      return {supported:false,source:'unknown',observedAt:Date.now()};
    }
  };
  const requirements=await observe('native/configRequirements/read',async()=> {
    const result=await catalog(invoke,'configRequirements/read',{});
    if (!Object.hasOwn(result,'requirements')) throw fault('discovery_unavailable');
    const raw=result.requirements;
    if (raw === null) return {configured:false,allowedApprovalPolicies:null,allowedSandboxModes:null,allowedPermissionProfiles:null};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fault('discovery_unavailable');
    const strings=value=> {
      if(value == null) return null;
      if(!Array.isArray(value) || value.length>100 || value.some(item=>!field(item,128))) throw fault('discovery_unavailable');
      return value;
    };
    const approvalPolicies=raw.allowedApprovalPolicies;
    const approvalKeys=['sandbox_approval','rules','skill_approval','request_permissions','mcp_elicitations'];
    const allowedApprovalPolicies=approvalPolicies == null ? null : (()=> {
      if(!Array.isArray(approvalPolicies) || approvalPolicies.length>100) throw fault('discovery_unavailable');
      return approvalPolicies.map(value=> {
        if(typeof value==='string' && field(value,128)) return value;
        const granular=value?.granular;
        if(!granular || typeof granular!=='object' || Array.isArray(granular) || approvalKeys.some(key=>typeof granular[key]!=='boolean')) throw fault('discovery_unavailable');
        return {granular:Object.fromEntries(approvalKeys.map(key=>[key,granular[key]]))};
      });
    })();
    const profiles=raw.allowedPermissionProfiles;
    if(profiles != null && (typeof profiles!=='object' || Array.isArray(profiles) || Object.keys(profiles).length>1000 || Object.entries(profiles).some(([key,value])=>!field(key,512) || typeof value!=='boolean'))) throw fault('discovery_unavailable');
    return {configured:true,allowedApprovalPolicies,allowedSandboxModes:strings(raw.allowedSandboxModes),allowedPermissionProfiles:profiles == null ? null : {...profiles}};
  });
  const permissionModes=await observe('host/permissionProfile/list',async()=> {
    if (!cwd || !cwd.startsWith('/')) throw fault('unsupported_capability');
    const rows=[];let cursor=null;const seen=new Set();
    for(let index=0;index<4;index++) {
      const result=page(await catalog(invoke,'permissionProfile/list',{cwd,limit:100,cursor}),cursor);
      rows.push(...result.data);
      if(result.nextCursor===null) break;
      if(index===3 || seen.has(result.nextCursor)) throw fault('discovery_unavailable');
      seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    const modes=new Map();
    for(const row of rows) {
      if(!row || !field(row.id,512) || typeof row.allowed!=='boolean') throw fault('discovery_unavailable');
      const nativeProfileId=field(row.openCraftNativeProfileId,512) ?? row.id;
      const mode=codexPermissionMode(nativeProfileId);
      // A custom profile or an inconsistent Host projection has no trusted named mapping.
      if(!mode || row.openCraftMode !== undefined && row.openCraftMode!==mode || modes.has(mode)) continue;
      const approvalPolicy=mode==='full'?'never':'on-request';
      const sandboxMode=mode==='full'?'danger-full-access':mode==='accept-edits'?'workspace-write':'read-only';
      const managedAllowed=requirements.supported ? (requirements.allowedApprovalPolicies===null || requirements.allowedApprovalPolicies.includes(approvalPolicy))
        && (requirements.allowedSandboxModes===null || requirements.allowedSandboxModes.includes(sandboxMode))
        && (requirements.allowedPermissionProfiles===null || requirements.allowedPermissionProfiles[nativeProfileId]===true) : null;
      modes.set(mode,{mode,nativeProfileId,approvalPolicy,allowed:row.allowed && managedAllowed===true});
    }
    return {values:[...modes.values()]};
  });
  const collaborationModes=permissionsOnly ? {supported:false,source:'unknown',observedAt:Date.now()} : await observe('native/collaborationMode/list',async()=> {
    const raw=await catalog(invoke,'collaborationMode/list',{});
    if(!Array.isArray(raw.data) || raw.data.length>100) throw fault('discovery_unavailable');
    return {values:[...new Set(raw.data.map(row=>row.mode).filter(mode=>mode==='plan' || mode==='default'))],writeSupported:false};
  });
  return {scope:'new-thread-subsequent',source:'host/native-option-catalog',observedAt:Date.now(),cwd,model,
    permissionModes,requirements,collaborationModes,initialWrite:{permissionMode:false,serviceTier:false,plan:false}};
}

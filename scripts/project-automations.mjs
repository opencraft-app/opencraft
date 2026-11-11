import { createHash } from 'node:crypto';
import { ProjectAutomations } from '../packages/access-control/src/automation-runtime.ts';

/** Assembly only. Server Worker stores runs, Broker owns agent operations, Host owns scripts. */
export function createProjectAutomations(storage, broker, collaboration, bridge) {
  const rpc=async(path,body)=>{
    if(!bridge)throw Error('Automation Host attachment is not configured');
    const response=await fetch(new URL(path,bridge.url),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw Error('Automation Host request refused');return response.json();
  };
  const projection=new Map();
  collaboration.automationAuthorityAllowed=id=>projection.get(id)?.valid===true;
  const runtime=new ProjectAutomations(storage,{
    projection:values=>{projection.clear();for(const value of values)projection.set(value.authorityId,value);},
    revoke:grantId=>{for(const value of projection.values())if(value.grantId===grantId)value.valid=false;},
    async validate(grant,context) {
      if(!collaboration.actors.isCurrent(context)||!collaboration.admittedActor(context.actorId))throw Error('Automation human authorization was revoked');
      if(grant.target.kind!=='script')return broker.prepareAutomation(grant,context);
      // Shared Host script execution requires the installation's existing explicit
      // management grant in addition to the human's exact argv/cwd project grant.
      if(!collaboration.actors.canAdmitted(grant.actorId,grant.generation,collaboration.actors.managementResource,'actors.manage'))throw Error('Host script authorization required');
      const capabilities=await rpc('/script/capabilities');
      if(!capabilities || grant.target.hostId!==capabilities.hostId || grant.target.environment!==capabilities.environment || grant.permissionProfile!==capabilities.permissionProfile)
        throw Error('Script sandbox authority mismatch');
      const snapshot=createHash('sha256').update(JSON.stringify(capabilities)).digest('hex');
      if(grant.permissionSnapshot && grant.permissionSnapshot!==snapshot)throw Error('Script sandbox authority changed');
      return snapshot;
    },
    async dispatch(value,run,grant,delegation) {
      if(value.target.kind!=='script')return broker.dispatchAutomation(value,run,grant,delegation);
      const target=value.target;
      const receipt=await rpc('/script/run',{key:run.key,hostId:target.hostId,environment:target.environment,permissionProfile:value.permissionProfile,cwd:target.cwd,argv:target.argv});
      return {state:['completed','failed','unknown'].includes(receipt.state)?receipt.state:'running',result:{kind:'script',key:run.key,receipt}};
    },
    async inspect(run) {
      const grant=await storage.automation('runGrant',{key:run.key},Date.now());
      if(grant.target.kind!=='script')return broker.inspectAutomation(run);
      const receipt=await rpc('/script/show?key='+encodeURIComponent(run.key));
      if(!receipt)return {state:'unknown',result:run.result};
      return {state:['completed','failed','unknown'].includes(receipt.state)?receipt.state:'running',result:{kind:'script',key:run.key,receipt}};
    },
  });
  broker.automations=runtime;
  return runtime;
}

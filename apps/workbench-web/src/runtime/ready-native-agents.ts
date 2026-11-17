import type {CatalogModel,ModelListResponse} from '@opencraft/appserver-protocol';
import type {AgentRuntimeAccess} from '@opencraft/workbench-runtime';
export interface ReadyNativeAgent {agentId:string;agentName:string;modelId:string;effort:string|null}
/** Native login plus advertised models, never cached model metadata alone. */
export async function readReadyNativeAgents(request:AgentRuntimeAccess['request'],hostId:string,signal:AbortSignal):Promise<ReadyNativeAgent[]> {
 const status=await request(hostId,'opencraft/agents/onboarding/status',{});signal.throwIfAborted();
 const ready=status.agents.filter(agent=>agent.installed===true&&agent.authenticated===true&&agent.connectionRequired!==true&&agent.workspaceTrusted!==false);
 if(!ready.length)return [];
 const models:CatalogModel[]=[];let cursor:string|null=null;const cursors=new Set<string>();
 do{const page:ModelListResponse=await request(hostId,'model/list',{cursor,limit:100,includeHidden:false});signal.throwIfAborted();models.push(...page.data);cursor=page.nextCursor??null;if(cursor){if(cursors.has(cursor))throw new Error('Repeated model catalog cursor');cursors.add(cursor);}}while(cursor);
 return ready.flatMap(agent=>{
  const engine=agent.engineId??(agent.id==='claude'?'claude-code':agent.id);
  const declared=models.filter(model=>model.agentId===engine&&!model.hidden&&!model.policyRestricted);
  const model=declared.find(model=>model.isDefault)??declared[0];
  return model?[{agentId:engine,agentName:agent.displayName??(agent.id==='pi'?'Pi':agent.id==='claude'?'Claude Code':agent.id==='codebuddy'?'CodeBuddy':agent.id==='cursor'?'Cursor':'Codex'),modelId:model.model,effort:model.defaultReasoningEffort}]:[];
 });
}

import { configuredModelGatewayPath, ModelGatewayError, ModelGatewayStore } from "./model-gateway-store.js";

/** The caller is the authenticated execution owner, not a model or HTTP header.
 * Parent links come from the collaboration authority, never request JSON. */
export function bindModelGatewaySponsor(thread: string, actor: string | null,
  parent: (thread: string) => string | null = () => null, path = configuredModelGatewayPath()): string | null {
  if (!path) return null;
  const store = new ModelGatewayStore(path), seen = new Set<string>();
  function bind(id: string, direct: string | null): string {
    const execution=store.execution(id);
    if(execution) {
      if(direct)store.steerExecution(id,direct);
      return execution.authorizer;
    }
    const source=parent(id), inherited=source?store.execution(source):null;
    if(inherited) {
      if(direct && direct!==inherited.authorizer)throw new ModelGatewayError("gateway_execution_owner_required",403);
      store.beginExecution(id,{id:JSON.stringify([inherited.id,id]),authorizer:inherited.authorizer,executor:null,
        model:inherited.model,expiresAt:inherited.expiresAt,parent:inherited.id});
      return inherited.authorizer;
    }
    const existing = store.sponsor(id);
    if (existing) return store.bind(id, direct);
    if (seen.has(id) || seen.size >= 64) throw new ModelGatewayError("gateway_sponsor_cycle", 403);
    seen.add(id);
    const ancestor = parent(id);
    if (ancestor) bind(ancestor, null);
    return store.bind(id, direct, ancestor);
  }
  try { return bind(thread, actor); } finally { store.close(); }
}

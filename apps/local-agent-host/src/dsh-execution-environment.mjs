/** The generation routing/checkpoint owner supplies the only native→logical
 * resolver. Both shell facts and persistent terminals consume that same port. */
export function registerDshExecutionEnvironment(ctx, resolveLogicalThreadId, runtime, git, launch) {
  if (runtime && launch) throw Error('Execution ENV cannot have two owners');
  const environment = nativeId => {
    const threadId = resolveLogicalThreadId(nativeId);
    if (!runtime || !threadId) return {};
    const snapshot = runtime.snapshot(runtime.execution('opencraft-server', threadId));
    snapshot.apply(process.env); return snapshot.overlay();
  };
  const nativeTurn = agent => {
    if (!agent || agent.status !== 'running') throw Error('git_execution_unavailable');
    const nativeId = String(agent.session.header.id);
    if (ctx.agents?.get(nativeId) !== agent) throw Error('git_execution_unavailable');
    for (let i=agent.session.events.length-1;i>=0;i--) {
      const event=agent.session.events[i];
      if(event.type==='turn/end')break;
      if(event.type==='turn/start') {
        if(!Number.isSafeInteger(event.data?.turn)||event.data.turn<1)break;
        const threadId=resolveLogicalThreadId(nativeId);
        if(typeof threadId!=='string'||!threadId)break;
        return {nativeId,threadId,turn:event.data.turn};
      }
    }
    throw Error('git_execution_unavailable');
  };
  const identity = Object.freeze({ resolve: nativeId => resolveLogicalThreadId(nativeId), environment,
    async prepare(execution) {
      if(!git&&!launch)return {};
      execution.signal?.throwIfAborted();
      const original=nativeTurn(execution.agent);
      const current=()=>{
        execution.signal?.throwIfAborted();
        if(JSON.stringify(nativeTurn(execution.agent))!==JSON.stringify(original))throw Error('git_execution_unavailable');
      };
      const locator={hostId:'opencraft-server',threadId:original.threadId,turnId:`dsh-turn-${original.threadId}-${original.turn}`};
      // Personal ENV is one-shot launch configuration for this exact Turn; Git
      // keeps its own per-command broker authorization. Neither is a fallback.
      const [environment,snapshot]=await Promise.all([launch?.prepare(locator,current),git?.prepare(locator)]);
      current();
      const overlay={};
      for(const part of [environment,snapshot]) if(part) {
        part.apply(process.env);
        for(const [name,value] of Object.entries(part.overlay())) {
          if(Object.hasOwn(overlay,name))throw Error('environment_launch_unavailable');
          overlay[name]=value;
        }
      }
      return Object.freeze(overlay);
    },
  });
  ctx.provide("opencraftExecutionThread", identity);
  ctx.inject(["shellEnv"], scoped => {
    scoped.shellEnv.register({
      name: "opencraft-execution-thread",
      variables: { DSH_OPENCRAFT_THREAD_ID: { description: "Stable public OpenCraft Thread ID for the current native execution." } },
      resolve(execution) {
        const nativeId = execution.agent?.session.header.id;
        return nativeId ? { DSH_OPENCRAFT_THREAD_ID: identity.resolve(String(nativeId)) } : {};
      },
    });
  });
}

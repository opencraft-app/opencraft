/** Proofs come from the native registry's exact Agent, never notice text/labels.
 * Process-local jobs cannot survive engine restart, so neither do these grants. */
export function createBackgroundJobProofs(ctx) {
  const agents = new WeakMap();
  const proofs = new Map();
  const origins = new Map();
  const terminal = status => ["completed", "failed", "killed"].includes(status);
  ctx.jobs.onJobsChanged(agent => {
    if (!agent) return; // Unowned jobs are visible to every session; never authorize them.
    let state = agents.get(agent);
    if (!state) agents.set(agent, state = new Map());
    const snapshots = ctx.jobs.list(agent).filter(job => job.ownerSession === agent.id);
    const ids = new Set(snapshots.map(job => job.id));
    for (const id of state.keys()) if (!ids.has(id)) state.delete(id);
    for (const job of snapshots) {
      let prior = state.get(job.id);
      if (!prior) {
        // A cold/terminal baseline cannot mint permission. Capture the actual
        // input RPC while the producing Agent is executing this job's creation.
        let rpcId;
        for (let index = agent.session.events.length - 1; index >= 0; index--) {
          const event = agent.session.events[index];
          if (event.type === "turn/start") break;
          if (event.type !== "user/message") continue;
          rpcId = event.data?.source?.rpcId ?? origins.get(String(agent.id) + ":" + event.data?.id);
          if (typeof rpcId === "string") break;
        }
        if (agent.status === "idle" || job.status !== "running" || typeof rpcId !== "string") continue;
        state.set(job.id, prior = { rpcId, ready: false });
      }
      if (terminal(job.status) && !job.reported) prior.ready = true;
      if (job.reported) state.delete(job.id);
    }
  });
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    const source = message.source;
    if (source?.kind !== "plugin" || source.plugin !== "tool-jobs" || source.form !== "notice") return;
    const state = agents.get(agent);
    const ready = [...(state?.entries() ?? [])].filter(([, job]) => job.ready);
    if (!ready.length || new Set(ready.map(([, job]) => job.rpcId)).size !== 1) return;
    // Native notices carry no job ID. Only an unambiguous single producing
    // execution can lend authority. One message consumes this completed batch.
    const sessionId = String(agent.id);
    proofs.set(sessionId + ":" + message.id, { originRpcId: ready[0][1].rpcId });
    origins.set(sessionId + ":" + message.id, ready[0][1].rpcId);
    while (origins.size > 2048) origins.delete(origins.keys().next().value);
    for (const [id] of ready) state.delete(id);
    // Bound notices injected into a busy Agent; consumed proofs are removed on read.
    while (proofs.size > 2048) proofs.delete(proofs.keys().next().value);
  });
  return { take(sessionId, messageId) {
    const key = sessionId + ":" + messageId, proof = proofs.get(key);
    proofs.delete(key);
    return proof ?? null;
  } };
}

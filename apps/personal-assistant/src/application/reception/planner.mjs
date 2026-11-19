import {
  RECEPTION_LIMITS,
  ReceptionQuery,
} from "../../domain/reception-query.mjs";

/** Model/query protocol only. It cannot settle a turn or invoke a command service. */
export class ReceptionPlanner {
  constructor(model, queries) {
    Object.assign(this, { model, queries });
  }
  async plan(turn, input, signal, onTrace = () => {}) {
    const session = this.queries.open(turn),
      observations = [];
    try {
      // A report retry refreshes previously discovered reads under today's
      // grant. Only host query descriptors are retained, never stale responses.
      const prior =
        turn.source_json && turn.decision_json
          ? (JSON.parse(turn.decision_json).queries ?? [])
          : [];
      const seen = new Set();
      for (const q of prior.slice(0, RECEPTION_LIMITS.queries)) {
        signal.throwIfAborted();
        let query;
        try {
          query = ReceptionQuery.parse({
            kind: "query",
            name: q.name,
            params: q.params,
          });
        } catch {
          continue;
        }
        const key = JSON.stringify(query);
        if (seen.has(key)) continue;
        seen.add(key);
        observations.push(
          await session.executeAsync({ kind: "query", ...query }, signal),
        );
        onTrace(session.trace);
      }
      for (let round = 0; round < RECEPTION_LIMITS.modelRounds; round++) {
        signal.throwIfAborted();
        const proposal = await this.model.decide(
          structuredClone({ ...input, observations }),
          signal,
        );
        signal.throwIfAborted();
        if (proposal?.kind !== "query")
          return { proposal, queries: session.trace };
        observations.push(await session.executeAsync(proposal, signal));
        onTrace(session.trace);
      }
      throw new Error("Reception planning rounds exhausted");
    } catch (error) {
      // Capture only host-produced trace; a model-supplied trace is never accepted as provenance.
      throw new ReceptionPlanningError(error, session.trace);
    }
  }
}
export class ReceptionPlanningError extends Error {
  constructor(cause, queries) {
    super(cause?.message ?? String(cause), { cause });
    this.queries = queries;
    // Preserve typed failure semantics across this trace-enrichment boundary.
    if (cause?.modelFailure) this.modelFailure = cause.modelFailure;
    if (cause?.proposalFailure) this.proposalFailure = cause.proposalFailure;
  }
}

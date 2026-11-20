import type { DatabaseSync } from 'node:sqlite';

export interface ExecutionRequestState {
  id: string;
  state: string;
  reason: string | null;
  queueId: string | null;
  turnId: string | null;
  now: number;
}

/** Shared by the synchronous command owner and the polling Worker. Committed
 * injection facts cannot be undone by a stale async handoff observation.
 * Exact positive injection can correct a raced negative outcome; it grants no new work.
 * A repeated observation is not a new durable state transition. */
export function updateExecutionRequest(database: DatabaseSync, value: ExecutionRequestState): void {
  database.prepare(`UPDATE actor_execution_requests
    SET state=?,reason=?,queue_id=COALESCE(?,queue_id),turn_id=COALESCE(?,turn_id),updated_at=?
    WHERE id=?
      AND (state NOT IN ('injected','rejected','cancelled','submitted')
        OR (state IN ('submitted','rejected','cancelled') AND ?='injected')
        OR (state='submitted' AND ?='submitted')
        OR (state='injected' AND ?='injected' AND (turn_id IS NULL OR ? IS NULL OR turn_id=?)))
      AND (queue_id IS NULL OR ? IS NULL OR queue_id=?)
      AND (?!='injected' OR turn_id IS NULL OR turn_id='unknown' OR ? IS NULL OR turn_id=?)
      AND (state IS NOT ? OR reason IS NOT ?
      OR queue_id IS NOT COALESCE(?,queue_id) OR turn_id IS NOT COALESCE(?,turn_id))`)
    .run(value.state,value.reason,value.queueId,value.turnId,value.now,value.id,
      value.state,value.state,value.state,value.turnId,value.turnId,
      value.queueId,value.queueId,
      value.state,value.turnId,value.turnId,
      value.state,value.reason,value.queueId,value.turnId);
}

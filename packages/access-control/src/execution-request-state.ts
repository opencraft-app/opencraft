import type { DatabaseSync } from 'node:sqlite';

export interface ExecutionRequestState {
  id: string;
  state: string;
  reason: string | null;
  queueId: string | null;
  turnId: string | null;
  now: number;
}

/** A repeated observation is not a new durable state transition. */
export function updateExecutionRequest(database: DatabaseSync, value: ExecutionRequestState): void {
  database.prepare(`UPDATE actor_execution_requests
    SET state=?,reason=?,queue_id=COALESCE(?,queue_id),turn_id=COALESCE(?,turn_id),updated_at=?
    WHERE id=? AND (state IS NOT ? OR reason IS NOT ?
      OR queue_id IS NOT COALESCE(?,queue_id) OR turn_id IS NOT COALESCE(?,turn_id))`)
    .run(value.state,value.reason,value.queueId,value.turnId,value.now,value.id,
      value.state,value.reason,value.queueId,value.turnId);
}

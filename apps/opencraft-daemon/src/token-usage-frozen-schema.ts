/** v12: include already acquired frozen usage and rebuild its derived rows. */
export const OPENCRAFT_HOST_TOKEN_USAGE_FROZEN = `
UPDATE token_usage_projection_state SET ready=0,cursor_thread='',cursor_turn=''
 WHERE EXISTS(SELECT 1 FROM token_usage_turns t WHERE t.server_id=token_usage_projection_state.server_id AND t.frozen=1);
DELETE FROM token_usage_turn_actor_projections WHERE EXISTS(
 SELECT 1 FROM token_usage_turns t WHERE t.server_id=token_usage_turn_actor_projections.server_id
 AND t.thread_id=token_usage_turn_actor_projections.thread_id AND t.turn_id=token_usage_turn_actor_projections.turn_id AND t.frozen=1);
`;

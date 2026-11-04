/** Trusted native/Host lane only. These values are not employee credentials.
 * Browser requests cannot supply execution proof or their own authorization nonce. */
export interface GoalExecutionProof {
  readonly authorizationId: string;
  readonly round: number;
}
export interface GoalExecutionAuthorization {
  readonly threadId: string;
  readonly turnId: string;
  readonly inputId?: string;
  readonly authorizationId: string;
}
export const GOAL_EXECUTION_EXTENSION = "opencraft/goal-execution";
export const GOAL_EXECUTION_OBSERVER_INITIALIZE = "opencraft/goal-observer/initialize";
export const GOAL_EXECUTION_AUTHORIZED = "opencraft/goal/authorized";
export const GOAL_EXECUTION_AUTHORIZE = "opencraft/goal-observer/authorize";
export const GOAL_EXECUTION_ADMIT = "opencraft/goal-observer/admit";

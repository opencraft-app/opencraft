import { defineDoc } from "@earendil-works/pi-durable";
import type { OpenCraftThreadGoal } from "@opencraft/appserver-protocol";
export type PiGoalState = {
  goal: OpenCraftThreadGoal | null;
  authorizationId: string | null;
  round: number;
  pending?: boolean;
}
/** Goal intent and continuation counter belong to the native durable owner.
 * Forks start without delegation; history reads never arm execution. */
export const PiGoalDoc = defineDoc<PiGoalState>({
  kind: "opencraft.goal", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ goal: null, authorizationId: null, round: 0, pending: false }),
});
export const piGoalCapability = Object.freeze({ version: 1, read: true, write: true, usageAccounting: false });
export function validatePiGoal(params: Record<string, any>, current: OpenCraftThreadGoal | null) {
  if (params.objective !== undefined && (typeof params.objective !== "string" || !params.objective.trim() || [...params.objective].length > 10000))
    throw new Error("Goal objective must contain 1 to 10000 characters");
  if (params.status !== undefined && !["active", "paused", "complete", "blocked"].includes(params.status))
    throw new Error("Unsupported Pi Goal status");
  if (!current && params.objective === undefined) throw new Error("Goal objective required");
  if (params.tokenBudget != null) throw new Error("Pi Goal token budgets are not supported");
}

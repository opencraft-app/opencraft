/** Host provenance, never inferred from model/user text or a client input ID. */
export interface TurnRecoveryNotice {
  readonly threadId: string;
  readonly rootTurnId: string;
  readonly turnId: string;
  readonly attempts: number;
  readonly limit: number;
  readonly state: "continued" | "exhausted" | "unconfirmed";
  readonly sourceKind: "system";
}
export const TURN_RECOVERY_EXTENSION = "opencraft/turn-recovery";
export interface TurnRecoveryMethodMap {
  "opencraft/turn-recovery/read": { params: { threadId: string }; result: { recovery: TurnRecoveryNotice | null } };
}
export function parseTurnRecoveryNotice(value: unknown): TurnRecoveryNotice | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (![row.threadId, row.rootTurnId, row.turnId].every(id => typeof id === "string" && id.length > 0)
    || !Number.isSafeInteger(row.attempts) || !Number.isSafeInteger(row.limit)
    || (row.attempts as number) < 1 || (row.attempts as number) > (row.limit as number)
    || row.sourceKind !== "system" || !["continued", "exhausted", "unconfirmed"].includes(String(row.state))) return null;
  return { threadId: row.threadId as string, rootTurnId: row.rootTurnId as string, turnId: row.turnId as string,
    attempts: row.attempts as number, limit: row.limit as number, state: row.state as TurnRecoveryNotice["state"], sourceKind: "system" };
}

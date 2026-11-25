import { existsSync } from "node:fs";
import { join } from "node:path";
import { CODEX_MAINTENANCE_READ } from "./codex-admission-policy.js";
export { CODEX_MAINTENANCE_READ, codexMaintenanceError, isCodexAdmission } from "./codex-admission-policy.js";

export const CODEX_MAINTENANCE_EXTENSION = "opencraft.codex-maintenance";
export const CODEX_MAINTENANCE_CAPABILITY = { version: 1, readMethod: CODEX_MAINTENANCE_READ } as const;
export const CODEX_ADMISSION_PAUSE_FILE = "codex-admission.paused";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** One durable input can occupy both the Host queue and a native RPC at once. */
export function codexAdmissionKey(method: string, params: unknown, fallback: string): string {
  const body = record(params);
  return typeof body.threadId === "string" && typeof body.clientUserMessageId === "string" && body.clientUserMessageId
    ? JSON.stringify(["input", body.threadId, body.clientUserMessageId]) : JSON.stringify(["rpc", method, fallback]);
}
export const codexAdmissionPaused = (directory: string): boolean => existsSync(join(directory, CODEX_ADMISSION_PAUSE_FILE));
export interface CodexMaintenanceSnapshot {
  paused: boolean;
  /** Rejected RPC attempts in this Host instance; durable diagnostics span restarts. */
  rejectedAdmissions?: number;
  pendingAdmissions: number;
  queued: number;
  unknown: number;
  activeGoals: number;
  pendingTitles: number;
  pendingApprovals: number;
  capacityRetries: number;
}

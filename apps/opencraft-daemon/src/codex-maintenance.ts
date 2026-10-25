import { existsSync } from "node:fs";
import { join } from "node:path";
import { COLLABORATION_METHOD } from "@opencraft/appserver-protocol/collaboration";

export const CODEX_MAINTENANCE_READ = "opencraft/codex/maintenance/read";
export const CODEX_MAINTENANCE_EXTENSION = "opencraft.codex-maintenance";
export const CODEX_MAINTENANCE_CAPABILITY = { version: 1, readMethod: CODEX_MAINTENANCE_READ } as const;
export const CODEX_ADMISSION_PAUSE_FILE = "codex-admission.paused";
const admissions = new Set(["thread/start", "thread/fork", "turn/start", "thread/queue/add", "thread/goal/set", "command/exec", "process/spawn", "thread/shellCommand", COLLABORATION_METHOD]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function isCodexAdmission(method: unknown, params?: unknown): boolean {
  const body = record(params);
  if (method === "thread/goal/set" && (body.status === "paused" || body.status === "complete")
    && Object.keys(body).every(key => key === "threadId" || key === "status")) return false;
  return typeof method === "string" && admissions.has(method);
}
/** One durable input can occupy both the Host queue and a native RPC at once. */
export function codexAdmissionKey(method: string, params: unknown, fallback: string): string {
  const body = record(params);
  return typeof body.threadId === "string" && typeof body.clientUserMessageId === "string" && body.clientUserMessageId
    ? JSON.stringify(["input", body.threadId, body.clientUserMessageId]) : JSON.stringify(["rpc", method, fallback]);
}
export const codexAdmissionPaused = (directory: string): boolean => existsSync(join(directory, CODEX_ADMISSION_PAUSE_FILE));
export const codexMaintenanceError = () => ({ code: -32000, message: "New Codex tasks are temporarily unavailable during maintenance", data: { retryable: true } });
export interface CodexMaintenanceSnapshot {
  paused: boolean;
  pendingAdmissions: number;
  queued: number;
  unknown: number;
  activeGoals: number;
  pendingTitles: number;
  pendingApprovals: number;
  capacityRetries: number;
}

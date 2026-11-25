import { isThreadGoalPauseRequest } from "@opencraft/appserver-protocol";
import { COLLABORATION_METHOD } from "@opencraft/appserver-protocol/collaboration";

export const CODEX_MAINTENANCE_READ = "opencraft/codex/maintenance/read";
export const codexMaintenanceError = () => ({
  code: -32000,
  message: "New Codex tasks are temporarily unavailable during maintenance",
  data: { retryable: true },
});

const admissions = new Set([
  "thread/start",
  "thread/fork",
  "turn/start",
  "thread/queue/add",
  "thread/goal/set",
  "command/exec",
  "process/spawn",
  "thread/shellCommand",
  COLLABORATION_METHOD,
]);

export function isCodexAdmission(method: unknown, params?: unknown): boolean {
  if (isThreadGoalPauseRequest(method, params)) return false;
  const body =
    params !== null && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  if (
    method === "thread/goal/set" &&
    body.status === "complete" &&
    Object.keys(body).every((key) => key === "threadId" || key === "status")
  )
    return false;
  return typeof method === "string" && admissions.has(method);
}

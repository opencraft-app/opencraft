import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface SandboxLifecycleEvent {
  event: "starting" | "started" | "stdin-eof" | "failed" | "closed" | "close-requested" | "unit-start" | "unit-exited" | "environment-status" | "owner-stop";
  sandboxId?: string;
  unit?: string;
  reason?: "signal" | "output-closed" | "stdin-write-failed" | "command-finished" | "transport-failed" | "owner-close" | "startup-failed";
  status?: string;
  code?: number | null;
  signal?: string;
  exitSignal?: number;
  resourceFailure?: "oom-kill" | "resources";
}

/** Metadata only: task arguments, environment values and error text never enter this sink. */
export function sandboxLifecycleLogger(path: string, ownerPid?: number) {
  if (!isAbsolute(path)) throw new Error("Sandbox lifecycle log requires an absolute path");
  let pending = Promise.resolve(), reported = false;
  const log = (value: SandboxLifecycleEvent) => {
    const row: Record<string, unknown> = {at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, event: value.event};
    if (Number.isSafeInteger(ownerPid) && ownerPid! > 0) row.ownerPid = ownerPid;
    for (const key of ["sandboxId", "unit"] as const) {
      const text = value[key];
      if (typeof text === "string" && /^[A-Za-z0-9_.@-]{1,192}$/u.test(text)) row[key] = text;
    }
    if (value.resourceFailure === "oom-kill" || value.resourceFailure === "resources") row.resourceFailure = value.resourceFailure;
    if (value.reason && ["signal", "output-closed", "stdin-write-failed", "command-finished", "transport-failed", "owner-close", "startup-failed"].includes(value.reason)) row.reason = value.reason;
    if (["ready", "pending", "disconnected", "unknown"].includes(value.status ?? "")) row.status = value.status;
    if (value.code === null || Number.isSafeInteger(value.code)) row.code = value.code;
    if (Number.isSafeInteger(value.exitSignal) && value.exitSignal! > 0 && value.exitSignal! <= 64) row.exitSignal = value.exitSignal;
    if (typeof value.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(value.signal)) row.signal = value.signal;
    pending = pending.then(() => appendFile(path, JSON.stringify(row) + "\n", {mode: 0o600})).catch(() => {
      if (!reported) { reported = true; console.warn("Sandbox lifecycle diagnostics unavailable"); }
    });
  };
  return Object.assign(log, {flush: () => pending});
}

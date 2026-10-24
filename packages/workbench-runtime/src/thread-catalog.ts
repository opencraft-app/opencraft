import type { Thread } from "@opencraft/appserver-protocol/generated/v2";

import type { WorkbenchThread } from "./models";

function projectStatus(thread: Thread): WorkbenchThread["status"] {
  const type = typeof thread.status === "object" && thread.status !== null && "type" in thread.status
    ? String(thread.status.type)
    : "idle";
  if (thread.status?.type === "active") {
    return thread.status.activeFlags?.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
      ? "review" : "running";
  }
  if (type === "systemError") return "error";
  return "ready";
}

function relativeTime(timestampSeconds: number, nowMs: number): string {
  const deltaMinutes = Math.max(0, Math.floor((nowMs / 1_000 - timestampSeconds) / 60));
  if (deltaMinutes < 1) return "Now";
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Pure Thread catalog projection shared by Vite, Expo Web and iPad. */
export function projectAppServerThread(
  thread: Thread & { pinned?: boolean },
  nowMs = Date.now(),
): WorkbenchThread {
  const parts = thread.cwd.split("/").filter(Boolean);
  return {
    id: thread.id,
    pinned: thread.pinned === true,
    title: thread.name?.replace(/^☁️\s*/u, "") || thread.preview || "New chat",
    project: parts.at(-1) ?? "Workspace",
    lineage: thread.parentThreadId !== null ? "subagent" : thread.forkedFromId !== null ? "fork" : "root",
    time: relativeTime(thread.updatedAt, nowMs),
    updatedAt: thread.recencyAt ?? thread.updatedAt,
    createdAt: thread.createdAt,
    status: projectStatus(thread),
  };
}

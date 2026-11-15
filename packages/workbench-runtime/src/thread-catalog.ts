import { parseNativeConversationProject } from "@opencraft/appserver-protocol";
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

const AGENT_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  codebuddy: "CodeBuddy",
  pi: "Pi",
};

/** Opaque session tokens are not a workspace or a title. */
export function looksLikeThreadToken(value: string): boolean {
  const text = value.trim();
  return /^(?:thread-|codex_|cursor_|claude_|codebuddy_|pi_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(text);
}

export function conversationAgentLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return AGENT_LABELS[provider] ?? null;
}

function directoryLabel(cwd: string, threadId: string, nativeName?: string): string {
  const folder = (nativeName?.trim() || cwd.split("/").filter(Boolean).at(-1) || "").trim();
  if (!folder || folder === threadId || looksLikeThreadToken(folder)) return "";
  return folder;
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
  thread: Thread & { pinned?: boolean; visibility?: "visible" | "hidden"; accessMode?: "shared" | "private" },
  nowMs = Date.now(),
): WorkbenchThread {
  const nativeProject = parseNativeConversationProject((thread as Thread & { nativeProject?: unknown }).nativeProject);
  const agentLabel = conversationAgentLabel(thread.modelProvider);
  return {
    id: thread.id,
    pinned: thread.pinned === true,
    title: thread.name?.replace(/^☁️\s*/u, "").trim() || thread.preview?.trim()
      || thread.agentNickname?.trim()
      || (thread.parentThreadId != null
        ? [thread.agentRole?.trim(), `#${thread.id.slice(-8)}`].filter(Boolean).join(" · ")
        : "New chat"),
    project: directoryLabel(thread.cwd ?? "", thread.id, nativeProject?.name),
    ...(agentLabel ? { agentLabel } : {}),
    ...(nativeProject ? { nativeProject } : {}),
    lineage: thread.parentThreadId != null ? "subagent" : thread.forkedFromId != null ? "fork" : "root",
    parentThreadId: thread.parentThreadId ?? null,
    ...(thread.visibility === undefined ? {} : { visibility: thread.visibility }),
    ...(thread.accessMode === "private" || thread.accessMode === "shared" ? {accessMode:thread.accessMode} : {}),
    time: relativeTime(thread.updatedAt, nowMs),
    updatedAt: thread.recencyAt ?? thread.updatedAt,
    createdAt: thread.createdAt,
    status: projectStatus(thread),
  };
}

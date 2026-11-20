import { parseNativeConversationProject } from "@opencraft/appserver-protocol";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";

import type { WorkbenchThread } from "./models";

const agentLabels: Readonly<Record<string, string>> = { codex: "Codex", cursor: "Cursor", "claude-code": "Claude Code", gemini: "Gemini",
  codebuddy: "CodeBuddy CLI", "codebuddy-ide": "CodeBuddy IDE", pi: "Pi", "pi-cli": "Pi", "pi-bridge": "Pi", "codex-bridge": "Codex", "dsh-acp": "DSH" };

/** Resolve only declared ownership. A model provider is not an Agent identity. */
export function projectThreadAgent(threadId: string, declaration: unknown): WorkbenchThread["agent"] {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return undefined;
  const row = declaration as Record<string, unknown>;
  const candidates = (Array.isArray(row.providers) ? row.providers : []).flatMap((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const provider = value as Record<string, unknown>;
    if (typeof provider.id !== "string" || !provider.id.trim() || provider.id.length > 128) return [];
    const matches = [provider.threadPrefix, provider.modelPrefix].filter((prefix): prefix is string => typeof prefix === "string" && prefix.length > 0 && threadId.startsWith(prefix));
    return matches.length ? [{ provider, length: Math.max(...matches.map(prefix => prefix.length)) }] : [];
  }).sort((a, b) => b.length - a.length);
  const provider = candidates[0]?.provider;
  const id = provider?.id ?? row.defaultEngine;
  if (typeof id !== "string" || !id.trim() || id.length > 128) return undefined;
  const label = typeof provider?.label === "string" && provider.label.trim() ? provider.label.trim().slice(0, 128) : agentLabels[id];
  return { id, ...(label ? { label } : {}) };
}

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
  thread: Thread & { pinned?: boolean; visibility?: "visible" | "hidden"; accessMode?: "shared" | "private" },
  nowMs = Date.now(),
  executionEngines?: unknown,
): WorkbenchThread {
  const nativeProject = parseNativeConversationProject((thread as Thread & { nativeProject?: unknown }).nativeProject);
  const agent = projectThreadAgent(thread.id, executionEngines);
  const parts = thread.cwd.split("/").filter(Boolean);
  return {
    id: thread.id,
    cwd: thread.cwd,
    pinned: thread.pinned === true,
    title: thread.name?.replace(/^☁️\s*/u, "").trim() || thread.preview?.trim()
      || thread.agentNickname?.trim()
      || (thread.parentThreadId != null
        ? [thread.agentRole?.trim(), `#${thread.id.slice(-8)}`].filter(Boolean).join(" · ")
        : "New chat"),
    project: nativeProject?.name ?? parts.at(-1) ?? "Workspace",
    ...(nativeProject ? { nativeProject } : {}),
    ...(agent ? { agent } : {}),
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

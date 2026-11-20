import type { NativeConversationProject } from "@opencraft/appserver-protocol";
import type { TimelineSnapshot } from "@opencraft/chat-core";

export type ThreadStatus = "ready" | "running" | "review" | "error";

export interface WorkbenchThread {
  id: string;
  title: string;
  project: string;
  /** Product name of the executing agent. Absent when the provider is unknown. */
  agentLabel?: string;
  nativeProject?: NativeConversationProject;
  lineage: "root" | "fork" | "subagent";
  /** Host-authored topology. Missing metadata never implies a parent. */
  parentThreadId?: string | null;
  /** Hidden conversations remain addressable through their parent. */
  visibility?: "visible" | "hidden";
  /** Authenticated directory policy; private rows are visible only to their creator. */
  accessMode?: "shared" | "private";
  /** Per-reader server fact; unknown on legacy peers, never a permission. */
  createdByViewer?: boolean;
  time: string;
  /** Canonical AppServer recency timestamp in seconds. */
  updatedAt: number;
  /** Native creation time in seconds, absent for providers without this metadata. */
  createdAt?: number;
  status: ThreadStatus;
  unread?: boolean;
  /** Native backend metadata, never a client-local preference. */
  pinned?: boolean;
}

export interface WorkbenchFileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted";
}

export interface WorkbenchSnapshot {
  revision: number;
  activeThreadId: string;
  streamingThreadId: string | null;
  threads: readonly WorkbenchThread[];
  timelinesByThreadId: Readonly<Record<string, TimelineSnapshot>>;
  changedFiles: readonly WorkbenchFileChange[];
}

export function getActiveTimeline(snapshot: WorkbenchSnapshot): TimelineSnapshot | null {
  return snapshot.timelinesByThreadId[snapshot.activeThreadId] ?? null;
}

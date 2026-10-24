import type { TimelineSnapshot } from "@opencraft/chat-core";

export type ThreadStatus = "ready" | "running" | "review" | "error";

export interface WorkbenchThread {
  id: string;
  title: string;
  project: string;
  lineage: "root" | "fork" | "subagent";
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

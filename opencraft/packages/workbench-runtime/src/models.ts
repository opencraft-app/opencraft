import type { TimelineSnapshot } from "@opencraft/chat-core";

export type ThreadStatus = "ready" | "running" | "review";

export interface WorkbenchThread {
  id: string;
  title: string;
  project: string;
  lineage: "root" | "fork" | "subagent";
  time: string;
  status: ThreadStatus;
  unread?: boolean;
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

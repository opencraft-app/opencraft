import type { ThreadServerOrigin } from "@opencraft/workbench-runtime";
import { sidebarThreadIdentity, type SidebarThreadTreeNode, type SidebarTreeThread } from "./sidebar-thread-tree";

interface SidebarActivityState {
  readonly status: string;
  readonly unread?: boolean;
  readonly goalActive?: boolean;
}

/** The row and its group summary consume the same activity precedence. */
export function sidebarActivityIndicator(thread: SidebarActivityState): "goal" | "running" | "attention" | "unread" | "none" {
  if (thread.goalActive && (thread.status === "ready" || thread.status === "running")) return "goal";
  if (thread.status === "running") return "running";
  if (thread.status === "review" || thread.status === "error") return "attention";
  return thread.status === "ready" && thread.unread ? "unread" : "none";
}

export interface SidebarActivitySummary {
  readonly unread: number;
  readonly attention: number;
  readonly running: number;
}

/** Count the full filtered tree, independent of disclosure and pagination. */
export function summarizeSidebarActivity<T extends SidebarTreeThread & SidebarActivityState>(
  roots: readonly SidebarThreadTreeNode<T>[],
  isUnread: (thread: T) => boolean = thread => Boolean(thread.unread),
): SidebarActivitySummary {
  const summary = { unread: 0, attention: 0, running: 0 };
  const seen = new Set<string>();
  const pending = [...roots];
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index]!;
    const key = sidebarThreadIdentity(node.thread);
    if (seen.has(key)) continue;
    seen.add(key);
    if (node.thread.visibility === "hidden") continue;
    const indicator = sidebarActivityIndicator({ ...node.thread, unread: isUnread(node.thread) });
    if (indicator === "goal" || indicator === "running") summary.running++;
    else if (indicator !== "none") summary[indicator]++;
    pending.push(...node.children);
  }
  return summary;
}

export interface SidebarActivityThread {
  readonly id: string;
  readonly serverOrigin: ThreadServerOrigin;
  readonly project: string;
  /** AppServer timestamps are expressed in seconds. */
  readonly updatedAt: number;
  readonly createdAt?: number;
}

export interface SidebarActivityGroup<T extends SidebarActivityThread> {
  readonly key: string;
  readonly label: string;
  readonly threads: readonly T[];
}

function localDayStart(timestampMs: number): Date {
  const value = new Date(timestampMs);
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function localDayKey(day: Date): string {
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-");
}

function activityDayLabel(day: Date, today: Date, locale?: string): string {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const relativeLabel = (offset: number) => {
    const value = relative.format(offset, "day");
    return value.length === 0 ? value : `${value[0]!.toLocaleUpperCase(locale)}${value.slice(1)}`;
  };
  if (localDayKey(day) === localDayKey(today)) return relativeLabel(0);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (localDayKey(day) === localDayKey(yesterday)) return relativeLabel(-1);
  const elapsedDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (elapsedDays < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(day);
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(day);
}

/**
 * Activity chronology owns sections. Server provenance remains per task while
 * Hub route, Host placement and activity status stay orthogonal.
 */
export function groupThreadsByActivityDate<T extends SidebarActivityThread>(
  threads: readonly T[],
  nowMs = Date.now(),
  locale?: string,
): readonly SidebarActivityGroup<T>[] {
  const today = localDayStart(nowMs);
  const groups = new Map<string, { day: Date; threads: T[] }>();
  const ordered = [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const thread of ordered) {
    const day = localDayStart(thread.updatedAt * 1_000);
    const key = localDayKey(day);
    const group = groups.get(key);
    if (group) group.threads.push(thread);
    else groups.set(key, { day, threads: [thread] });
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    label: activityDayLabel(group.day, today, locale),
    threads: group.threads,
  }));
}

export function sidebarActivityMetadata(thread: SidebarActivityThread): {
  readonly project: string;
} {
  return {
    project: thread.project.trim() || "Workspace",
  };
}

/** Headings follow consecutive local days; the consumer chooses its dated rows. */
export function sidebarActivityDateHeadings<T extends SidebarActivityThread>(
  threads: readonly T[], nowMs = Date.now(), locale?: string,
): ReadonlyMap<T, string> {
  const headings = new Map<T, string>();
  const today = localDayStart(nowMs);
  let previousDay: string | undefined;
  for (const thread of threads) {
    const day = localDayStart(thread.updatedAt * 1_000);
    const key = localDayKey(day);
    if (key !== previousDay) headings.set(thread, activityDayLabel(day, today, locale));
    previousDay = key;
  }
  return headings;
}

export type SidebarRecentHeading = "running" | "date";

/** Project only the displayed Recent page. Running priority is a present state,
 * not a historical day. Boundaries do not depend on the current calendar day. */
export function sidebarRecentHeadings<T extends SidebarActivityThread & { readonly status: string }>(
  threads: readonly T[],
): ReadonlyMap<T, SidebarRecentHeading> {
  const headings = new Map<T, SidebarRecentHeading>();
  let running = false, previousDay: string | undefined;
  for (const thread of threads) {
    if (thread.status === "running") {
      if (!running) headings.set(thread, "running");
      running = true;
    } else {
      const key = localDayKey(localDayStart(thread.updatedAt * 1_000));
      if (key !== previousDay) headings.set(thread, "date");
      previousDay = key;
    }
  }
  return headings;
}

export function sidebarActivityDateLabel(timestampMs: number, nowMs: number, locale?: string): string {
  return activityDayLabel(localDayStart(timestampMs), localDayStart(nowMs), locale);
}

/** Running rows stay ahead; all rows use the catalog's canonical recency clock. */
function compareRecentThreads(
  left: SidebarActivityThread & { readonly status: string },
  right: SidebarActivityThread & { readonly status: string },
): number {
  const leftRunning = left.status === "running";
  const rightRunning = right.status === "running";
  if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
  const recency = right.updatedAt - left.updatedAt;
  if (recency !== 0) return recency;
  if (leftRunning) {
    const leftKey = JSON.stringify([left.serverOrigin.serverId, left.id]);
    const rightKey = JSON.stringify([right.serverOrigin.serverId, right.id]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }
  return right.updatedAt - left.updatedAt;
}

/** Waits and failures need attention; unread is only an independent badge.
 * Taskflow precedence deduplicates groups; view pagination consumes full groups. */
export function groupThreadsByTaskFlow<T extends SidebarActivityThread & {
  readonly status: string; readonly unread?: boolean; readonly pinned?: boolean;
}>(threads: readonly T[]) {
  const attention: T[] = [], pinned: T[] = [], recent: T[] = [];
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (thread.status === "review" || thread.status === "error") attention.push(thread);
    else if (thread.pinned) pinned.push(thread);
    else recent.push(thread);
  }
  recent.sort(compareRecentThreads);
  return { attention, pinned, recent };
}

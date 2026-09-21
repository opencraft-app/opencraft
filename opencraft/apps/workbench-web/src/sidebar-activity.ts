export interface SidebarActivityThread {
  readonly id: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly project: string;
  /** AppServer timestamps are expressed in seconds. */
  readonly updatedAt: number;
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
 * Codex Activity-style presentation: chronology owns sections; Host remains
 * provenance on each task and never changes the task's execution owner.
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
  readonly host: string | null;
} {
  const host = thread.hostLabel.trim();
  const isLocal = thread.hostId === "local" || host.toLocaleLowerCase() === "local";
  return {
    project: thread.project.trim() || "Workspace",
    host: isLocal || host.length === 0 ? null : host,
  };
}

import type { ConversationScheduleSummary } from "@opencraft/appserver-protocol";

/** The Host catalog is authoritative; visible conversation pagination and personal filters are not. */
export function projectScheduledTaskRows(
  catalogs: readonly { hostId: string; schedules: readonly ConversationScheduleSummary[]; titleByThreadId?: Readonly<Record<string, string>> }[],
  threads: readonly { id: string; connectionHostId: string; title: string }[],
) {
  const titles = new Map(threads.map(thread => [JSON.stringify([thread.connectionHostId, thread.id]), thread.title]));
  return catalogs.flatMap(host => host.schedules.map(schedule => ({
    ...schedule, hostId: host.hostId,
    title: titles.get(JSON.stringify([host.hostId, schedule.threadId])) || host.titleByThreadId?.[schedule.threadId] || schedule.threadId,
  }))).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || a.nextRunAt - b.nextRunAt || a.hostId.localeCompare(b.hostId) || a.threadId.localeCompare(b.threadId));
}

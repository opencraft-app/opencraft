/** Presentation only: grouping never changes a thread's execution owner. */
export function groupThreadsByTarget<T extends { hostId: string; hostLabel: string }>(threads: readonly T[]) {
  const groups = new Map<string, { id: string; label: string; threads: T[] }>();
  for (const thread of threads) {
    let group = groups.get(thread.hostId);
    if (!group) {
      group = { id: thread.hostId, label: thread.hostLabel || thread.hostId, threads: [] };
      groups.set(thread.hostId, group);
    }
    group.threads.push(thread);
  }
  return [...groups.values()];
}

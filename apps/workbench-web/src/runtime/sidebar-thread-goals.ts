import { threadGoalNeedsResume } from "@opencraft/appserver-protocol";
import type { ThreadGoalResource } from "@opencraft/workbench-runtime";

export interface SidebarGoalSource {
  readonly goals: ThreadGoalResource;
  readonly threadIds: readonly string[];
  /** Recheck the live Host recipe, authorization and readiness before each read. */
  readonly isCurrent: () => boolean;
}

const readers = new WeakMap<ThreadGoalResource, { running: number; pumps: Set<() => void> }>();

/** Metadata-only hydration, bounded like sidebar attention catch-up. No polling,
 * connection establishment, Thread resume or Goal mutation belongs here. */
export function observeSidebarThreadGoals(source: SidebarGoalSource, notify: () => void): () => void {
  let disposed = false;
  let pumping = false;
  const reader = readers.get(source.goals) ?? { running: 0, pumps: new Set<() => void>() };
  readers.set(source.goals, reader);
  const ids = [...new Set(source.threadIds)].slice(0, 50);
  const pump = () => {
    if (disposed || pumping || !source.isCurrent() || !source.goals.capability()?.read) return;
    pumping = true;
    try {
      for (const id of ids) {
        if (reader.running >= 3 || disposed || !source.isCurrent()) break;
        // A multi-engine Host can support Goals while this Thread does not.
        // refresh then returns without leaving idle; scheduling it again from
        // finally would otherwise starve the event loop with resolved promises.
        if (!source.goals.capability(id)?.read) continue;
        // Failures wait for a connection reset; never form a retry loop.
        if (source.goals.getSnapshot(id).phase !== "idle") continue;
        reader.running++;
        void source.goals.refresh(id).catch(() => undefined).finally(() => {
          reader.running--;
          for (const resume of reader.pumps) resume();
        });
      }
    } finally { pumping = false; }
  };
  reader.pumps.add(pump);
  const unsubscribe = source.goals.subscribeCatalog(() => { notify(); pump(); });
  pump();
  return () => { disposed = true; reader.pumps.delete(pump); unsubscribe(); };
}

/** Only mode changes repaint the list; usage counters are not row activity. */
export function sidebarGoalSignature(sources: readonly SidebarGoalSource[]): string {
  return sources.map(source => source.isCurrent() && source.goals.capability()?.read
    ? source.threadIds.map(id => source.goals.capability(id)?.read && sidebarGoalActive(source.goals.getSnapshot(id).goal) ? "1" : "0").join("")
    : "").join("|");
}

export function sidebarGoalActive(goal: unknown): boolean {
  return typeof goal === "object" && goal !== null && "status" in goal && goal.status === "active" && !threadGoalNeedsResume(goal);
}

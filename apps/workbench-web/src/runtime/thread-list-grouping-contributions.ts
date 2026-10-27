import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import type { ThreadListGroupingContribution } from "@opencraft/extension-react";

/** Product validation stays at the adapter; the core owns registration lifetime. */
export class ThreadListGroupingContributionRegistry extends SingleContributionRegistry<ThreadListGroupingContribution> {
  constructor() {
    super("thread list grouping", isContribution);
  }
}

function isContribution(value: unknown): value is ThreadListGroupingContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ThreadListGroupingContribution>;
  return typeof candidate.id === "string" && candidate.id.trim().length > 0
    && typeof candidate.getSnapshot === "function"
    && typeof candidate.subscribe === "function"
    && typeof candidate.watch === "function"
    && typeof candidate.project === "function"
    && typeof candidate.setMode === "function"
    && typeof candidate.toggleGroup === "function"
    && (candidate.isParticipant === undefined || typeof candidate.isParticipant === "function")
    && (candidate.filterThreads === undefined || typeof candidate.filterThreads === "function")
    && (candidate.setFilterEnabled === undefined || typeof candidate.setFilterEnabled === "function");
}

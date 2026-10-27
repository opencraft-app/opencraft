import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import type { ThreadBadgeContribution } from "@opencraft/extension-react";

// Adding a typed placement must also update runtime acceptance.
const placements = {
  trailing: true,
  metadata: true,
  title: true,
} satisfies Record<NonNullable<ThreadBadgeContribution["placement"]>, true>;

/** Product validation stays at the adapter; the core owns registration lifetime. */
export class ThreadBadgeContributionRegistry extends SingleContributionRegistry<ThreadBadgeContribution> {
  constructor() {
    super("thread badge", isContribution);
  }
}

function isContribution(value: unknown): value is ThreadBadgeContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ThreadBadgeContribution>;
  return typeof candidate.id === "string" && candidate.id.trim().length > 0
    && typeof candidate.Component === "function"
    && (candidate.placement === undefined
      || (typeof candidate.placement === "string" && Object.hasOwn(placements, candidate.placement)));
}

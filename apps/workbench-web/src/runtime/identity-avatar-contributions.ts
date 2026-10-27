import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import type { IdentityAvatarContribution } from "@opencraft/extension-react";

/** Product validation stays at the adapter; the core owns registration lifetime. */
export class IdentityAvatarContributionRegistry extends SingleContributionRegistry<IdentityAvatarContribution> {
  constructor() {
    super("identity avatar", isContribution);
  }
}

function isContribution(value: unknown): value is IdentityAvatarContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IdentityAvatarContribution>;
  return typeof candidate.id === "string" && candidate.id.trim().length > 0
    && typeof candidate.resolve === "function";
}

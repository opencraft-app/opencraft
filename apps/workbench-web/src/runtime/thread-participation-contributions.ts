import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import type { ThreadParticipationContribution } from "@opencraft/extension-react";

export class ThreadParticipationContributionRegistry extends SingleContributionRegistry<ThreadParticipationContribution> {
  constructor() {
    super("thread participation", (value): value is ThreadParticipationContribution => {
      const candidate = value as Partial<ThreadParticipationContribution> | null;
      return !!candidate && typeof candidate.id === "string" && !!candidate.id.trim() && typeof candidate.read === "function";
    });
  }
}

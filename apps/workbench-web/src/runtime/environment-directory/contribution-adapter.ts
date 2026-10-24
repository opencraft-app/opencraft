import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import type { EnvironmentDirectory, EnvironmentSource } from "@opencraft/workbench-runtime";
export function environmentSourceAdapter(directory: EnvironmentDirectory): InternalContributionAdapter {
  return {prepare: (owner, value) => ({commit: () => directory.register(owner.activationId, value as EnvironmentSource)})};
}

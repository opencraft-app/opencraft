import type { ManagedBuiltinExtension } from "@opencraft/extension-runtime";

/** View-only optional installation; collection belongs to the execution Host. */
export const tokenUsageBuiltin: ManagedBuiltinExtension = {
  manifest: {
    manifestVersion: 1,
    id: "opencraft.token-usage",
    name: "Token usage",
    description: "View personal allocation and authorized team token usage.",
    version: "0.1.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web", "electron"],
    activationEvents: ["onStartupFinished"],
  },
  defaultEnabled: true,
  load: async () => (await import("./token-usage-extension")).tokenUsageExtension,
};

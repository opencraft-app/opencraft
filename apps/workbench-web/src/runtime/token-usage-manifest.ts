import type { ManagedBuiltinExtension } from "@opencraft/extension-runtime";

/** Stable metadata shared without importing the builtin installation loader. */
export const tokenUsageManifest: ManagedBuiltinExtension["manifest"] = {
  manifestVersion: 1,
  id: "opencraft.token-usage",
  name: "Token usage",
  description: "View personal allocation and authorized team token usage.",
  version: "0.1.0",
  apiVersion: 1,
  trust: "trusted",
  platforms: ["web", "electron"],
  activationEvents: ["onStartupFinished"],
};

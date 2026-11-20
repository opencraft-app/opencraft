import type { ManagedBuiltinExtension } from "@opencraft/extension-runtime";
import { tokenUsageManifest } from "./token-usage-manifest";

/** View-only optional installation; collection belongs to the execution Host. */
export const tokenUsageBuiltin: ManagedBuiltinExtension = {
  manifest: tokenUsageManifest,
  defaultEnabled: true,
  load: async () => (await import("./token-usage-extension")).tokenUsageExtension,
};

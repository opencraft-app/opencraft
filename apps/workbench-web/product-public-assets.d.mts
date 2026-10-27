import type { Plugin } from "vite";

/** Select a product-owned local public directory through trusted build input. */
export function productPublicAssets(
  workspaceRoot: string,
  configuredDirectory: string | undefined,
): Plugin | null;

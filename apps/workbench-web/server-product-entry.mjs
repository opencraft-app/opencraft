import { statSync } from "node:fs";
import path from "node:path";

/** Executable input selected by the trusted build owner, not browser config. */
export function resolveServerProductEntry(workspaceRoot, configuredEntry) {
  return resolveProductEntry(workspaceRoot, configuredEntry, "OPENCRAFT_SERVER_EXTENSIONS_ENTRY", "server-product-extensions.ts");
}

export function resolveClientProductEntry(workspaceRoot, configuredEntry) {
  return resolveProductEntry(workspaceRoot, configuredEntry, "OPENCRAFT_CLIENT_PRODUCT_ENTRY", "client-product-entry.ts");
}

export function resolveEmbeddedProductEntry(workspaceRoot, configuredEntry) {
  return resolveProductEntry(workspaceRoot, configuredEntry, "OPENCRAFT_EMBEDDED_PRODUCT_ENTRY");
}

function resolveProductEntry(workspaceRoot, configuredEntry, option, defaultFile) {
  const entry = configuredEntry?.trim();
  if (!entry) return defaultFile ? path.resolve(workspaceRoot, `apps/workbench-web/src/runtime/${defaultFile}`) : null;
  if ((!path.isAbsolute(entry) && /^[a-z][a-z\d+.-]*:/iu.test(entry)) || !/\.(?:[cm]?[jt]s)$/u.test(entry)) {
    throw new Error(`${option} requires a local JavaScript or TypeScript file`);
  }
  const resolved = path.resolve(workspaceRoot, entry);
  if (!statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${option} does not name an existing file`);
  }
  return resolved;
}

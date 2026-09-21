import type { AppServerParams } from "../types/appserver.ts";

export function isThreadCatalogCheckpoint(params: AppServerParams = {}): boolean {
  if (params["archived"] === true || params["cursor"] !== null && params["cursor"] !== undefined) {
    return false;
  }
  const searchTerm = params["searchTerm"];
  if (searchTerm !== null && searchTerm !== undefined && String(searchTerm).length > 0) return false;
  if (
    params["parentThreadId"] !== null && params["parentThreadId"] !== undefined ||
    params["ancestorThreadId"] !== null && params["ancestorThreadId"] !== undefined
  ) return false;
  // `null` has filter semantics for these fields, so only their absence means
  // that Desktop requested the root catalog rather than one projected slice.
  for (const key of ["sectionId", "projectId", "cwd"] as const) {
    if (Object.prototype.hasOwnProperty.call(params, key)) return false;
  }
  return true;
}

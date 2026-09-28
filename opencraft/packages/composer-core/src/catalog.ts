import type { ComposerCatalogQuery } from "./model";

/** A bare Skill trigger browses the catalog; file search still requires text. */
export function shouldSearchComposerCatalog(kind: ComposerCatalogQuery["kind"], query: string): boolean {
  return kind === "skill" || query.trim().length > 0;
}

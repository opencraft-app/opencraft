/** Explicit discovery never changes the selected model or a running turn. */
export const MODEL_CATALOG_REFRESH_EXTENSION = "opencraft/model-catalog-refresh";
export const SCOPED_MODEL_REFRESH_EXTENSION = "opencraft/scoped-model-refresh";
export const MODEL_CATALOG_REFRESH_METHOD = "opencraft/models/refresh";
export interface ModelCatalogRefreshParams {
  readonly threadId?: string;
  readonly model?: string;
}

export interface ModelRouteParams {
  model?: unknown;
  collaborationMode?: {
    settings?: {
      model?: unknown;
    } | null;
  } | null;
}

export interface RuntimeModelHint {
  model?: unknown;
  providerId?: unknown;
}

export function effectiveRequestedModel(
  params: ModelRouteParams = {},
  runtimeHint: RuntimeModelHint | null = null,
): string | null {
  const explicit = typeof params.model === "string" ? params.model.trim() : "";
  if (explicit) return explicit;
  const collaboration = typeof params.collaborationMode?.settings?.model === "string"
    ? params.collaborationMode.settings.model.trim()
    : "";
  if (collaboration) return collaboration;
  if (typeof runtimeHint?.model === "string" && runtimeHint.model.trim()) {
    return runtimeHint.model.trim();
  }
  return typeof runtimeHint?.providerId === "string" ? runtimeHint.providerId : null;
}

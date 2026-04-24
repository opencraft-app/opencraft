export interface PlaygroundFallbackInfo {
  originalModel: string;
  resolvedModel: string;
  fallbackApplied: boolean;
  reason: string;
}

export function extractPlaygroundFallbackInfo(headers: Headers): PlaygroundFallbackInfo | null {
  const originalModel = headers.get("x-ai-gateway-original-model");
  const resolvedModel = headers.get("x-ai-gateway-resolved-model");
  const fallbackApplied = headers.get("x-ai-gateway-model-fallback") === "true";
  const reason = headers.get("x-ai-gateway-fallback-reason") ?? "";

  if (!originalModel || !resolvedModel) {
    return null;
  }

  return {
    originalModel,
    resolvedModel,
    fallbackApplied,
    reason,
  };
}

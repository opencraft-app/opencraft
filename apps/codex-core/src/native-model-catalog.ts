import { CONFIGURED_CODEX_MODEL_PREFIX } from "@opencraft/account-pool-host";

/** Native Codex materializes an absent default as `none`. For configured
 * models that do not declare that choice, restore absence at the wire boundary.
 * Do not invent a default or weaken validation for other inconsistent values. */
export function projectNativeModelCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) return value;
  const page = value as { data: unknown[] };
  return { ...page, data: page.data.map(entry => {
    if (!entry || typeof entry !== "object") return entry;
    const model = entry as { model?: unknown; defaultReasoningEffort?: unknown; supportedReasoningEfforts?: { reasoningEffort?: unknown }[] };
    if (typeof model.model !== "string" || !model.model.startsWith(CONFIGURED_CODEX_MODEL_PREFIX)
      || model.defaultReasoningEffort !== "none" || !Array.isArray(model.supportedReasoningEfforts)
      || model.supportedReasoningEfforts.some(option => option?.reasoningEffort === "none")) return entry;
    return { ...model, defaultReasoningEffort: null };
  }) };
}

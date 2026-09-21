/** Model-controlled request options. Absence is not a string-valued effort. */
export interface ReasoningCapability {
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
}
export function reasoningCapability(efforts: readonly string[], defaultEffort?: string | null): ReasoningCapability {
  if (efforts.length === 0) return { efforts: [], defaultEffort: null };
  if (efforts.some(value => !value) || new Set(efforts).size !== efforts.length) throw new Error("Invalid reasoning capability choices");
  if (defaultEffort != null && !efforts.includes(defaultEffort)) throw new Error("Default reasoning effort is outside the model capability");
  return { efforts: [...efforts], defaultEffort: defaultEffort ?? null };
}
/** Restore a selection against its target model, never against a global effort enum. */
export function resolveReasoningEffort(capability: ReasoningCapability, requested?: string | null): string | undefined {
  if (!capability.efforts.length) return undefined;
  return requested != null && capability.efforts.includes(requested) ? requested : capability.defaultEffort ?? undefined;
}

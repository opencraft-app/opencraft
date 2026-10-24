/** Personal defaults are account data; model availability remains Host-owned. */
export interface AccountModelSelection { readonly model: string; readonly effort: string | null; readonly serviceTier?: string | null; }
export interface AccountModelDefaultsRecord { readonly revision: number; readonly selection: AccountModelSelection | null; }
export interface AccountModelDefaultsPort {
  read(scope: string, hostId: string, signal: AbortSignal): Promise<AccountModelDefaultsRecord>;
  write(scope: string, hostId: string, revision: number, selection: AccountModelSelection, signal: AbortSignal): Promise<AccountModelDefaultsRecord>;
}
export function parseAccountModelSelection(value: unknown): AccountModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model selection");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => key !== "model" && key !== "effort" && key !== "serviceTier")
    || typeof item.model !== "string" || !item.model.trim() || item.model.length > 2048
    || !(item.effort === null || typeof item.effort === "string" && item.effort.length <= 128)
    || !(item.serviceTier === undefined || item.serviceTier === null || typeof item.serviceTier === "string" && item.serviceTier.trim().length > 0 && item.serviceTier.length <= 128)) throw new Error("Invalid model selection");
  return { model: item.model, effort: item.effort, ...(item.serviceTier === undefined ? {} : { serviceTier: item.serviceTier }) };
}
export function parseAccountModelDefaultsRecord(value: unknown): AccountModelDefaultsRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid model defaults");
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw new Error("Invalid model defaults revision");
  return { revision: item.revision as number, selection: item.selection === null ? null : parseAccountModelSelection(item.selection) };
}
export function validateModelDefaultsHost(hostId: unknown): asserts hostId is string {
  if (typeof hostId !== "string" || !hostId.trim() || hostId.length > 512) throw new Error("Invalid model defaults Host");
}

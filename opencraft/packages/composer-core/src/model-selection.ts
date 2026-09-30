export type ModelSelectionPolicy = "user" | "host-default";

/** Resolve only an explicit selection or a declared default, never catalog order. */
export function resolveModelSelection<T extends { readonly id: string; readonly value: string; readonly isDefault: boolean }>(
  models: readonly T[], selected: string | undefined | null,
): T | null {
  if (selected != null && selected !== "") return models.find(model => model.value === selected || model.id === selected) ?? null;
  return models.find(model => model.isDefault) ?? null;
}

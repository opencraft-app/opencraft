import type { ComposerModelOption } from "./composer-editor";

export interface ModelChoiceFamily {
  readonly id: string;
  readonly label: string;
  readonly models: readonly ComposerModelOption[];
  readonly variants: readonly { effort: string; model: ComposerModelOption }[];
}

// Codex ACP advertises concrete model IDs with bracketed effort values. A
// family only selects those exact catalog entries; it adds no effort override.
export function modelChoiceFamilies(models: readonly ComposerModelOption[]): ModelChoiceFamily[] {
  const families = new Map<string, { id: string; label: string; models: ComposerModelOption[]; variants: { effort: string; model: ComposerModelOption }[] }>();
  for (const model of models) {
    const variant = model.efforts.length === 0 ? /^(codex:[^\[\]]+)\[(none|minimal|low|medium|high|xhigh|max|ultra)\]$/u.exec(model.value) : null;
    const id = variant?.[1] ?? model.id;
    let family = families.get(id);
    if (!family) { family = { id, label: variant ? model.label.replace(/\s+\((?:none|minimal|low|medium|high|xhigh|max|ultra)\)$/iu, "") : model.label, models: [], variants: [] }; families.set(id, family); }
    family.models.push(model);
    if (variant) family.variants.push({ effort: variant[2]!, model });
  }
  return [...families.values()];
}

export function chooseFamilyModel(family: ModelChoiceFamily, selected: string | null): ComposerModelOption {
  const exact = family.models.find(model => model.value === selected || model.id === selected);
  const effort = selected ? /\[([^\]]+)\]$/u.exec(selected)?.[1] : null;
  return exact ?? family.variants.find(variant => variant.effort === effort)?.model
    ?? family.models.find(model => model.isDefault) ?? family.models[0]!;
}

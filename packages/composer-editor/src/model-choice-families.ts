import type { ComposerModelOption } from "./composer-editor";

export interface ModelChoiceFamily {
  readonly id: string;
  readonly label: string;
  readonly models: readonly ComposerModelOption[];
  readonly variants: readonly { effort: string; model: ComposerModelOption }[];
}

const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
function effortSuffix(model: string): { base: string; effort: string } | null {
  if (!model.endsWith("]")) return null;
  const open = model.indexOf("[");
  if (open < 0 || model.indexOf("]") !== model.length - 1) return null;
  const effort = model.slice(open + 1, -1);
  return efforts.has(effort) ? { base: model.slice(0, open), effort } : null;
}
function familyLabel(label: string): string {
  if (!label.endsWith(")")) return label;
  const open = label.lastIndexOf("(");
  if (open < 0 || !efforts.has(label.slice(open + 1, -1).toLowerCase())) return label;
  let end = open;
  while (end > 0 && /\s/u.test(label[end - 1]!)) end--;
  return end < open ? label.slice(0, end) : label;
}

// Codex ACP advertises concrete model IDs with bracketed effort values. A
// family only selects those exact catalog entries; it adds no effort override.
export function modelChoiceFamilies(models: readonly ComposerModelOption[]): ModelChoiceFamily[] {
  const families = new Map<string, { id: string; label: string; models: ComposerModelOption[]; variants: { effort: string; model: ComposerModelOption }[] }>();
  for (const model of models) {
    const variant = model.efforts.length === 0 && model.value.startsWith("codex:") ? effortSuffix(model.value) : null;
    const concrete = variant && variant.base.length > "codex:".length ? variant : null;
    const id = concrete?.base ?? model.id;
    let family = families.get(id);
    if (!family) { family = { id, label: concrete ? familyLabel(model.label) : model.label, models: [], variants: [] }; families.set(id, family); }
    family.models.push(model);
    if (concrete) family.variants.push({ effort: concrete.effort, model });
  }
  return [...families.values()];
}

export function chooseFamilyModel(family: ModelChoiceFamily, selected: string | null): ComposerModelOption {
  const exact = family.models.find(model => model.value === selected || model.id === selected);
  const effort = selected ? effortSuffix(selected)?.effort : null;
  return exact ?? family.variants.find(variant => variant.effort === effort)?.model
    ?? family.models.find(model => model.isDefault) ?? family.models[0]!;
}

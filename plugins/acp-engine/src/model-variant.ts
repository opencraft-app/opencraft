/** Read a native trailing parameter group without backtracking over the model ID. */
export function splitModelVariant(model: string): { base: string; parameters: string } | null {
  if (!model.endsWith("]")) return null;
  const open = model.lastIndexOf("[");
  if (open < 0 || model.indexOf("]", open) !== model.length - 1) return null;
  return { base: model.slice(0, open), parameters: model.slice(open + 1, -1) };
}

export function codexBaseModelId(model: string): string {
  if (!model.endsWith("]")) return model;
  const previousClose = model.lastIndexOf("]", model.length - 2);
  const open = model.indexOf("[", previousClose + 1);
  return open >= 0 && model.length > open + 2 ? model.slice(0, open) : model;
}

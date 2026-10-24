import { SingleContributionRegistry } from "@opencraft/extension-runtime";
import type { ImageEditorContribution } from "@opencraft/extension-react";

export class ImageEditorContributionRegistry extends SingleContributionRegistry<ImageEditorContribution> {
  constructor() { super("image editor", isContribution); }
}
function isContribution(value: unknown): value is ImageEditorContribution {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ImageEditorContribution>;
  return (candidate.styles === undefined || typeof candidate.styles === "string") && typeof candidate.id === "string" && candidate.id.trim().length > 0 && typeof candidate.Component === "function";
}

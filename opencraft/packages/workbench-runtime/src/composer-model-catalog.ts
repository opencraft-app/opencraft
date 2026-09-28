import type { CatalogModel as Model } from "@opencraft/appserver-protocol";
import { reasoningCapability, resolveModelSelection, modelInputModalities, type ModelInputModality } from "@opencraft/composer-core";

export interface WorkbenchReasoningEffortChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
}

/**
 * Platform-neutral model choice consumed by every Composer renderer.
 * AppServer owns availability; renderers only present this projection.
 */
export interface WorkbenchComposerModelChoice {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly inputModalities: readonly ModelInputModality[];
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly source: "builtin" | "custom" | null;
  readonly defaultEffort: string | null;
  readonly efforts: readonly WorkbenchReasoningEffortChoice[];
}

export function humanizeCatalogValue(value: string): string {
  return value
    .replace(/^:/u, "")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.length <= 3
      ? part.toUpperCase()
      : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function reasoningEffortLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "none": return "None";
    case "minimal": return "Minimal";
    case "low": return "Light";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra High";
    case "max": return "Max";
    case "ultra": return "Ultra";
    default: return humanizeCatalogValue(value);
  }
}

export function projectComposerModelChoices(
  models: readonly Model[],
): readonly WorkbenchComposerModelChoice[] {
  return models
    .filter((model) => !model.hidden)
    .map((model) => Object.freeze({
      id: model.id,
      value: model.model,
      label: model.displayName,
      description: model.description || null,
      isDefault: model.isDefault,
      inputModalities: modelInputModalities(model.inputModalities),
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      source: model.source ?? null,
      defaultEffort: reasoningCapability(model.supportedReasoningEfforts.map(e=>e.reasoningEffort),model.defaultReasoningEffort).defaultEffort,
      efforts: model.supportedReasoningEfforts.map((effort) => Object.freeze({
        value: effort.reasoningEffort,
        label: reasoningEffortLabel(effort.reasoningEffort),
        description: effort.description || null,
      })),
    }));
}

export function resolveComposerModelChoice(
  choices: readonly WorkbenchComposerModelChoice[],
  selectedModel: string | undefined,
): WorkbenchComposerModelChoice | null {
  return resolveModelSelection(choices, selectedModel);
}

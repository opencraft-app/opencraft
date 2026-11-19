import type { IntlShape } from "@opencraft/i18n";

const effortMessages = {
  none: { id: "composer.effort.none", defaultMessage: "None" },
  minimal: { id: "composer.effort.minimal", defaultMessage: "Minimal" },
  low: { id: "composer.effort.low", defaultMessage: "Low" },
  medium: { id: "composer.effort.medium", defaultMessage: "Medium" },
  high: { id: "composer.effort.high", defaultMessage: "High" },
  xhigh: { id: "composer.effort.xhigh", defaultMessage: "Extra High" },
  max: { id: "composer.effort.max", defaultMessage: "Max" },
  ultra: { id: "composer.effort.ultra", defaultMessage: "Ultra" },
};

export function modelEffortLabel(intl: IntlShape, value: string, fallback: string): string {
  const key = value.toLowerCase() === "extra-high" ? "xhigh" : value.toLowerCase();
  return Object.hasOwn(effortMessages, key) ? intl.formatMessage(effortMessages[key as keyof typeof effortMessages]) : fallback;
}

const nativeEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export function modelIdentifierPresentation(value: string): { label: string; effort: string | null } {
  const codex = value.startsWith("codex:");
  let name = codex ? value.slice("codex:".length) : value;
  let effort: string | null = null;
  if (codex && name.endsWith("]")) {
    const open = name.lastIndexOf("[");
    const suffix = name.slice(open + 1, -1);
    if (open > 0 && nativeEfforts.has(suffix)) { name = name.slice(0, open); effort = suffix; }
  }
  const label = name.replace(/^:/u, "").split(/[-_\s]+/u).filter(Boolean)
    .map(part => /^gpt$/iu.test(part) ? "GPT" : `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`).join(" ");
  return { label, effort };
}

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

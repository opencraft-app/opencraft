const formatters = new Map<string, Intl.NumberFormat>();

function narrowUnit(value: number, unit: string, locale: string): string {
  const key = `${locale}:${unit}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
    });
    formatters.set(key, formatter);
  }
  const language = locale.toLowerCase().split("-")[0];
  if (language === "zh") {
    return formatter.formatToParts(value)
      .map(part => part.type === "unit" ? ` ${part.value}` : part.value)
      .join("");
  }
  return language === "hu"
    ? formatter
        .formatToParts(value)
        .filter((part) => part.type !== "literal")
        .map((part) => part.value)
        .join("")
    : formatter.format(value);
}

/** Shared duration formatting for tools and work dividers. */
export function formatDuration(
  durationMs: number,
  {
    locale = "en",
    underOneSecond = "null",
    trimZeroUnits = false,
  }: {
    readonly locale?: string;
    readonly underOneSecond?: "null" | "zero";
    readonly trimZeroUnits?: boolean;
  } = {},
): string | null {
  const seconds = Math.floor(Math.max(durationMs, 0) / 1_000);
  if (seconds < 1)
    return underOneSecond === "zero" ? narrowUnit(0, "second", locale) : null;
  if (seconds < 60) return narrowUnit(seconds, "second", locale);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  const parts: [number, string][] =
    days > 0 || hours > 0
      ? [
          ...(days > 0 ? [[days, "day"] as [number, string]] : []),
          [hours, "hour"],
          [minutes, "minute"],
          [remainder, "second"],
        ]
      : [
          [minutes, "minute"],
          [remainder, "second"],
        ];
  return parts
    .filter(([value]) => !trimZeroUnits || value > 0)
    .map(([value, unit]) => narrowUnit(value, unit, locale))
    .join(" ");
}

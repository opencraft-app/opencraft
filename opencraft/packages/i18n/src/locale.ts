export const DEFAULT_LOCALE = "en-US";
export type LocaleSource = "IDE" | "SYSTEM" | "FIRST_AVAILABLE";

export interface LocaleInputs {
  readonly localeOverride?: string | null;
  readonly ideLocale?: string | null;
  readonly systemLocale?: string | null;
  readonly localeSource?: LocaleSource;
  readonly enabled?: boolean;
}

export function canonicalizeLocale(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) return undefined;
  try { return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0]; }
  catch { return undefined; }
}

export function isEnglishLocale(value: unknown): boolean {
  const locale = canonicalizeLocale(value);
  return locale !== undefined && new Intl.Locale(locale).language === "en";
}

/** Codex's override > configured IDE/system source selection, including its
 * non-English FIRST_AVAILABLE policy. Product region is not a locale source. */
export function resolveRequestedLocale(input: LocaleInputs): string {
  const override = canonicalizeLocale(input.localeOverride);
  if (override) return override;
  const ide = canonicalizeLocale(input.ideLocale);
  const system = canonicalizeLocale(input.systemLocale);
  switch (input.localeSource ?? "IDE") {
    case "SYSTEM": return system ?? DEFAULT_LOCALE;
    case "FIRST_AVAILABLE": return [ide, system].find(value => value && !isEnglishLocale(value)) ?? DEFAULT_LOCALE;
    case "IDE": return ide ?? DEFAULT_LOCALE;
    default: return ide ?? DEFAULT_LOCALE;
  }
}

const languageDefaults: Readonly<Record<string, string>> = { es: "es-419", fr: "fr-FR", pt: "pt-BR", zh: "zh-CN" };

export function resolveBestLocale(requested: string, supported: readonly string[]): string | undefined {
  const normalized = canonicalizeLocale(requested);
  if (!normalized) return undefined;
  const exact = supported.find(locale => canonicalizeLocale(locale) === normalized);
  if (exact) return exact;
  const target = new Intl.Locale(normalized);
  const candidates = supported.filter(locale => new Intl.Locale(locale).language === target.language).sort((a, b) => a.localeCompare(b));
  const region = target.region ?? target.maximize().region;
  // Preserve script variants (zh-Hant/zh-Hans) while choosing their region bundle.
  return candidates.find(locale => new Intl.Locale(locale).region === region)
    ?? candidates.find(locale => locale === languageDefaults[target.language])
    ?? candidates[0];
}

export function getLocaleTextDirection(value: string): "ltr" | "rtl" {
  const locale = new Intl.Locale(canonicalizeLocale(value) ?? DEFAULT_LOCALE) as Intl.Locale & {
    getTextInfo?: () => { direction: string };
    textInfo?: { direction: string };
  };
  const direction = locale.getTextInfo?.().direction ?? locale.textInfo?.direction;
  if (direction) return direction === "rtl" ? "rtl" : "ltr";
  return ["Arab", "Hebr", "Thaa", "Nkoo", "Adlm", "Syrc"].includes(locale.maximize().script ?? "") ? "rtl" : "ltr";
}

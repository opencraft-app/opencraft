import { canonicalizeLocale, LocaleRuntime } from "@opencraft/i18n";

/** Main is a projection consumer of the client preference, never an Agent locale owner. */
export function createDesktopLocaleRuntime() {
  return new LocaleRuntime([
    { locale: "zh-CN", label: "简体中文", load: async () => (await import("./locales/zh-CN.json")).default },
  ]);
}

export function requireDesktopLocale(value: unknown): string {
  const locale = canonicalizeLocale(value);
  if (!locale) throw new TypeError("Invalid application locale");
  return locale;
}

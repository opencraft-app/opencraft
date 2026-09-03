import type { PublicSiteLocale } from "@/lib/public-site-navigation";

const INTERNATIONAL_V2_HOME_LOCALES = new Set<PublicSiteLocale>([
  "en-US",
  "zh-SG",
  "zh-Hant",
  "id-ID",
  "es",
  "ja-JP",
  "ko-KR",
]);

export function shouldUseInternationalV2Home(isGlobalBuild: boolean, locale: PublicSiteLocale): boolean {
  return isGlobalBuild && INTERNATIONAL_V2_HOME_LOCALES.has(locale);
}

import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { PUBLIC_SITE_LOCALES } from "@/lib/public-site-routing";

const INTERNATIONAL_V2_HOME_LOCALES = new Set<PublicSiteLocale>([
  "en-US",
  "zh-SG",
  "zh-Hant",
  "id-ID",
  "es",
  "ja-JP",
  "ko-KR",
]);

const DOMESTIC_V2_HOME_LOCALES = new Set<PublicSiteLocale>([PUBLIC_SITE_LOCALES.ZH_CN]);

export function shouldUseInternationalV2Home(isGlobalBuild: boolean, locale: PublicSiteLocale): boolean {
  if (!isGlobalBuild) {
    return DOMESTIC_V2_HOME_LOCALES.has(locale);
  }

  return INTERNATIONAL_V2_HOME_LOCALES.has(locale);
}

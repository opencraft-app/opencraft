"use client";

import { useEffect, useState } from "react";

import { hadSavedLocaleBeforeInitialPage, setLocale } from "@/i18n";
import { localeDefinition, publishedLocaleDefinitions, type LocaleCode } from "@/i18n/locales.config";
import { PUBLIC_SITE_LOCALES } from "@/lib/public-site-routing";
import { isGlobal, localizedPath } from "@/lib/region";

const SUGGESTION_SEEN_KEY = "lw-language-suggestion-seen";

/** Browser language is only a hint for visitors without an explicit choice. */
export function suggestedLocaleForBrowserLanguage(languageTag: string): LocaleCode | null {
  let browserLocale: Intl.Locale;
  try {
    browserLocale = new Intl.Locale(languageTag);
  } catch {
    return null;
  }

  const available = publishedLocaleDefinitions();
  if (browserLocale.language === "zh") {
    const traditional = browserLocale.script === "Hant"
      || ["TW", "HK", "MO"].includes(browserLocale.region ?? "");
    const code = traditional ? PUBLIC_SITE_LOCALES.ZH_HANT : PUBLIC_SITE_LOCALES.ZH_SG;
    return available.some((definition) => definition.code === code) ? code : null;
  }

  const match = available.find((definition) =>
    definition.code !== PUBLIC_SITE_LOCALES.EN_US
    && definition.code !== PUBLIC_SITE_LOCALES.ZH_CN
    && new Intl.Locale(definition.code).language === browserLocale.language,
  );
  return match?.code ?? null;
}

export function BrowserLanguageSuggestion() {
  const [suggestedLocale, setSuggestedLocale] = useState<LocaleCode | null>(null);

  useEffect(() => {
    if (!isGlobal || window.location.pathname !== "/" || hadSavedLocaleBeforeInitialPage) return;
    try {
      if (window.localStorage.getItem(SUGGESTION_SEEN_KEY)) return;
    } catch {
      /* Private modes may deny storage; the suggestion still works for this page. */
    }
    const browserLanguage = navigator.languages?.[0] || navigator.language;
    const locale = browserLanguage ? suggestedLocaleForBrowserLanguage(browserLanguage) : null;
    if (!locale) return;
    try {
      window.localStorage.setItem(SUGGESTION_SEEN_KEY, "1");
    } catch {
      /* Do not block the suggestion if storage is unavailable. */
    }
    setSuggestedLocale(locale);
  }, []);

  if (!suggestedLocale) return null;

  const languageName = localeDefinition(suggestedLocale).displayName;
  const targetPath = localizedPath("/", suggestedLocale);

  return (
    <section
      aria-label="Language suggestion"
      className="fixed inset-x-4 top-20 z-[90] mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl sm:top-24"
    >
      <p className="text-sm leading-6">
        Your browser prefers <span lang={localeDefinition(suggestedLocale).htmlLang}>{languageName}</span>.{" "}
        Would you like to switch?
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
          href={targetPath}
          onClick={() => {
            setLocale(localeDefinition(suggestedLocale).i18nKey);
            setSuggestedLocale(null);
          }}
        >
          Switch to <span lang={localeDefinition(suggestedLocale).htmlLang}>{languageName}</span>
        </a>
        <button
          className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
          type="button"
          onClick={() => {
            setLocale(PUBLIC_SITE_LOCALES.EN_US);
            setSuggestedLocale(null);
          }}
        >
          Continue in English
        </button>
      </div>
    </section>
  );
}

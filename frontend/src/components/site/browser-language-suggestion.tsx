"use client";

import { useEffect, useState } from "react";

import { hasExplicitLocalePreference, setLocale } from "@/i18n";
import { localeDefinition, publishedLocaleDefinitions, type LocaleCode } from "@/i18n/locales.config";
import { PUBLIC_SITE_LOCALES } from "@/lib/public-site-routing";
import { isGlobal, localizedPath } from "@/lib/region";

const SUGGESTION_SEEN_KEY = "lw-language-suggestion-seen";
const SUGGESTION_COPY = {
  [PUBLIC_SITE_LOCALES.EN_US]: {
    ariaLabel: "Language suggestion", message: "Your browser prefers English. Would you like to switch?",
    switchLabel: "Switch to English", continueLabel: "Continue in English",
  },
  [PUBLIC_SITE_LOCALES.ZH_CN]: {
    ariaLabel: "语言切换建议", message: "浏览器首选语言是简体中文，是否切换？",
    switchLabel: "切换到简体中文", continueLabel: "继续使用英语",
  },
  [PUBLIC_SITE_LOCALES.ZH_SG]: {
    ariaLabel: "语言切换建议", message: "浏览器首选语言是简体中文，是否切换？",
    switchLabel: "切换到简体中文", continueLabel: "继续使用英语",
  },
  [PUBLIC_SITE_LOCALES.ZH_HANT]: {
    ariaLabel: "語言切換建議", message: "瀏覽器首選語言是繁體中文，是否切換？",
    switchLabel: "切換到繁體中文", continueLabel: "繼續使用英語",
  },
  [PUBLIC_SITE_LOCALES.ID_ID]: {
    ariaLabel: "Saran bahasa", message: "Bahasa utama browser Anda adalah Bahasa Indonesia. Ingin beralih?",
    switchLabel: "Beralih ke Bahasa Indonesia", continueLabel: "Lanjutkan dalam bahasa Inggris",
  },
  [PUBLIC_SITE_LOCALES.ES]: {
    ariaLabel: "Sugerencia de idioma", message: "El idioma preferido de tu navegador es español. ¿Quieres cambiar?",
    switchLabel: "Cambiar a español", continueLabel: "Continuar en inglés",
  },
  [PUBLIC_SITE_LOCALES.JA_JP]: {
    ariaLabel: "言語切り替えの提案", message: "ブラウザーの優先言語は日本語です。切り替えますか？",
    switchLabel: "日本語に切り替える", continueLabel: "英語のまま使う",
  },
  [PUBLIC_SITE_LOCALES.KO_KR]: {
    ariaLabel: "언어 전환 제안", message: "브라우저의 기본 언어는 한국어입니다. 전환하시겠어요?",
    switchLabel: "한국어로 전환", continueLabel: "영어로 계속",
  },
} satisfies Record<LocaleCode, {
  ariaLabel: string;
  message: string;
  switchLabel: string;
  continueLabel: string;
}>;

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
    if (!isGlobal || window.location.pathname !== "/" || hasExplicitLocalePreference()) return;
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

  const copy = SUGGESTION_COPY[suggestedLocale];
  const targetPath = localizedPath("/", suggestedLocale);

  return (
    <section
      aria-label={copy.ariaLabel}
      lang={localeDefinition(suggestedLocale).htmlLang}
      className="fixed inset-x-4 top-20 z-[85] mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl sm:top-24"
    >
      <p className="text-sm leading-6">{copy.message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
          href={targetPath}
          onClick={() => {
            setLocale(localeDefinition(suggestedLocale).i18nKey);
            setSuggestedLocale(null);
          }}
        >
          {copy.switchLabel}
        </a>
        <button
          className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
          type="button"
          onClick={() => {
            setLocale(PUBLIC_SITE_LOCALES.EN_US);
            setSuggestedLocale(null);
          }}
        >
          {copy.continueLabel}
        </button>
      </div>
    </section>
  );
}

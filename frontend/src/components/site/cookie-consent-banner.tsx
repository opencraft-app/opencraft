import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { localeDefinition, localeDefinitionByUrlLang, parseLocaleCode } from "@/i18n/locales.config";
import { isGlobal } from "@/lib/region";
import { PUBLIC_SITE_LOCALES, SWITCHER_VISIBLE_LOCALES } from "@/lib/public-site-routing";
import {
  readStoredCookieConsent,
  storeCookieConsent,
  type CookieConsentValue,
} from "@/lib/cookie-consent";

export const COOKIE_CONSENT_COPY = {
  [PUBLIC_SITE_LOCALES.EN_US]: {
    title: "Cookie Policy",
    description:
      "We use cookies to keep LightVela reliable, understand how the site is used, and improve your experience. You can accept all cookies or continue with necessary cookies only.",
    policy: "Cookie Policy",
    accept: "Accept all",
    necessary: "Necessary only",
  },
  [PUBLIC_SITE_LOCALES.ZH_CN]: {
    title: "我们使用 Cookie",
    description:
      "我们使用 Cookie 来保障 LightVela 稳定运行、了解网站使用情况，并优化您的体验。您可以接受全部 Cookie，或仅使用必要 Cookie。详情请查看",
    policy: "Cookie 政策",
    accept: "接受全部",
    necessary: "仅必要 Cookie",
  },
  [PUBLIC_SITE_LOCALES.ZH_HANT]: {
    title: "我們使用 Cookie",
    description:
      "我們使用 Cookie 來保障 LightVela 穩定運行、了解網站使用情況，並優化您的體驗。您可以接受全部 Cookie，或僅使用必要 Cookie。詳情請查看",
    policy: "Cookie 政策",
    accept: "接受全部",
    necessary: "僅必要 Cookie",
  },
  [PUBLIC_SITE_LOCALES.ID_ID]: {
    title: "Kami menggunakan Cookie",
    description:
      "Kami menggunakan Cookie untuk menjaga LightVela tetap stabil, memahami penggunaan situs, dan meningkatkan pengalaman Anda. Anda dapat menerima semua Cookie atau hanya Cookie yang diperlukan. Detail tersedia di",
    policy: "Kebijakan Cookie",
    accept: "Terima semua",
    necessary: "Hanya yang diperlukan",
  },
  [PUBLIC_SITE_LOCALES.ES]: {
    title: "Usamos cookies",
    description:
      "Usamos cookies para mantener LightVela estable, entender cómo se utiliza el sitio y mejorar tu experiencia. Puedes aceptar todas las cookies o continuar solo con las necesarias. Consulta los detalles en la",
    policy: "Política de cookies",
    accept: "Aceptar todas",
    necessary: "Solo las necesarias",
  },
  [PUBLIC_SITE_LOCALES.JA_JP]: {
    title: "Cookieを使用しています",
    description:
      "LightVelaの安定した動作、サイト利用状況の把握、サービス改善のためにCookieを使用します。すべてのCookieを許可するか、必要なCookieのみに設定できます。詳しくは",
    policy: "Cookieポリシー",
    accept: "すべて許可",
    necessary: "必要なCookieのみ",
  },
};

type CookieCopyLocale = keyof typeof COOKIE_CONSENT_COPY;

const hasCookieCopy = (locale: string | undefined): locale is CookieCopyLocale =>
  locale !== undefined && Object.prototype.hasOwnProperty.call(COOKIE_CONSENT_COPY, locale);

export const CookieConsentBanner = () => {
  const pathname = usePathname();
  const { i18n } = useTranslation(undefined, { useSuspense: false });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isGlobal) return;
    setVisible(readStoredCookieConsent() === null);
  }, []);

  if (!isGlobal || !visible) return null;

  const localePrefix = pathname?.split("/")[1]?.toLowerCase();
  const routeDefinition = localePrefix ? localeDefinitionByUrlLang(localePrefix) : undefined;
  const hasLocalizedRoute = Boolean(
    routeDefinition &&
      SWITCHER_VISIBLE_LOCALES.includes(routeDefinition.code) &&
      hasCookieCopy(routeDefinition.i18nKey),
  );

  /**
   * 语言判定优先级：
   *   1. URL 语言前缀（公开页，如 /id-id/subscribe）
   *   2. 当前 i18n 语言（控制台等刻意不做 URL 本地化的路径，如 /agents、/auth；
   *      见 PUBLIC_LOCALIZED_PATH_PREFIXES）
   *   3. 英文兜底
   *
   * 若只看 URL 前缀，在 /agents 下 localePrefix 会是 "agents"，
   * 匹配不到任何语言而错误地回退英文。
   */
  const localeFromPrefix = hasLocalizedRoute && hasCookieCopy(routeDefinition?.i18nKey)
    ? routeDefinition.i18nKey
    : null;

  const currentI18nLanguage = i18n.language;
  const currentLocaleCode = parseLocaleCode(currentI18nLanguage);
  const currentI18nKey = currentLocaleCode ? localeDefinition(currentLocaleCode).i18nKey : undefined;
  const localeFromI18n = currentLocaleCode
    && SWITCHER_VISIBLE_LOCALES.includes(currentLocaleCode)
    && hasCookieCopy(currentI18nKey)
    ? currentI18nKey
    : null;

  const locale = localeFromPrefix ?? localeFromI18n ?? PUBLIC_SITE_LOCALES.EN_US;
  const cookiePolicyPath = hasLocalizedRoute ? `/${localePrefix}/cookie-policy` : "/cookie-policy";
  const text = COOKIE_CONSENT_COPY[locale];
  const handleChoice = (value: CookieConsentValue) => {
    storeCookieConsent(value);
    setVisible(false);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] px-4 pb-4 sm:px-6 sm:pb-6">
      <section className="mx-auto flex max-w-5xl flex-col gap-4 rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_24px_80px_-38px_rgba(15,23,42,0.45)] backdrop-blur md:flex-row md:items-center md:justify-between">
        <div className="max-w-3xl">
          <h2 className="text-base font-semibold tracking-[-0.02em] text-slate-950">{text.title}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {text.description}{" "}
            <a
              href={cookiePolicyPath}
              className="font-semibold underline underline-offset-2 hover:opacity-80"
              style={{ color: "#2563EB", WebkitTextFillColor: "#2563EB", textDecorationColor: "#2563EB" }}
            >
              {text.policy}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:justify-end">
          <button
            type="button"
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
            onClick={() => handleChoice("necessary")}
          >
            {text.necessary}
          </button>
          <button
            type="button"
            className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
            onClick={() => handleChoice("accepted")}
          >
            {text.accept}
          </button>
        </div>
      </section>
    </div>
  );
};

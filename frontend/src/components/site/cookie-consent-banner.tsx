import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isGlobal } from "@/lib/region";
import {
  readStoredCookieConsent,
  storeCookieConsent,
  type CookieConsentValue,
} from "@/lib/cookie-consent";

const copy = {
  "en-US": {
    title: "Cookie Policy",
    description:
      "We use cookies to keep LightVela reliable, understand how the site is used, and improve your experience. You can accept all cookies or continue with necessary cookies only.",
    policy: "Cookie Policy",
    accept: "Accept all",
    necessary: "Necessary only",
  },
  "zh-CN": {
    title: "我们使用 Cookie",
    description:
      "我们使用 Cookie 来保障 LightVela 稳定运行、了解网站使用情况，并优化您的体验。您可以接受全部 Cookie，或仅使用必要 Cookie。详情请查看",
    policy: "Cookie 政策",
    accept: "接受全部",
    necessary: "仅必要 Cookie",
  },
};

export const CookieConsentBanner = () => {
  const { i18n } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isGlobal) return;
    setVisible(readStoredCookieConsent() === null);
  }, []);

  if (!isGlobal || !visible) return null;

  const locale = i18n.language === "zh-CN" ? "zh-CN" : "en-US";
  const text = copy[locale];
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
            <Link
              to="/cookie-policy"
              className="font-semibold underline underline-offset-2 hover:opacity-80"
              style={{ color: "#2563EB", WebkitTextFillColor: "#2563EB", textDecorationColor: "#2563EB" }}
            >
              {text.policy}
            </Link>
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

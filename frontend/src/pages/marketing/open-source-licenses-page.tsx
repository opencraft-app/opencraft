"use client";

import { useTranslation } from "react-i18next";
import { LegalFooter } from "@/components/site/legal-footer";
import { AppLink } from "@/lib/app-navigation";
import { isZhLocale, useZhHantDeep } from "@/lib/zh-hant";
import noticeText from "@/content/legal/open-source-licenses.txt?raw";

const copy = {
  en: {
    backHome: "Back to Home",
    brand: "LightVela",
    title: "Open Source Notices",
    updated: "Last updated: May 2026",
    description: "This page provides attribution and license notices for open source software used by LightVela.",
  },
  zh: {
    backHome: "返回首页",
    brand: "LightVela",
    title: "开源声明",
    updated: "最后更新：2026 年 5 月",
    description: "本页面列示 LightVela 使用的开源软件归属与许可证声明。",
  },
};

export const OpenSourceLicensesPage = () => {
  const { i18n } = useTranslation();
  // 繁体（zh-Hant）时对简体源文案做 OpenCC 简→繁转换；简体原样，英文用 en
  const text = useZhHantDeep(isZhLocale(i18n.language) ? copy.zh : copy.en);

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <AppLink to="/" className="text-xl font-semibold tracking-[-0.04em] text-slate-950">
            {text.brand}
          </AppLink>
          <AppLink to="/" className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-950">
            {text.backHome}
          </AppLink>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:py-16">
        <article className="rounded-[2rem] border border-slate-200 bg-white px-6 py-9 shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)] sm:px-10 sm:py-12 lg:px-14">
          <div className="border-b border-slate-200 pb-10 sm:pb-12">
            <div className="max-w-3xl text-left">
              <h1 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">{text.title}</h1>
              <p className="mt-5 text-[14px] leading-relaxed text-slate-500 sm:text-[15px]">{text.description}</p>
            </div>
          </div>

          <section className="pt-10 sm:pt-12">
            <pre className="whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-50 p-6 font-mono text-[12px] leading-7 text-slate-700 sm:p-8 sm:text-[13px] sm:leading-7">
              {noticeText}
            </pre>
          </section>
        </article>
      </main>

      <LegalFooter />
    </div>
  );
};

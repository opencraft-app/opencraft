"use client";

import { LegalFooter } from "@/components/site/legal-footer";
import { openSourceLicensesText } from "@/content/legal/open-source-licenses-text";
import { useLocaleOverride } from "@/i18n/t";
import { AppLink } from "@/lib/app-navigation";
import { localizedPath } from "@/lib/region";
import { PUBLIC_SITE_LOCALES, PUBLIC_URL_LANGS, type PublicSiteLocaleCode } from "@/lib/public-site-routing";
import { isZhLocale, useZhHantDeep } from "@/lib/zh-hant";

type NoticeBlock =
  | { kind: "heading"; text: string }
  | { kind: "termsHeading"; text: string }
  | { kind: "entry"; number: string; name: string; details: string[] }
  | { kind: "paragraph"; text: string };

const noticeBlocks = (() => {
  const blocks: NoticeBlock[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
    paragraphLines.length = 0;
  };

  const lines = openSourceLicensesText.split("\n").map((line) => line.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      flushParagraph();
      continue;
    }
    if (/^-{8,}$/.test(line) || /^={8,}$/.test(line)) continue;

    if (line.startsWith("Open Source Software Licensed under")) {
      flushParagraph();
      blocks.push({ kind: "heading", text: line });
      continue;
    }

    if (line.startsWith("Terms of the ")) {
      flushParagraph();
      blocks.push({ kind: "termsHeading", text: line });
      continue;
    }

    const entry = line.match(/^(\d+)\.\s+(.+)$/);
    if (entry) {
      flushParagraph();
      const details: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        if (
          !nextLine ||
          /^-{8,}$/.test(nextLine) ||
          /^={8,}$/.test(nextLine) ||
          nextLine.startsWith("Open Source Software Licensed under") ||
          nextLine.startsWith("Terms of the ") ||
          /^\d+\.\s+/.test(nextLine)
        ) {
          break;
        }
        details.push(nextLine);
        index += 1;
      }
      blocks.push({ kind: "entry", number: entry[1], name: entry[2], details });
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return blocks;
})();

const copy = {
  en: {
    backHome: "Back to Home",
    brand: "LightVela",
    title: "Open Source Notice",
    updated: "Last updated: August 2026",
    description: "This page provides attribution and license notices for open source software used by LightVela.",
  },
  zh: {
    backHome: "返回首页",
    brand: "LightVela",
    title: "开源声明",
    updated: "最后更新：2026 年 8 月",
    description: "本页面列示 LightVela 使用的开源软件归属与许可证声明。",
  },
  id: {
    backHome: "Kembali ke Beranda",
    brand: "LightVela",
    title: "Pemberitahuan Sumber Terbuka",
    updated: "Terakhir diperbarui: Agustus 2026",
    description: "Halaman ini memuat atribusi dan pemberitahuan lisensi untuk perangkat lunak open source yang digunakan LightVela.",
  },
  es: {
    backHome: "Volver al inicio",
    brand: "LightVela",
    title: "Aviso de código abierto",
    updated: "Última actualización: agosto de 2026",
    description: "Esta página incluye los avisos de atribución y licencia del software de código abierto utilizado por LightVela.",
  },
};

const spanishLegalLanguageNote =
  "Los términos de las licencias se conservan en su versión original en inglés. En caso de discrepancia, prevalecerá el texto original en inglés.";

export function getOpenSourceLicensesChrome(locale: PublicSiteLocaleCode) {
  if (locale === PUBLIC_SITE_LOCALES.ES) return copy.es;
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return copy.id;
  return isZhLocale(locale) ? copy.zh : copy.en;
}

export function publicLocaleHomePath(locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return `/${PUBLIC_URL_LANGS.ID_ID}/`;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return `/${PUBLIC_URL_LANGS.ZH_HANT}/`;
  if (locale === PUBLIC_SITE_LOCALES.ES) return `/${PUBLIC_URL_LANGS.ES}/`;
  if (locale.startsWith("zh")) return `/${PUBLIC_URL_LANGS.ZH_SG}/`;
  return `/${PUBLIC_URL_LANGS.EN_US}/`;
}

export function translateNoticeText(text: string, locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.EN_US) return text;

  const licenseGroup = text.match(/^Open Source Software Licensed under the (.+):$/);
  if (licenseGroup) {
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Software de código abierto con licencia ${licenseGroup[1]}:`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Perangkat lunak sumber terbuka yang dilisensikan berdasarkan ${licenseGroup[1]}:`
      : `根据 ${licenseGroup[1]} 许可证授权的开源软件：`;
  }

  const licenseTerms = text.match(/^Terms of the (.+):$/);
  if (licenseTerms) {
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Términos de la ${licenseTerms[1]}:`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Ketentuan lisensi ${licenseTerms[1]}:`
      : `${licenseTerms[1]} 许可证条款：`;
  }

  const sourceInfo = text.match(/^You may obtain the source code and detailed information about this component at (.+)\.$/);
  if (sourceInfo) {
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Puede obtener el código fuente y la información detallada de este componente en ${sourceInfo[1]}.`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Anda dapat memperoleh kode sumber dan informasi terperinci tentang komponen ini di ${sourceInfo[1]}.`
      : `您可在 ${sourceInfo[1]} 获取该组件的源代码和详细信息。`;
  }

  if (text === "The project is built on and with the aid of the following open source projects. Credits are given to these projects.") {
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return "El proyecto se ha creado con la ayuda de los siguientes proyectos de código abierto, a los que se reconoce expresamente.";
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? "Proyek ini dibangun dengan bantuan proyek sumber terbuka berikut. Kami memberikan atribusi kepada proyek-proyek tersebut."
      : "本项目基于并借助以下开源项目构建，特此向这些项目致谢。";
  }

  if (text === "In case you believe there have been errors in the attribution below, you may submit the concerns to us for review and correction.") {
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return "Si considera que existe algún error en las atribuciones siguientes, puede comunicárnoslo para que lo revisemos y corrijamos.";
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? "Jika Anda menemukan kesalahan dalam atribusi di bawah ini, Anda dapat menyampaikan laporan kepada kami untuk ditinjau dan diperbaiki."
      : "如您认为以下归属信息存在错误，可向我们反馈以便审核和更正。";
  }

  if (text === "license not found") {
    if (locale === PUBLIC_SITE_LOCALES.ES) return "No se ha encontrado el texto de la licencia";
    return locale === PUBLIC_SITE_LOCALES.ID_ID ? "Teks lisensi tidak ditemukan" : "未找到许可证文本";
  }

  return text;
}

export const OpenSourceLicensesPage = () => {
  const localeOverride = useLocaleOverride();
  const currentLocale: PublicSiteLocaleCode =
    localeOverride === PUBLIC_SITE_LOCALES.ID_ID
      ? PUBLIC_SITE_LOCALES.ID_ID
      : localeOverride === PUBLIC_SITE_LOCALES.ES
        ? PUBLIC_SITE_LOCALES.ES
      : localeOverride === PUBLIC_SITE_LOCALES.ZH_HANT
        ? PUBLIC_SITE_LOCALES.ZH_HANT
        : localeOverride?.startsWith("zh")
          ? PUBLIC_SITE_LOCALES.ZH_SG
          : PUBLIC_SITE_LOCALES.EN_US;
  // 繁体（zh-Hant）时对简体源文案做 OpenCC 简→繁转换；简体原样，英文用 en
  const text = useZhHantDeep(getOpenSourceLicensesChrome(currentLocale));
  const homePath = localeOverride ? publicLocaleHomePath(currentLocale) : localizedPath("/", currentLocale);

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <AppLink to={homePath} className="text-xl font-semibold tracking-[-0.04em] text-slate-950">
            {text.brand}
          </AppLink>
          <AppLink to={homePath} className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-950">
            {text.backHome}
          </AppLink>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14 lg:py-16">
        <article className="rounded-[2rem] border border-slate-200 bg-white px-6 py-9 shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)] sm:px-10 sm:py-12 lg:px-14">
          <div className="border-b border-slate-200 pb-10 sm:pb-12">
            <div className="max-w-3xl text-left">
              <h1 className="text-4xl font-bold tracking-tight text-slate-950 sm:text-5xl">{text.title}</h1>
              <p className="mt-4 text-[13px] font-medium leading-relaxed text-slate-500">{text.updated}</p>
              <p className="mt-5 text-[14px] leading-relaxed text-slate-500 sm:text-[15px]">{text.description}</p>
              {currentLocale === PUBLIC_SITE_LOCALES.ES ? (
                <p className="mt-3 text-[13px] leading-relaxed text-slate-500">{spanishLegalLanguageNote}</p>
              ) : null}
            </div>
          </div>

          <section className="pt-10 sm:pt-12">
            <div className="max-w-[74ch] text-[15px] leading-8 text-slate-700 sm:text-base sm:leading-9">
              {noticeBlocks.map((block, index) => {
                if (block.kind === "heading") {
                  return (
                    <h2
                      key={`${block.text}-${index}`}
                      className="mt-12 border-t border-slate-200 pt-10 text-xl font-semibold leading-8 text-slate-950 first:mt-0 first:border-t-0 first:pt-0"
                    >
                      {translateNoticeText(block.text, currentLocale)}
                    </h2>
                  );
                }
                if (block.kind === "termsHeading") {
                  return (
                    <h3 key={`${block.text}-${index}`} className="mt-10 text-lg font-semibold leading-8 text-slate-950">
                      {translateNoticeText(block.text, currentLocale)}
                    </h3>
                  );
                }
                if (block.kind === "entry") {
                  return (
                    <div key={`${block.number}-${block.name}-${index}`} className="mt-6 border-b border-slate-100 pb-5 last:border-b-0">
                      <p className="flex gap-3 text-base leading-7 text-slate-950">
                        <span className="w-7 shrink-0 text-right font-medium tabular-nums text-slate-400">{block.number}.</span>
                        <span className="font-semibold">{block.name}</span>
                      </p>
                      {block.details.length ? (
                        <div className="mt-1 space-y-1 pl-10">
                          {block.details.map((detail) => (
                            <p key={detail} className="text-sm leading-7 text-slate-500">
                              {translateNoticeText(detail, currentLocale)}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                }
                return (
                  <p key={`${block.text}-${index}`} className="mt-4 whitespace-pre-wrap">
                    {translateNoticeText(block.text, currentLocale)}
                  </p>
                );
              })}
            </div>
          </section>
        </article>
      </main>

      <LegalFooter />
    </div>
  );
};

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
  ja: {
    backHome: "ホームに戻る",
    brand: "LightVela",
    title: "オープンソースに関する通知",
    updated: "最終更新: 2026年8月",
    description: "このページには、LightVelaで使用しているオープンソースソフトウェアの帰属表示およびライセンス通知を掲載しています。",
  },
  ko: {
    backHome: "홈으로 돌아가기",
    brand: "LightVela",
    title: "오픈 소스 고지",
    updated: "최종 업데이트: 2026년 8월",
    description: "이 페이지에서는 LightVela가 사용하는 오픈 소스 소프트웨어의 저작권 귀속 및 라이선스 고지를 제공합니다.",
  },
};

const spanishLegalLanguageNote =
  "Los términos de las licencias se conservan en su versión original en inglés. En caso de discrepancia, prevalecerá el texto original en inglés.";
const japaneseLegalLanguageNote =
  "ライセンス条項は英語の原文をそのまま掲載しています。翻訳された見出しや説明と相違がある場合は、英語のライセンス原文が優先されます。";
const koreanLegalLanguageNote =
  "라이선스 조항은 영문 원문으로 제공됩니다. 번역된 제목 또는 설명과 불일치하는 경우 영문 라이선스 원문이 우선합니다.";

export function getOpenSourceLicensesChrome(locale: PublicSiteLocaleCode) {
  if (locale === PUBLIC_SITE_LOCALES.KO_KR) return copy.ko;
  if (locale === PUBLIC_SITE_LOCALES.JA_JP) return copy.ja;
  if (locale === PUBLIC_SITE_LOCALES.ES) return copy.es;
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return copy.id;
  return isZhLocale(locale) ? copy.zh : copy.en;
}

export function publicLocaleHomePath(locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.ID_ID) return `/${PUBLIC_URL_LANGS.ID_ID}/`;
  if (locale === PUBLIC_SITE_LOCALES.ZH_HANT) return `/${PUBLIC_URL_LANGS.ZH_HANT}/`;
  if (locale === PUBLIC_SITE_LOCALES.ES) return `/${PUBLIC_URL_LANGS.ES}/`;
  if (locale === PUBLIC_SITE_LOCALES.JA_JP) return `/${PUBLIC_URL_LANGS.JA_JP}/`;
  if (locale === PUBLIC_SITE_LOCALES.KO_KR) return `/${PUBLIC_URL_LANGS.KO_KR}/`;
  if (locale.startsWith("zh")) return `/${PUBLIC_URL_LANGS.ZH_SG}/`;
  return `/${PUBLIC_URL_LANGS.EN_US}/`;
}

export function translateNoticeText(text: string, locale: PublicSiteLocaleCode): string {
  if (locale === PUBLIC_SITE_LOCALES.EN_US) return text;

  const licenseGroup = text.match(/^Open Source Software Licensed under the (.+):$/);
  if (licenseGroup) {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) {
      return `${licenseGroup[1]}에 따라 라이선스된 오픈 소스 소프트웨어:`;
    }
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
      return `${licenseGroup[1]}でライセンスされるオープンソースソフトウェア:`;
    }
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Software de código abierto con licencia ${licenseGroup[1]}:`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Perangkat lunak sumber terbuka yang dilisensikan berdasarkan ${licenseGroup[1]}:`
      : `根据 ${licenseGroup[1]} 许可证授权的开源软件：`;
  }

  const licenseTerms = text.match(/^Terms of the (.+):$/);
  if (licenseTerms) {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) {
      return `${licenseTerms[1]} 조항:`;
    }
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
      return `${licenseTerms[1]}の条項:`;
    }
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Términos de la ${licenseTerms[1]}:`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Ketentuan lisensi ${licenseTerms[1]}:`
      : `${licenseTerms[1]} 许可证条款：`;
  }

  const sourceInfo = text.match(/^You may obtain the source code and detailed information about this component at (.+)\.$/);
  if (sourceInfo) {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) {
      return `${sourceInfo[1]}에서 이 컴포넌트의 소스 코드와 자세한 정보를 확인할 수 있습니다.`;
    }
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
      return `このコンポーネントのソースコードと詳細情報は、${sourceInfo[1]}で確認できます。`;
    }
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return `Puede obtener el código fuente y la información detallada de este componente en ${sourceInfo[1]}.`;
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? `Anda dapat memperoleh kode sumber dan informasi terperinci tentang komponen ini di ${sourceInfo[1]}.`
      : `您可在 ${sourceInfo[1]} 获取该组件的源代码和详细信息。`;
  }

  if (text === "The project is built on and with the aid of the following open source projects. Credits are given to these projects.") {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) {
      return "이 프로젝트는 다음 오픈 소스 프로젝트를 기반으로 하거나 활용하여 구축되었으며, 해당 프로젝트에 감사를 표합니다.";
    }
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
      return "本プロジェクトは、以下のオープンソースプロジェクトを利用して構築されています。これらのプロジェクトに謝意を表します。";
    }
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return "El proyecto se ha creado con la ayuda de los siguientes proyectos de código abierto, a los que se reconoce expresamente.";
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? "Proyek ini dibangun dengan bantuan proyek sumber terbuka berikut. Kami memberikan atribusi kepada proyek-proyek tersebut."
      : "本项目基于并借助以下开源项目构建，特此向这些项目致谢。";
  }

  if (text === "In case you believe there have been errors in the attribution below, you may submit the concerns to us for review and correction.") {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) {
      return "아래 저작권 귀속 표시에 오류가 있다고 판단되면 검토와 정정을 위해 제보해 주시기 바랍니다.";
    }
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) {
      return "以下の帰属表示に誤りがあると思われる場合は、確認および修正のため当社までお知らせください。";
    }
    if (locale === PUBLIC_SITE_LOCALES.ES) {
      return "Si considera que existe algún error en las atribuciones siguientes, puede comunicárnoslo para que lo revisemos y corrijamos.";
    }
    return locale === PUBLIC_SITE_LOCALES.ID_ID
      ? "Jika Anda menemukan kesalahan dalam atribusi di bawah ini, Anda dapat menyampaikan laporan kepada kami untuk ditinjau dan diperbaiki."
      : "如您认为以下归属信息存在错误，可向我们反馈以便审核和更正。";
  }

  if (text === "license not found") {
    if (locale === PUBLIC_SITE_LOCALES.KO_KR) return "라이선스 원문을 찾을 수 없습니다";
    if (locale === PUBLIC_SITE_LOCALES.JA_JP) return "ライセンス本文が見つかりません";
    if (locale === PUBLIC_SITE_LOCALES.ES) return "No se ha encontrado el texto de la licencia";
    return locale === PUBLIC_SITE_LOCALES.ID_ID ? "Teks lisensi tidak ditemukan" : "未找到许可证文本";
  }

  return text;
}

export const OpenSourceLicensesPage = () => {
  const localeOverride = useLocaleOverride();
  const currentLocale: PublicSiteLocaleCode =
    localeOverride === PUBLIC_SITE_LOCALES.KO_KR
      ? PUBLIC_SITE_LOCALES.KO_KR
      : localeOverride === PUBLIC_SITE_LOCALES.JA_JP
      ? PUBLIC_SITE_LOCALES.JA_JP
      : localeOverride === PUBLIC_SITE_LOCALES.ID_ID
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
              ) : currentLocale === PUBLIC_SITE_LOCALES.JA_JP ? (
                <p className="mt-3 text-[13px] leading-relaxed text-slate-500">{japaneseLegalLanguageNote}</p>
              ) : currentLocale === PUBLIC_SITE_LOCALES.KO_KR ? (
                <p className="mt-3 text-[13px] leading-relaxed text-slate-500">{koreanLegalLanguageNote}</p>
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

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  CN_PRIVACY_POLICY_URL,
  CN_TERMS_OF_SERVICE_URL,
} from "@/constants/legal";
import { DISCORD_INVITE_URL } from "@/constants/community";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { localeDefinition, parseLocaleCode } from "@/i18n/locales.config";
import { useLocaleOverride, useT } from "@/i18n/t";
import { SUBSCRIBE_PATH } from "@/lib/agent-routes";
import { isGlobal, localizedPath } from "@/lib/region";
import type { PublicSiteLocaleCode } from "@/lib/public-site-routing";
import { PUBLIC_SITE_LOCALES } from "@/lib/public-site-routing";
import { cn } from "@/lib/utils";

type FooterLink =
  | {
      label: string;
      to: string;
      external?: false;
    }
  | {
      label: string;
      href: string;
      external: true;
    };

type FooterSection = {
  title: string;
  links: FooterLink[];
};

export type RenderFooterLink = (props: {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  onClick?: () => void;
  target?: string;
  rel?: string;
}) => ReactNode;

const footerLinkClassName =
  "inline-flex w-fit appearance-none rounded-md border-0 bg-transparent p-0 text-left text-sm font-normal leading-6 text-black/55 no-underline transition-colors duration-200 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black/40";

function useFooterLocale(): PublicSiteLocaleCode {
  const { i18n } = useTranslation();
  const localeOverride = useLocaleOverride();
  const parsedLocale = parseLocaleCode(localeOverride ?? i18n.language);
  return parsedLocale && localeDefinition(parsedLocale).switcherVisible
    ? parsedLocale
    : PUBLIC_SITE_LOCALES.EN_US;
}

/**
 * 竞品对比栏链接。
 *
 * 对应 `src/content/docs/compare/`（国内站 3 篇）与 `global|en/compare/`（国际站 5 篇），
 * slug 注册见 `src/config/docs-sidebar.ts`。两站分别描述，不混写。
 */
const getCompareLinks = (t: (zh: string) => string): FooterLink[] =>
  isGlobal
    ? [
        { label: t("与本地部署对比"), to: "/docs/compare/lightvela-vs-localhost-ai-agent" },
        { label: t("与 Hostinger 对比"), to: "/docs/compare/lightvela-vs-hostinger" },
        { label: t("与 Manus 对比"), to: "/docs/compare/lightvela-vs-manus" },
        { label: t("与 ChatGPT 对比"), to: "/docs/compare/lightvela-vs-chatgpt" },
        { label: t("与 Genspark 对比"), to: "/docs/compare/lightvela-vs-genspark" },
      ]
    : [
        { label: t("与本地部署对比"), to: "/docs/compare/lightvela-vs-localhost-ai-agent" },
        { label: t("与 Manus 对比"), to: "/docs/compare/lightvela-vs-manus" },
        { label: t("与 AI Chatbot 对比"), to: "/docs/compare/lightvela-vs-ai-chatbot" },
      ];

/**
 * 「产品」栏的通道接入指引。
 *
 * 两站分别描述，不混写：国内站只列已支持的 QQ / 微信 / 企业微信 / 飞书，
 * 国际站列 WhatsApp / Telegram / Discord。
 * 事实来源见 `wiki/product-state/geo-fact-table.md` 第 1.5 节。
 */
const getChannelGuideLinks = (t: (zh: string) => string): FooterLink[] =>
  isGlobal
    ? [
        { label: t("接入 WhatsApp 指引"), to: "/docs/configuration/channel-whatsapp" },
        { label: t("接入 Telegram 指引"), to: "/docs/configuration/channel-telegram" },
        { label: t("接入 Discord 指引"), to: "/docs/configuration/channel-discord" },
      ]
    : [
        { label: t("接入 QQ 指引"), to: "/docs/configuration/channel-qq" },
        { label: t("接入微信指引"), to: "/docs/configuration/channel-wechat" },
        { label: t("接入企微指引"), to: "/docs/configuration/channel-wecom" },
        { label: t("接入飞书指引"), to: "/docs/configuration/channel-feishu" },
      ];

/** 「社区」栏：国内站为微信交流群（落在 contact-us 文档页），国际站保持既有社媒矩阵。 */
const getCommunityLinks = (t: (zh: string) => string): FooterLink[] =>
  isGlobal
    ? [
        { label: "Discord", href: DISCORD_INVITE_URL, external: true },
        {
          label: "WhatsApp",
          href: "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
          external: true,
        },
        { label: "X / Twitter", href: "https://x.com/agentlightvela", external: true },
        { label: "Youtube", href: "https://www.youtube.com/@TencentLightVela", external: true },
      ]
    : [{ label: t("加入交流群"), to: "/docs/contact-us" }];

const getFooterSections = (t: (zh: string) => string): FooterSection[] => {
  // 栏目顺序：产品 → 对比 → 社区 → 公司（国际站在末尾追加「相关产品」）
  const sections: FooterSection[] = [
    {
      title: t("产品"),
      links: [
        // 与首页顶部「免费试用」按钮落点一致：未登录 / 未订阅均先进订阅页
        { label: t("14 天免费试用"), to: SUBSCRIBE_PATH },
        { label: t("定价"), to: SUBSCRIBE_PATH },
        ...getChannelGuideLinks(t),
      ],
    },
    {
      title: t("对比"),
      links: getCompareLinks(t),
    },
    {
      title: t("社区"),
      links: getCommunityLinks(t),
    },
    {
      title: t("公司"),
      links: [
        { label: t("关于我们"), to: "/about" },
        ...(
          isGlobal
            ? []
            : [
                {
                  label: t("帮助与反馈"),
                  href: PRODUCT_FEEDBACK_URL,
                  external: true,
                } satisfies FooterLink,
              ]
        ),
        isGlobal
          ? { label: t("隐私政策"), to: "/privacy-policy" }
          : { label: t("隐私政策"), href: CN_PRIVACY_POLICY_URL, external: true },
        isGlobal
          ? { label: t("服务条款"), to: "/terms-of-service" }
          : { label: t("服务条款"), href: CN_TERMS_OF_SERVICE_URL, external: true },
        // 开源声明：仅国际站有 /open-source-licenses 页面，国内站不展示
        ...(isGlobal
          ? [{ label: t("开源声明"), to: "/open-source-licenses" } satisfies FooterLink]
          : []),
      ],
    },
  ];

  // 相关产品：仅国际站展示
  if (isGlobal) {
    sections.push({
      title: t("相关产品"),
      links: [
        {
          label: t("腾讯云开发 Tencent CloudBase"),
          href: "https://tcb.cloud.tencent.com/en/?from=lightvela",
          external: true,
        },
        {
          label: "Tencent EdgeOne",
          href: "https://edgeone.ai/",
          external: true,
        },
      ],
    });
  }

  return sections;
};

function DefaultFooterLink({ children, ...props }: Parameters<RenderFooterLink>[0]) {
  return <a {...props}>{children}</a>;
}

function LightVelaFooterLogo({
  locale,
  renderLink,
}: {
  locale: PublicSiteLocaleCode;
  renderLink: RenderFooterLink;
}) {
  return renderLink({
    href: localizedPath("/", locale),
    className: "inline-flex shrink-0 items-center",
    "aria-label": "LightVela",
    children: (
      <img
        src="/lightvela-wordmark.svg"
        alt="LightVela"
        className="block h-[26px] w-auto select-none"
        draggable={false}
      />
    ),
  });
}

function FooterTextLink({
  link,
  locale,
  className,
  renderLink,
}: {
  link: FooterLink;
  locale: PublicSiteLocaleCode;
  className?: string;
  renderLink: RenderFooterLink;
}) {
  const linkClassName = cn(footerLinkClassName, className);
  const label = link.label;

  if ("href" in link) {
    return (
      <a
        href={link.href}
        target={link.external ? "_blank" : undefined}
        rel={link.external ? "noopener noreferrer" : undefined}
        className={linkClassName}
      >
        {label}
      </a>
    );
  }

  return renderLink({
    href: localizedPath(link.to, locale),
    className: linkClassName,
    children: label,
  });
}

/**
 * 页脚区域背景色（近白灰）。
 *
 * 单独导出是因为国内站首页把分栏单独叠在 `LegalFooter` 上方
 * （见 `landing-page.tsx`），两处必须同色 —— 否则会出现一条可见的色差接缝。
 * 抽成常量避免第二处硬编码。
 *
 * 说明：营销站没有暗色 / 多主题（全站无 `dark:` 变体），
 * 所以这里用固定色值而不是 CSS 变量；控制台侧的主题适配规则不适用于本文件。
 */
export const FOOTER_SURFACE_CLASS = 'bg-[#fbfbfd]';

/**
 * 页脚分栏导航（产品 / 公司 / 社区 / 对比，国际站另有「相关产品」）。
 *
 * 单独导出是因为国内站与国际站页脚结构不同：
 *   - 国际站：`LightVelaFooter` 内含分栏 + 品牌行；
 *   - 国内站：首页用紧凑的 `LegalFooter`（单行法律信息），需要把分栏单独叠在它上方。
 * 抽出后两站共用同一份栏目数据，避免链接清单出现第二处镜像。
 */
export function FooterLinkColumns({
  renderLink = DefaultFooterLink,
  className,
}: {
  renderLink?: RenderFooterLink;
  className?: string;
}) {
  const t = useT();
  const locale = useFooterLocale();
  const sections = getFooterSections(t);

  return (
    <nav
      className={cn(
        // 平铺展示：不使用卡片容器（无边框 / 无白底 / 无圆角），直接落在页脚背景上
        "mx-auto grid w-full gap-9 py-10 sm:gap-8",
        // 栏目数随区域变化：国内站 4 栏，国际站 5 栏（多「相关产品」）
        sections.length >= 5
          ? "max-w-[1200px] grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5"
          : "max-w-[1040px] grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
      aria-label={t("页脚导航")}
    >
      {sections.map((section) => (
        <section key={section.title} className="flex min-w-0 flex-col items-start gap-4 text-left">
          <h3 className="font-['PingFang_SC:Medium',sans-serif] text-sm font-medium leading-5 text-black/90">
            {section.title}
          </h3>
          <div className="flex min-h-6 flex-col items-start gap-2.5">
            {section.links.map((link) => (
              <FooterTextLink key={link.label} link={link} locale={locale} renderLink={renderLink} />
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}

export function LightVelaFooter({ renderLink = DefaultFooterLink }: { renderLink?: RenderFooterLink }) {
  const t = useT();
  const locale = useFooterLocale();

  return (
    <footer className={`w-full border-b border-black/8 ${FOOTER_SURFACE_CLASS}`} aria-labelledby="lightvela-footer-heading">
      <h2 id="lightvela-footer-heading" className="sr-only">
        {t("页脚导航")}
      </h2>
      <div className="mx-auto max-w-[1440px] px-6 pt-0 md:px-10 md:pt-0 lg:px-16 lg:pt-0">
        <FooterLinkColumns renderLink={renderLink} />
      </div>

      <div className="mt-10 flex flex-col gap-4 px-12 pb-10 md:flex-row md:items-center md:justify-between md:px-[140px] md:pb-12 lg:px-[280px] lg:pb-14">
        <LightVelaFooterLogo locale={locale} renderLink={renderLink} />
        <p className="text-sm leading-6 text-black/45 md:text-right">
          {t("© 2026 LightVela 版权所有，由腾讯轻量云团队出品")}
        </p>
      </div>
    </footer>
  );
}

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  CN_PRIVACY_POLICY_URL,
  CN_TERMS_OF_SERVICE_URL,
} from "@/constants/legal";
import { DISCORD_INVITE_URL } from "@/constants/community";
import { localeDefinition, parseLocaleCode } from "@/i18n/locales.config";
import { useLocaleOverride, useT } from "@/i18n/t";
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
  "inline-flex w-fit appearance-none rounded-md border-0 bg-transparent p-0 text-center text-sm font-normal leading-6 text-black/55 no-underline transition-colors duration-200 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black/40";

const getFooterSections = (t: (zh: string) => string): FooterSection[] => [
  {
    title: t("公司"),
    links: [
      {
        label: t("关于我们"),
        to: "/about",
      },
      {
        label: t("帮助与反馈"),
        to: "/support",
      },
    ],
  },
  {
    title: t("法律"),
    links: [
      isGlobal
        ? { label: t("隐私政策"), to: "/privacy-policy" }
        : { label: t("隐私政策"), href: CN_PRIVACY_POLICY_URL, external: true },
      isGlobal
        ? { label: t("服务条款"), to: "/terms-of-service" }
        : { label: t("服务条款"), href: CN_TERMS_OF_SERVICE_URL, external: true },
      {
        label: t("开源声明"),
        to: "/open-source-licenses",
      },
    ],
  },
  {
    title: t("社区"),
    links: [
      {
        label: "Discord",
        href: DISCORD_INVITE_URL,
        external: true,
      },
      {
        label: "WhatsApp",
        href: "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
        external: true,
      },
      {
        label: "X / Twitter",
        href: "https://x.com/agentlightvela",
        external: true,
      },
      {
        label: "Youtube",
        href: "https://www.youtube.com/@TencentLightVela",
        external: true,
      },
    ],
  },
];

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

export function LightVelaFooter({ renderLink = DefaultFooterLink }: { renderLink?: RenderFooterLink }) {
  const t = useT();
  const { i18n } = useTranslation();
  const localeOverride = useLocaleOverride();
  const parsedLocale = parseLocaleCode(localeOverride ?? i18n.language);
  const locale = parsedLocale && localeDefinition(parsedLocale).switcherVisible
    ? parsedLocale
    : PUBLIC_SITE_LOCALES.EN_US;
  const sections = getFooterSections(t);

  return (
    <footer className="w-full border-b border-black/8 bg-[#fbfbfd]" aria-labelledby="lightvela-footer-heading">
      <h2 id="lightvela-footer-heading" className="sr-only">
        {t("页脚导航")}
      </h2>
      <div className="mx-auto max-w-[1440px] px-6 pt-0 md:px-10 md:pt-0 lg:px-16 lg:pt-0">
        <nav
          className="mx-auto grid w-full max-w-[760px] grid-cols-1 gap-9 rounded-2xl border border-black/8 bg-white/70 px-8 py-10 sm:grid-cols-3 sm:gap-8 md:px-12"
          aria-label={t("页脚导航")}
        >
          {sections.map((section) => (
            <section key={section.title} className="flex min-w-0 flex-col items-center gap-4 text-center">
              <h3 className="font-['PingFang_SC:Medium',sans-serif] text-sm font-medium leading-5 text-black/90">
                {section.title}
              </h3>
              <div className="flex min-h-6 flex-col items-center gap-2.5">
                {section.links.map((link) => (
                  <FooterTextLink key={link.label} link={link} locale={locale} renderLink={renderLink} />
                ))}
              </div>
            </section>
          ))}
        </nav>
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

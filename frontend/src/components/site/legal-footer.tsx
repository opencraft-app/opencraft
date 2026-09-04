import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  BEIAN_URL,
  CN_PRIVACY_POLICY_URL,
  CN_TERMS_OF_SERVICE_URL,
  ICP_LICENSE,
  shouldShowICP,
} from "@/constants/legal";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import {
  CN_COMMUNITY_QR_IMAGE,
  DISCORD_INVITE_URL,
  DISCORD_QR_IMAGE,
} from "@/constants/community";
import { useLocaleOverride, useT } from "@/i18n/t";
import { isCN, isGlobal, localizedPath } from "@/lib/region";
import { resolveVisiblePublicSiteLocale } from "@/lib/public-site-routing";

interface LegalFooterProps {
  icpPlacement?: "inline" | "right";
  /**
   * 是否展示「隐私政策 · 服务条款 · 产品反馈 · 加入交流群」链接行。
   *
   * 默认 true，保持其他页面（文档站、账户页、更新日志等 12+ 处）现状不变。
   * 首页传 false：这些链接已在上方 `FooterLinkColumns` 的分栏里出现，
   * 同页重复会让页脚出现两套相同入口。
   */
  showLinks?: boolean;
}

export const LegalFooter = ({ icpPlacement = "inline", showLinks = true }: LegalFooterProps) => {
  const currentYear = new Date().getFullYear();
  const t = useT();
  const { i18n } = useTranslation();
  const localeOverride = useLocaleOverride();
  const currentLocale = resolveVisiblePublicSiteLocale(localeOverride, i18n.language);
  const showICP = shouldShowICP();
  const [showQR, setShowQR] = useState(false);
  const privacyPolicyPath = localizedPath("/privacy-policy", currentLocale);
  const termsOfServicePath = localizedPath("/terms-of-service", currentLocale);
  const openSourceLicensesPath = localizedPath("/open-source-licenses", currentLocale);
  const footerLinkClass = "lw-site-link lw-site-link--muted transition-colors";
  const showInlineICP = showICP && icpPlacement === "inline";
  const showRightICP = showICP && icpPlacement === "right";

  if (isGlobal) {
    return (
      <footer className="border-t border-black/8 bg-white">
        <div
          className="mx-auto px-6 py-5 md:px-10 lg:px-[80px]"
          style={{ maxWidth: "1440px" }}
        >
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-[11px] leading-[1.6] tracking-[-0.013em] text-black/50 md:text-xs md:leading-[1.5]">
            <span>{t("Copyright © {{year}} LightVela 版权所有，腾讯轻量云出品", { year: currentYear })}</span>
            {showLinks && (
              <>
                <span className="inline-flex flex-wrap items-center gap-x-1">
                  <a href={privacyPolicyPath} className={footerLinkClass}>
                    {t("隐私政策")}
                  </a>
                  <span aria-hidden="true">·</span>
                  <a href={termsOfServicePath} className={footerLinkClass}>
                    {t("服务条款")}
                  </a>
                  <span aria-hidden="true">·</span>
                  <a href={openSourceLicensesPath} className={footerLinkClass}>
                    {t("开源声明")}
                  </a>
                </span>
                <a
                  href={DISCORD_INVITE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={footerLinkClass}
                >
                  {t("加入交流群")}
                </a>
              </>
            )}
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="border-t border-black/8 bg-white">
      <div
        className="mx-auto px-6 py-5 md:px-10 lg:px-[80px]"
        style={{ maxWidth: "1440px" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] leading-[1.6] tracking-[-0.013em] text-black/50 md:gap-[22px] md:text-xs md:leading-[1.5]">
          <span>
            {t("Copyright © {{year}} LightVela 版权所有，腾讯轻量云出品", { year: currentYear })}
            {showInlineICP && (
              <>
                {" "}
                <a
                  href={BEIAN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={footerLinkClass}
                >
                  {ICP_LICENSE}
                </a>
              </>
            )}
          </span>
          {showLinks && (
          <span>
            {isGlobal ? (
              <a href={privacyPolicyPath} className={footerLinkClass}>
                {t("隐私政策")}
              </a>
            ) : (
              <a
                href={CN_PRIVACY_POLICY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={footerLinkClass}
              >
                {t("隐私政策")}
              </a>
            )}
            ·
            {isGlobal ? (
              <a href={termsOfServicePath} className={footerLinkClass}>
                {t("服务条款")}
              </a>
            ) : (
              <a
                href={CN_TERMS_OF_SERVICE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={footerLinkClass}
              >
                {t("服务条款")}
              </a>
            )}
            {isCN ? (
              <>
                ·
                <a
                  href={PRODUCT_FEEDBACK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={footerLinkClass}
                >
                  {t("产品反馈")}
                </a>
              </>
            ) : null}
            {isGlobal ? (
              <>
                ·
                <a href={openSourceLicensesPath} className={footerLinkClass}>
                  {t("开源声明")}
                </a>
              </>
            ) : null}
          </span>
          )}
          {/* 加入交流群 — hover 展示二维码；国际站文案与二维码均可点击直达 Discord */}
          {showLinks && (
          <span
            className="relative"
            onMouseEnter={() => setShowQR(true)}
            onMouseLeave={() => setShowQR(false)}
          >
            {isGlobal ? (
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer transition-colors hover:text-black"
              >
                {t("加入交流群")}
              </a>
            ) : (
              <span className="cursor-pointer transition-colors hover:text-black">
                {t("加入交流群")}
              </span>
            )}
            <AnimatePresence>
              {showQR && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className="absolute bottom-full left-1/2 z-20 mb-3 flex w-60 max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2 rounded-xl bg-white p-4 shadow-lg"
                >
                  {isGlobal ? (
                    <a
                      href={DISCORD_INVITE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-col items-center gap-2"
                    >
                      <img
                        src={DISCORD_QR_IMAGE}
                        alt={t("加入交流群")}
                        className="rounded-lg"
                        style={{ width: "168px", height: "168px" }}
                      />
                      <span className="max-w-full whitespace-normal text-pretty text-center text-[11px] leading-relaxed text-black/50">
                        {t("扫码加入Discord交流群")}
                      </span>
                    </a>
                  ) : (
                    <>
                      <img
                        src={CN_COMMUNITY_QR_IMAGE}
                        alt={t("加入交流群")}
                        className="rounded-lg"
                        style={{ width: "168px", height: "168px" }}
                      />
                      <span className="max-w-full whitespace-normal text-pretty text-center text-[11px] leading-relaxed text-black/50">
                        {t("扫码加入交流群")}
                      </span>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </span>
          )}
          {showRightICP && (
            <a
              href={BEIAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={`${footerLinkClass} ml-auto`}
            >
              {ICP_LICENSE}
            </a>
          )}
        </div>
      </div>
    </footer>
  );
};

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  BEIAN_URL,
  CN_PRIVACY_POLICY_URL,
  CN_TERMS_OF_SERVICE_URL,
  getGlobalTermsOfServiceUrl,
  ICP_LICENSE,
  shouldShowICP,
} from "@/constants/legal";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import {
  CN_COMMUNITY_QR_IMAGE,
  DISCORD_INVITE_URL,
  DISCORD_QR_IMAGE,
} from "@/constants/community";
import { useT } from "@/i18n/t";
import { isCN, isGlobal } from "@/lib/region";

interface LegalFooterProps {
  icpPlacement?: "inline" | "right";
}

export const LegalFooter = ({ icpPlacement = "inline" }: LegalFooterProps) => {
  const currentYear = new Date().getFullYear();
  const t = useT();
  const { i18n } = useTranslation();
  const showICP = shouldShowICP();
  const [showQR, setShowQR] = useState(false);
  const globalTermsOfServiceUrl = getGlobalTermsOfServiceUrl(i18n.language);
  const footerLinkClass = "lw-site-link lw-site-link--muted transition-colors";
  const showInlineICP = showICP && icpPlacement === "inline";
  const showRightICP = showICP && icpPlacement === "right";

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
          <span>
            {isGlobal ? (
              <a href="/privacy-policy" className={footerLinkClass}>
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
              <a
                href={globalTermsOfServiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={footerLinkClass}
              >
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
                  href="/support"
                  className={footerLinkClass}
                >
                  {t("产品反馈")}
                </a>
              </>
            ) : null}
            {isGlobal ? (
              <>
                ·
                <a href="/open-source-licenses" className={footerLinkClass}>
                  {t("开源声明")}
                </a>
              </>
            ) : null}
          </span>
          {/* 加入交流群 — hover 展示二维码；国际站文案与二维码均可点击直达 Discord */}
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
                  className="absolute bottom-full left-1/2 z-20 mb-3 -translate-x-1/2 flex flex-col items-center gap-2 rounded-xl bg-white p-4 shadow-lg"
                  style={{ width: "200px" }}
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
                      <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
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
                      <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
                        {t("扫码加入交流群")}
                      </span>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </span>
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

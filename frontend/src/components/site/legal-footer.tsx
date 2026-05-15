import { useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { BEIAN_URL, ICP_LICENSE, shouldShowICP } from "@/constants/legal";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";

export const LegalFooter = () => {
  const currentYear = new Date().getFullYear();
  const t = useT();
  const showICP = shouldShowICP();
  const [showQR, setShowQR] = useState(false);

  return (
    <footer className="border-t border-black/8 bg-white">
      <div
        className="mx-auto px-6 py-5 md:px-10 lg:px-[80px]"
        style={{ maxWidth: "1440px" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] leading-[1.6] tracking-[-0.013em] text-black/50 md:gap-[22px] md:text-xs md:leading-[1.5]">
          <span>
            {t("© {{year}} LightVela 版权所有，由腾讯轻量云团队出品。", { year: currentYear })}
            {showICP && (
              <>
                {" "}
                <a
                  href={BEIAN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-black"
                >
                  {ICP_LICENSE}
                </a>
              </>
            )}
          </span>
          <span>
            {isGlobal ? (
              <Link to="/privacy-policy" className="transition-colors hover:text-black">
                {t("隐私政策")}
              </Link>
            ) : (
              <a
                href="https://cloud.tencent.com/document/product/301/11470"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-black"
              >
                {t("隐私政策")}
              </a>
            )}
            ·
            <a
              href="https://cloud.tencent.com/document/product/301/48034"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-black"
            >
              {t("服务条款")}
            </a>
          </span>
          {/* 加入交流群 — hover 展示二维码 */}
          <span
            className="relative"
            onMouseEnter={() => setShowQR(true)}
            onMouseLeave={() => setShowQR(false)}
          >
            <span className="cursor-pointer transition-colors hover:text-black">
              {t("加入交流群")}
            </span>
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
                  <img
                    src="/assets/landing/about/community-qr.png"
                    alt="加入交流群"
                    className="rounded-lg"
                    style={{ width: "168px", height: "168px" }}
                  />
                  <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
                    {t("扫码加入交流群")}
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </span>
        </div>
      </div>
    </footer>
  );
};

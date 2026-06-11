/**
 * LightVela 落地页 CTA 区底部三链接组件
 *
 * 抽离自 imports/Frame2147230025/sections/CtaSection.tsx，目的：
 *   1. 让"链接 + 二维码"等业务逻辑独立于 Figma 自动生成代码
 *      避免下次 Figma 重新导出 CtaSection 时被整体覆盖。
 *   2. 复用 legal-footer 的策略：
 *      - 隐私政策：国际站走内部 /privacy-policy 路由；国内站走外链
 *      - 服务条款：腾讯云协议外链
 *      - 加入用户交流群：hover 显示二维码（国内 community-qr / 国际 Discord）
 *
 * 二维码弹层用 React Portal 挂到 document.body，避免被父级 overflow-hidden 裁剪。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CN_PRIVACY_POLICY_URL } from "@/constants/legal";
import { isGlobal } from "@/lib/region";
import { useT } from "@/i18n/t";

const linkClassName = "transition-colors hover:text-black";

export function LandingCtaFooterLinks() {
  const t = useT();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [showQR, setShowQR] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  const updateAnchor = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setAnchor({ left: rect.left + rect.width / 2, top: rect.top });
  }, []);

  useEffect(() => {
    if (!showQR) return;
    updateAnchor();
    window.addEventListener("scroll", updateAnchor, true);
    window.addEventListener("resize", updateAnchor);
    return () => {
      window.removeEventListener("scroll", updateAnchor, true);
      window.removeEventListener("resize", updateAnchor);
    };
  }, [showQR, updateAnchor]);

  return (
    <p
      className="mt-6 text-[14px] font-['PingFang_SC:Regular',sans-serif] leading-6 lv-reveal lv-delay-200 flex items-center gap-x-2"
      style={{ height: "44px", paddingTop: "12px", paddingBottom: "12px", color: "#00000080" }}
    >
      {isGlobal ? (
        <Link to="/privacy-policy" className={linkClassName}>
          {t("隐私政策")}
        </Link>
      ) : (
        <a
          href={CN_PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
        >
          {t("隐私政策")}
        </a>
      )}
      <span aria-hidden="true">·</span>
      <a
        href="https://cloud.tencent.com/document/product/301/48034"
        target="_blank"
        rel="noopener noreferrer"
        className={linkClassName}
      >
        {t("服务条款")}
      </a>
      {isGlobal && (
        <>
          <span aria-hidden="true">·</span>
          <Link to="/open-source-licenses" className={linkClassName}>
            {t("开源声明")}
          </Link>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span
        ref={triggerRef}
        className={`relative cursor-pointer ${linkClassName}`}
        onMouseEnter={() => {
          updateAnchor();
          setShowQR(true);
        }}
        onMouseLeave={() => setShowQR(false)}
      >
        {t("加入用户交流群")}
      </span>
      {createPortal(
        <AnimatePresence>
          {showQR && anchor && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed flex flex-col items-center gap-2 rounded-xl bg-white p-4 shadow-lg pointer-events-none"
              style={{
                left: anchor.left,
                top: anchor.top,
                transform: "translate(-50%, calc(-100% - 12px))",
                width: "200px",
                zIndex: 9999,
              }}
            >
              <img
                src={
                  isGlobal
                    ? "/assets/landing/about/International-Discord.png"
                    : "/assets/landing/about/community-qr.png"
                }
                alt={t("加入交流群二维码")}
                className="rounded-lg"
                style={{ width: "168px", height: "168px" }}
              />
              <span className="whitespace-nowrap text-[11px] tracking-wider text-black/50">
                {isGlobal ? t("扫码加入 Discord 交流群") : t("扫码加入交流群")}
              </span>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </p>
  );
}

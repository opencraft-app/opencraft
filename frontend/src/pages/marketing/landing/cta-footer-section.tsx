import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { LegalFooter } from "@/components/site/legal-footer";
import { useT } from "@/i18n/t";
import { AGENTS_HOME_PATH, getAgentCreatingPath } from "@/lib/agent-routes";
import { DATONG_PAGE_IDS } from "@/observability/datong";
import { trackDatongClick } from "@/observability/datong-tracker";
import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";

export function CTAFooterSection({
  onLoginClick,
  isLoggedIn,
  hasBots,
  isSubscribed,
}: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
  hasBots: boolean;
  isSubscribed: boolean;
}) {
  const navigate = useNavigate();
  const t = useT();

  const handleCreateClick = () => {
    if (!isLoggedIn) {
      trackDatongClick("footer_create_now_btn", {
        pgid: DATONG_PAGE_IDS.HOME,
        params: { has_bots: hasBots, target: "login" },
      });
      onLoginClick();
      return;
    }
    if (isSubscribed) {
      /* 已订阅：直接进入我的龙虾页面（无龙虾时自动创建） */
      const target = hasBots ? AGENTS_HOME_PATH : getAgentCreatingPath(true);
      trackDatongClick("footer_create_now_btn", {
        pgid: DATONG_PAGE_IDS.HOME,
        params: { has_bots: hasBots, target },
      });
      navigate(target);
    } else {
      /* 未订阅：去选套餐 */
      trackDatongClick("footer_create_now_btn", {
        pgid: DATONG_PAGE_IDS.HOME,
        params: { has_bots: hasBots, target: "/subscribe" },
      });
      navigate("/subscribe");
    }
  };

  return (
    <>
      <section id="cta" className="relative overflow-hidden bg-white">
        {/* 蓝紫色渐变光晕装饰 — 层1: 大面积渐变（偏右侧） */}
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            right: "-20%",
            top: "-60%",
            width: "80%",
            height: "260%",
            background:
              "radial-gradient(ellipse at 60% 70%, rgba(170,127,255,0.45) 0%, rgba(40,93,255,0.15) 40%, rgba(13,85,255,0) 70%)",
            filter: "blur(100px)",
            opacity: 0.45,
          }}
        />
        {/* 蓝紫色渐变光晕装饰 — 层2: 暖色→蓝紫光晕（偏右侧） */}
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            right: "-10%",
            top: "5%",
            width: "65%",
            height: "120%",
            background:
              "radial-gradient(ellipse at 50% 50%, rgba(193,204,255,0.8) 0%, rgba(168,183,255,0.5) 30%, rgba(254,224,212,0.3) 55%, transparent 75%)",
            filter: "blur(120px)",
            opacity: 0.4,
          }}
        />

        <div className="relative z-10 mx-auto flex max-w-[1440px] flex-col px-6 py-[56px] md:px-[120px] md:py-[100px]">
          {/* 主内容：标题 + 按钮 */}
          <div className="flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between md:gap-10">
            <motion.div variants={staggerContainer} initial="hidden" whileInView="visible" viewport={viewportConfig} className="flex max-w-[560px] flex-col gap-3 md:gap-4">
              <motion.h2 variants={titleReveal} className="font-heading text-[26px] font-medium leading-[1.4] text-black md:text-[36px] md:leading-[1.56]">
                {t("准备好开启探索之旅了吗？")}
              </motion.h2>
              <motion.p variants={titleReveal} className="font-body text-sm leading-[1.5] text-black md:text-base">
                {t("你的 AI 在云端等你，随时随地伴你同行。")}
              </motion.p>
            </motion.div>

            <motion.div
              variants={fadeInUp}
              initial="hidden"
              whileInView="visible"
              viewport={viewportConfig}
              className="flex-shrink-0"
            >
              <button onClick={handleCreateClick} className="lw-cta-btn">
                <span className="lw-cta-btn__label">{t("立即创建")}</span>
                <span className="lw-cta-btn__icon">
                  <ArrowUpRight className="h-4 w-4 text-black" strokeWidth={2} />
                </span>
              </button>
            </motion.div>
          </div>
        </div>
      </section>
      <LegalFooter icpPlacement="right" />
    </>
  );
}

import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";
import { BEIAN_URL, ICP_LICENSE } from "@/constants/legal";

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

  const handleCreateClick = () => {
    if (!isLoggedIn) {
      onLoginClick();
      return;
    }
    if (isSubscribed) {
      /* 已订阅：直接进入我的龙虾页面（无龙虾时自动创建） */
    navigate(hasBots ? "/dashboard/settings" : "/dashboard/settings?creating=true");
    } else {
      /* 未订阅：去选套餐 */
      navigate("/subscribe");
    }
  };

  return (
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

      <div className="relative z-10 mx-auto flex max-w-[1440px] flex-col px-6 pb-6 pt-[56px] md:px-[120px] md:pb-10 md:pt-[100px]">
        {/* 主内容：标题 + 按钮
            - 桌面端：横向左右分布（标题左、按钮右）并居中对齐
            - 移动端：垂直堆叠（标题上、按钮下） */}
        <div className="flex flex-col items-start gap-8 md:flex-row md:items-center md:justify-between md:gap-10">
          <motion.div variants={staggerContainer} initial="hidden" whileInView="visible" viewport={viewportConfig} className="flex max-w-[560px] flex-col gap-3 md:gap-4">
            <motion.h2 variants={titleReveal} className="font-heading text-[26px] font-medium leading-[1.4] text-black md:text-[36px] md:leading-[1.56]">
              准备好开启探索之旅了吗？
            </motion.h2>
            <motion.p variants={titleReveal} className="font-body text-sm leading-[1.5] text-black md:text-base">
              你的 AI 在云端等你，随时随地伴你同行。
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
              <span className="lw-cta-btn__label">立即创建</span>
              <span className="lw-cta-btn__icon">
                <ArrowUpRight className="h-4 w-4 text-black" strokeWidth={2} />
              </span>
            </button>
          </motion.div>
        </div>

        {/* 版权信息 Footer
            - 与主内容之间用分隔线隔开（不再穿过任何内容）
            - 移动端上下留白更紧凑 */}
        <div className="mt-10 border-t border-black/8 pt-5 md:mt-16 md:pt-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-[1.6] tracking-[-0.013em] text-black/50 md:gap-[22px] md:text-xs md:leading-[1.5]">
            <span>
              © {new Date().getFullYear()} LightVela. All rights reserved.{" "}
              <a href={BEIAN_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-black">
                {ICP_LICENSE}
              </a>
            </span>
            <span>
              <a href="https://cloud.tencent.com/document/product/301/11470" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-black">
                隐私政策
              </a>
              ·
              <a href="https://cloud.tencent.com/document/product/301/48034" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-black">
                服务条款
              </a>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";

export function CTAFooterSection({
  onLoginClick,
  isLoggedIn,
}: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
}) {
  const navigate = useNavigate();

  const handleCreateClick = () => {
    if (isLoggedIn) {
      navigate("/subscribe");
    } else {
      onLoginClick();
    }
  };

  return (
    <section id="cta" className="relative overflow-hidden bg-white" style={{ height: 504 }}>
      {/* 底图 — 覆盖整个 CTA + Footer 区域 */}
      <div
        aria-hidden
        className="pointer-events-none absolute"
        style={{
          left: "-19.4%",
          top: 0,
          width: "159.9%",
          height: "149.4%",
          backgroundImage: "url(/assets/landing/cta-bg-new-46fd9f.png)",
          backgroundPosition: "center",
          backgroundSize: "cover",
          backgroundRepeat: "no-repeat",
        }}
      />
      {/* 蒙层 — 从左到右渐变，只覆盖左侧78%，右侧完全露出底图 */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0"
        aria-hidden
        style={{
          width: "78%",
          backgroundImage:
            "linear-gradient(90deg, rgba(225,229,208,0.94) 0%, rgba(241,229,184,0.8) 39%, rgba(241,229,184,0.7) 72%, rgba(241,229,184,0) 100%)",
        }}
      />

      <div className="relative z-10 mx-auto h-full max-w-[1440px] px-6 md:px-[120px]">
        {/* CTA 区 */}
        <motion.div variants={staggerContainer} initial="hidden" whileInView="visible" viewport={viewportConfig} className="flex max-w-[448px] flex-col gap-10" style={{ paddingTop: 100 }}>
          <motion.div variants={titleReveal} className="flex flex-col gap-4">
            <h2 className="font-heading text-[32px] font-medium leading-[1.75] text-black/90">
              开启旅程<br />准备好领养你的云端龙虾了吗？
            </h2>
            <p className="font-body text-base leading-[1.5] text-black/90">
              你的 AI 在云端等你，随时随地伴你同行。
            </p>
          </motion.div>
          <motion.div variants={fadeInUp}>
            <button onClick={handleCreateClick} className="lw-cta-btn">
              <span className="lw-cta-btn__label">创建LightClaw</span>
              <span className="lw-cta-btn__icon">
                <ArrowUpRight className="h-4 w-4 text-black" strokeWidth={2} />
              </span>
            </button>
          </motion.div>
        </motion.div>

        {/* Footer */}
        <div className="absolute bottom-0 left-6 right-6 border-t border-black/8 md:left-[120px] md:right-[120px]" style={{ padding: "20px 0" }}>
          <div className="flex items-center gap-[22px] text-xs leading-[1.5] tracking-[-0.013em] text-black/50">
            <span>
              © {new Date().getFullYear()} LightClaw. All rights reserved.{" "}
              <a href="https://beian.miit.gov.cn/#/Integrated/index" target="_blank" rel="noreferrer" className="transition-colors hover:text-black">
                京ICP备11018762号-1062
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

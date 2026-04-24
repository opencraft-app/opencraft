import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fadeInUp, staggerContainer, wordStagger, wordReveal, heroFloatStagger, heroFloatUp, heroFloatUpLeft, heroFloatUpRight, LOGO_URL } from "./constants";

/* 社交证明头像（Figma 76-79.svg 是 4 个带绿底的用户头像圆圈） */
const AVATAR_URLS = [
  "/assets/CodeBuddyAssets/1_702/76.svg",
  "/assets/CodeBuddyAssets/1_702/77.svg",
  "/assets/CodeBuddyAssets/1_702/78.svg",
  "/assets/CodeBuddyAssets/1_702/79.svg",
];

export function HeroSection(_props: {
  onLoginClick: () => void;
  isLoggedIn: boolean;
  hasBots: boolean;
}) {
  const navigate = useNavigate();

  const handleCreateClick = () => {
    navigate("/subscribe");
  };

  const buttonText = "创建LightClaw";

  /* ── CTA 按钮磁吸效果 ── */
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleBtnMouseMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    btn.style.transform = `translate(${x * 0.15}px, ${y * 0.25}px)`;
  }, []);
  const handleBtnMouseLeave = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    btn.style.transform = "translate(0, 0)";
  }, []);

  /* ── Hero 标题逐词拆分 ── */
  const titleWords = ["你的", "\u00A0AI\u00A0", "龙虾，", "懂你所想，", "伴你同行"];

  return (
    <section id="hero" className="relative overflow-x-clip bg-white pt-[60px]">
      {/* 粒子网格 Canvas 背景 */}
      {/* <ParticleGridCanvas className="pointer-events-auto absolute inset-0 z-0" /> */}

      {/* 三角渐变装饰光晕 */}
      <div className="pointer-events-none absolute left-1/2 top-[386px] h-[434px] w-[1593px] -translate-x-1/2 select-none" aria-hidden>
        <img src="/assets/CodeBuddyAssets/1_702/1.svg" alt="" className="absolute left-0 top-0 h-auto w-[1593px]" />
        <img src="/assets/CodeBuddyAssets/1_702/2.svg" alt="" className="absolute left-[674px] top-0 h-auto" />
      </div>

      {/* 底部红色光晕分隔线 — 全屏宽度，大屏幕也能铺满 */}
      <div
        className="lw-hero-glow pointer-events-none absolute left-1/2 top-[769px] h-[80px] w-[100vw] -translate-x-1/2 opacity-40"
        aria-hidden
      />

      {/* 装饰图片 — 小动物 3D 翻转上升效果 */}
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-[60px] mx-auto w-full max-w-[1440px] select-none"
        aria-hidden
        style={{ perspective: "1200px" }}
        variants={heroFloatStagger}
        initial="hidden"
        animate="visible"
      >
        {/* 龙虾主图 — 中间，Y轴 3D 翻转上升 */}
        <motion.div
          className="absolute left-1/2 top-[442px] -translate-x-[103px]"
          variants={heroFloatUp}
        >
          <img
            src="/assets/landing/hero/hero-lobster.png"
            alt=""
            className="lw-hero-float-1 w-[182px] h-[166px] object-contain drop-shadow-lg"
          />
        </motion.div>
        {/* 装饰图片1 — 左侧，Y轴 3D 翻转上升 */}
        <motion.div
          className="absolute left-1/2 top-[545px] -translate-x-[187px]"
          variants={heroFloatUpLeft}
        >
          <img
            src="/assets/landing/hero/hero-img-1.png"
            alt=""
            className="lw-hero-float-2 w-[102px] h-[143px] object-contain drop-shadow-lg"
          />
        </motion.div>
        {/* 装饰图片2 — 右侧，Y轴 3D 翻转上升 */}
        <motion.div
          className="absolute left-1/2 top-[490px] translate-x-[42px]"
          variants={heroFloatUpRight}
        >
          <img
            src="/assets/landing/hero/hero-img-2.png"
            alt=""
            className="lw-hero-float-3 w-[141px] h-[86px] object-contain drop-shadow-lg"
          />
        </motion.div>
      </motion.div>

      {/* 主内容容器 */}
      <div className="relative z-10 mx-auto w-full max-w-[1440px] px-6 md:px-20">
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="flex h-[710px] flex-col items-center pt-[146px]"
        >
          {/* 副标题行 */}
          <motion.div variants={fadeInUp} className="mb-[28px] flex flex-wrap items-center justify-center gap-3">
            <img src={LOGO_URL} alt="LightClaw" className="h-6 object-contain" />
            <div className="h-px w-[21px] rounded-full bg-neutral-600" />
            <div className="flex -space-x-2">
              {AVATAR_URLS.map((url, i) => (
                <img key={i} src={url} alt="" className="h-10 w-10 rounded-full border-[1.5px] border-white" />
              ))}
            </div>
            <span className="font-heading text-xl font-normal text-black/90">
              全托管&nbsp;OpenClaw&nbsp;服务，你的专属智能伙伴
            </span>
          </motion.div>

          {/* 主标题 — 逐词渐入动画 */}
          <motion.h1
            variants={wordStagger}
            className="mb-[47px] text-center font-heading text-[clamp(40px,4.44vw,64px)] font-semibold leading-[1.375] tracking-tight text-black/90"
          >
            {titleWords.map((word, i) => (
              <motion.span
                key={i}
                variants={wordReveal}
                className="inline-block"
              >
                {word}
              </motion.span>
            ))}
          </motion.h1>

          {/* CTA 按钮 — 呼吸光晕 + 磁吸效果 */}
          <motion.div variants={fadeInUp}>
            <button
              ref={btnRef}
              style={{ marginTop: 47 }}
              onClick={handleCreateClick}
              onMouseMove={handleBtnMouseMove}
              onMouseLeave={handleBtnMouseLeave}
              className="lw-cta-btn lw-cta-btn--glow"
            >
              <span className="lw-cta-btn__label">{buttonText}</span>
              <span className="lw-cta-btn__icon">
                <ArrowUpRight className="h-3 w-3 text-black" strokeWidth={2} />
              </span>
            </button>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

import { useRef, useCallback, useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useT } from "@/i18n/t";

import { assetUrl } from "@/lib/asset-url";
import { fadeInUp, staggerContainer, wordStagger, wordReveal, heroFloatStagger, heroFloatUpLeft, heroFloatUpRight } from "./constants";
import { StarfieldCanvas } from "./starfield-canvas";

/* 社交证明头像（Figma 导出 104x104 PNG，显示尺寸 40x40，Retina 清晰，总计 ~50KB） */
const AVATAR_URLS = [
  assetUrl("/assets/landing/hero/avatars/avatar-1.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-2.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-3.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-4.png"),
];

/* 电灯泡雪碧图：6 关键帧横向拼接，单帧 440x440（Retina 2x），总 WebP ≈ 34KB */
const BULB_SPRITE_URL = assetUrl("/assets/landing/hero/bulb-sprite.webp");
const BULB_FRAME_COUNT = 6;

/**
 * 电灯泡帧动画组件
 * 入场：从下方淡入上浮（无翻转），期间雪碧图帧动画“亮起来”
 * 常驻：轻微的上下浮动，雪碧图定格在最后一帧（点亮态），不再循环切帧
 * 使用 CSS background-position 切帧，单图请求 + GPU 合成，性能最佳
 */
function BulbAnimation({ className }: { className?: string }) {
  const [frameIndex, setFrameIndex] = useState(0);
  /* 入场动画是否播放完成；完成后停止雪碧图帧动画，定格最后一帧 */
  const [entranceDone, setEntranceDone] = useState(false);

  /* 帧动画定时器 — 雪碧图只跑一轮（6帧 × 160ms ≈ 960ms），跑完定格最后一帧，不再依赖入场动画完成回调 */
  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => {
        if (prev >= BULB_FRAME_COUNT - 1) {
          clearInterval(interval);
          return BULB_FRAME_COUNT - 1; // 定格最后一帧
        }
        return prev + 1;
      });
    }, 160);
    return () => clearInterval(interval);
  }, []);

  return (
    /* 入场：从下方淡入上浮（无翻转、无缩放、无模糊） */
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      /* duration 1.8s，配合 easeOut，柔缓入场 */
      /* delay 推迟到 1.8s：先让用户聚焦顶部光束向下扫射的过程，光抵达时灯泡才"被点亮" */
      transition={{ duration: 1.8, ease: "easeOut", delay: 1.8 }}
      onAnimationComplete={() => setEntranceDone(true)}
    >
      {/* 常驻阶段：仅做轻微的上下浮动，不再做任何旋转 */}
      <motion.div
        className="relative w-full h-full"
        animate={entranceDone ? { y: [0, -8, 0] } : { y: 0 }}
        transition={
          entranceDone
            ? { duration: 3.6, ease: "easeInOut", repeat: Infinity, repeatType: "loop" }
            : { duration: 0 }
        }
      >
        {/* 雪碧图帧切换：background-size 为 600%（6 帧），position 从 0% 到 100% 对应第 1~6 帧 */}
        <div
          className="absolute inset-0 w-full h-full drop-shadow-2xl"
          style={{
            backgroundImage: `url(${BULB_SPRITE_URL})`,
            backgroundSize: `${BULB_FRAME_COUNT * 100}% 100%`,
            backgroundPosition: `${(frameIndex / (BULB_FRAME_COUNT - 1)) * 100}% 0`,
            backgroundRepeat: "no-repeat",
          }}
        />
      </motion.div>
    </motion.div>
  );
}

export function HeroSection({
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

  const { t } = { t: useT() };

  const buttonText = !isLoggedIn || (!hasBots && !isSubscribed)
    ? t("立即创建")
    : t("我的Hermes");

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

  /* ── Hero 标题逐词拆分（中文原文直接作为 key） ── */
  const titleWords = [
    t("灵感随时发生，"),
    t("思考自由流动"),
  ];

  return (
    <section id="hero" className="relative overflow-x-clip bg-white pt-[60px]">
      {/* ── 三角形光束（flask.do 风格，从按钮点向下扫射的锥形光） ── */}
      {/* 光源点在按钮位置(~440px)，光束从顶部向下展开覆盖龙虾区域 */}
      {/* 入场动画由 Canvas 内部控制（从光源点向下扫射展开） */}
      {/* 移动端隐藏：性能降级 + 避免按钮下方出现淡紫色光晕色块 */}
      <div
        className="pointer-events-none absolute inset-x-0 top-[430px] hidden select-none md:block"
        aria-hidden
        style={{ height: 380 }}
      >
        <StarfieldCanvas className="absolute inset-0" />
      </div>

      {/* 底部光晕分隔线 — 光束快照射完时淡入（移动端隐藏，top 坐标基于 710px 桌面布局） */}
      <motion.div
        className="lw-hero-glow pointer-events-none absolute left-1/2 top-[769px] hidden h-[80px] w-[100vw] -translate-x-1/2 md:block"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.4 }}
        transition={{ duration: 1.5, delay: 2.0, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* 装饰图片 — 小动物淡入上浮效果（无翻转） */}
      {/* 移动端：灯泡缩小到 140px 并居中，两侧浮动装饰隐藏（窄屏堆叠会抢主标题视觉） */}
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-[60px] mx-auto w-full max-w-[1440px] select-none"
        aria-hidden
        variants={heroFloatStagger}
        initial="hidden"
        animate="visible"
      >
        {/* 电灯泡主图 — 入场淡入上浮 + 帧动画 + 持续上下浮动（动画由 BulbAnimation 内部控制） */}
        {/* 移动端：整个灯泡隐藏（按钮下方保持干净）；桌面：220x220、top 400px、略偏左 */}
        <div
          className="absolute left-1/2 top-[400px] -translate-x-[110px] hidden md:block"
        >
          <BulbAnimation className="relative h-[220px] w-[220px]" />
        </div>
        {/* 装饰图片1 — 左侧，淡入上浮（md 以下隐藏） */}
        <motion.div
          className="absolute left-1/2 top-[545px] hidden -translate-x-[187px] md:block"
          variants={heroFloatUpLeft}
        >
          <img
            src={assetUrl("/assets/landing/hero/hero-img-1.png")}
            alt=""
            className="lw-hero-float-2 w-[102px] h-[143px] object-contain drop-shadow-lg"
          />
        </motion.div>
        {/* 装饰图片2 — 右侧，淡入上浮（md 以下隐藏） */}
        <motion.div
          className="absolute left-1/2 top-[490px] hidden translate-x-[42px] md:block"
          variants={heroFloatUpRight}
        >
          <img
            src={assetUrl("/assets/landing/hero/hero-img-2.png")}
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
          className="flex min-h-[420px] flex-col items-center pt-[80px] md:h-[710px] md:min-h-0 md:pt-[146px]"
        >
          {/* 副标题行（移动端：头像列垂直堆叠到文案之上，文案自动换行并缩小） */}
          <motion.div variants={fadeInUp} className="mb-[28px] flex flex-col flex-wrap items-center justify-center gap-2 md:flex-row md:flex-nowrap md:gap-3">
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {AVATAR_URLS.map((url, i) => (
                <div
                  key={url}
                  aria-hidden
                  style={{
                    width: "40px",
                    height: "40px",
                    minWidth: "40px",
                    minHeight: "40px",
                    maxWidth: "40px",
                    maxHeight: "40px",
                    marginLeft: i === 0 ? 0 : "-8px",
                    borderRadius: "50%",
                    border: "1.5px solid #ffffff",
                    boxSizing: "border-box",
                    backgroundImage: `url(${url})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                    backgroundColor: "#f0f0f0",
                    flexShrink: 0,
                    flexGrow: 0,
                    display: "block",
                    overflow: "hidden",
                  }}
                />
              ))}
            </div>
            <span className="px-2 text-center font-heading text-sm font-normal text-black/90 md:px-0 md:text-xl">
              {t("云端专属 Hermes Agent，越聊越懂你的智能伙伴")}
            </span>
          </motion.div>

          {/* 主标题 — 逐词渐入动画（clamp 最小值下调以便手机端不爆屏） */}
          <motion.h1
            variants={wordStagger}
            className="mb-[32px] text-center font-heading text-[clamp(28px,6vw,64px)] font-semibold leading-[1.375] text-black/90 md:mb-[47px]"
          >
            {titleWords.map((word, i) => (
              <motion.span
                key={`${i}-${word}`}
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

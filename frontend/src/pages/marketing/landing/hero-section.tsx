import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useT } from "@/i18n/t";

import { assetUrl } from "@/lib/asset-url";
import { AGENTS_HOME_PATH, getAgentCreatingPath } from "@/router/paths";
import { fadeInUp, staggerContainer, wordStagger, wordReveal, heroFloatStagger, heroFloatUp, HERO_FLOAT_LOOP_DELAY } from "./constants";

/* 社交证明头像（Figma 导出 104x104 PNG，显示尺寸 40x40，Retina 清晰，总计 ~50KB） */
const AVATAR_URLS = [
  assetUrl("/assets/landing/hero/avatars/avatar-1.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-2.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-3.png"),
  assetUrl("/assets/landing/hero/avatars/avatar-4.png"),
];

/* 电灯泡雪碧图（6 关键帧横向拼接，单帧 440x440，WebP ≈ 35KB）
 *
 * 当前阶段灯泡常驻在「点亮」态（最后一帧），不再切帧动画；
 * 仍保留雪碧图是为了未来恢复入场点亮帧动画时无需重新出图——这是一个 *刻意* 的取舍。
 *
 * 这里通过 `background-size: 600%` + `background-position: 100% 0` 让 div
 * 仅显示雪碧图最右一帧；6 这个数字与图集帧数一一对应，封装为常量便于未来切换。
 */
const BULB_SPRITE_URL = assetUrl("/assets/landing/hero/bulb-sprite.webp");
/** 雪碧图横向帧数（与 bulb-sprite.webp 一一对应；恢复帧动画时复用此常量） */
const BULB_SPRITE_FRAMES = 6;

/**
 * 电灯泡装饰图组件
 *
 * 入场：从下方淡入上浮（与左右装饰图节奏一致）
 * 常驻：轻微的上下浮动；雪碧图定格在最后一帧（点亮态），不做帧切换。
 */
function BulbAnimation({ className }: { className?: string }) {
  return (
    /* 入场：从下方淡入上浮（与左右装饰图节奏一致） */
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: "easeOut", delay: 0.6 }}
    >
      {/* 常驻阶段：轻微的上下浮动，与左右装饰图同款节奏 */}
      <motion.div
        className="relative w-full h-full"
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 3.6, ease: "easeInOut", repeat: Infinity, repeatType: "loop", delay: HERO_FLOAT_LOOP_DELAY }}
      >
        {/* 雪碧图仅显示最后一帧（点亮态）：background-size 600% + position 100% 0 */}
        <div
          className="absolute inset-0 w-full h-full drop-shadow-2xl"
          style={{
            backgroundImage: `url(${BULB_SPRITE_URL})`,
            backgroundSize: `${BULB_SPRITE_FRAMES * 100}% 100%`,
            backgroundPosition: "100% 0",
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
      navigate(hasBots ? AGENTS_HOME_PATH : getAgentCreatingPath(true));
    } else {
      /* 未订阅：去选套餐 */
      navigate("/subscribe");
    }
  };

  const t = useT();

  const buttonText = !isLoggedIn || (!hasBots && !isSubscribed)
    ? t("立即创建")
    : t("我的 Hermes");

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
    <section id="hero" className="lw-hero-top-pad relative overflow-x-clip bg-white">
      {/* ── Hero 背景光晕（设计稿合成图：原 Figma Vector 7725 / 7729 / 7728 三层叠加扁平化输出） ── */}
      {/* 整体作为按钮下方装饰图（灯泡/星星/爱心）的背景，z 低于装饰图层 */}
      {/* 移动端隐藏：避免窄屏出现大面积色块 */}
      {/* 使用 background-image 方式：宽度撑满视口，高度按原图比例（1440:620）自适应 */}
      {/* 入场淡入 + 轻微上浮过渡，避免页面刷新瞬间硬切 */}
      {/* 注意：水平居中不能用 -translate-x-1/2（会被 framer-motion 的 transform 覆盖），改用 margin: 0 auto + left/right: 0 */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute top-[440px] z-0 mx-auto hidden w-[100vw] max-w-none select-none md:block"
        style={{
          left: 0,
          right: 0,
          aspectRatio: "1440 / 620",
          backgroundImage: `url(${assetUrl("/assets/landing/hero/hero-background.jpg")})`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "top center",
          backgroundSize: "1700px auto",
        }}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.2, ease: "easeOut", delay: 0.1 }}
      />


      {/* 装饰图片 — 小动物淡入上浮效果（无翻转） */}
      {/* 移动端：灯泡缩小到 140px 并居中，两侧浮动装饰隐藏（窄屏堆叠会抢主标题视觉） */}
      {/* z-[1] 确保装饰图层位于背景光晕（z-0）之上、主内容（z-10）之下 */}
      {/* ⚠️ 维护提醒：本层只承担入场 stagger，不要在此层再加 animate={{ y: ... }} 之类的常驻动画——
          framer-motion 会持续写 inline transform，覆盖子元素 className 中的 -translate-x-* 偏移，
          导致左右装饰图水平错位。常驻浮动一律放在内层 motion.div 上。 */}
      <motion.div
        className="pointer-events-none absolute inset-x-0 top-[60px] z-[1] mx-auto w-full max-w-[1440px] select-none"
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
        {/* 装饰图片1 — 左侧，淡入上浮 + 常驻浮动（md 以下隐藏） */}
        <motion.div
          className="absolute left-1/2 top-[545px] hidden -translate-x-[187px] md:block"
          variants={heroFloatUp}
        >
          {/* 内层：常驻轻微上下浮动（与灯泡一致，入场后稍延迟启动以避免与入场动画叠加抖动） */}
          <motion.div
            animate={{ y: [0, -10, 0] }}
            transition={{ duration: 4.5, ease: "easeInOut", repeat: Infinity, repeatType: "loop", delay: HERO_FLOAT_LOOP_DELAY }}
          >
            <img
              src={assetUrl("/assets/landing/hero/hero-img-1.png")}
              alt=""
              className="w-[70px] h-[89px] object-contain drop-shadow-lg"
            />
          </motion.div>
        </motion.div>
        {/* 装饰图片2 — 右侧，淡入上浮 + 常驻浮动（md 以下隐藏） */}
        <motion.div
          className="absolute left-1/2 top-[490px] hidden translate-x-[42px] md:block"
          variants={heroFloatUp}
        >
          {/* 内层：常驻轻微上下浮动（与灯泡一致） */}
          <motion.div
            animate={{ y: [0, -14, 0] }}
            transition={{ duration: 3.8, ease: "easeInOut", repeat: Infinity, repeatType: "loop", delay: HERO_FLOAT_LOOP_DELAY }}
          >
            <img
              src={assetUrl("/assets/landing/hero/hero-img-2.png")}
              alt=""
              className="w-[141px] h-[86px] object-contain drop-shadow-lg"
            />
          </motion.div>
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
              {t("云端专属个人 Agent，越聊越懂你的智能伙伴")}
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

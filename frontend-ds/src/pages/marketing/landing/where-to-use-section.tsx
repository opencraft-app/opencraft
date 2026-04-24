import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";

/* ── 3D 倾斜卡片组件 ── */
function TiltCard({
  children,
  className,
  style,
  variants,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  variants?: any;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const shineRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const card = cardRef.current;
    const shine = shineRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    card.style.transform = `perspective(600px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) scale3d(1.02, 1.02, 1.02)`;
    if (shine) {
      shine.style.opacity = "1";
      shine.style.background = `radial-gradient(circle at ${(x + 0.5) * 100}% ${(y + 0.5) * 100}%, rgba(255,255,255,0.25) 0%, transparent 60%)`;
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    const card = cardRef.current;
    const shine = shineRef.current;
    if (card) card.style.transform = "perspective(600px) rotateY(0deg) rotateX(0deg) scale3d(1, 1, 1)";
    if (shine) shine.style.opacity = "0";
  }, []);

  return (
    <motion.div
      variants={variants}
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
      style={{
        ...style,
        transition: "transform 0.2s ease-out",
        willChange: "transform",
      }}
    >
      {children}
      {/* 光泽扫过层 */}
      <div
        ref={shineRef}
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{ opacity: 0, transition: "opacity 0.3s ease" }}
      />
    </motion.div>
  );
}

export function WhereToUseSection() {
  return (
    <section
      id="where-to-use"
      style={{ backgroundColor: "rgba(177, 177, 177, 0.1)" }}
    >
      <div className="mx-auto max-w-[1440px] px-[120px] py-[120px]">
        {/* 头部：Badge + 标题（左对齐） */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="mb-16"
          style={{ maxWidth: 410 }}
        >
          <motion.div variants={fadeInUp} className="mb-4">
            <span className="lw-badge">
              <img
                src="/assets/landing/where-to-use/where-to-use-badge-icon.svg"
                alt=""
                className="h-7 w-7"
              />
              在哪用
            </span>
          </motion.div>
          <motion.h2
            variants={titleReveal}
            className="font-heading text-[40px] font-semibold leading-[1.4] tracking-tight text-black"
          >
            你的 App，直接可以用
          </motion.h2>
        </motion.div>

        {/* 三卡片区域 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="grid grid-cols-1 gap-6 md:grid-cols-3"
        >
          {/* 卡片1 - LightClaw */}
          <TiltCard
            variants={fadeInUp}
            className="relative overflow-hidden rounded-2xl bg-white"
            style={{ height: 296 }}
          >
            {/* 紫色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 49,
                top: -38.5,
                width: 307,
                height: 106,
                backgroundColor: "rgba(106, 0, 255, 0.4)",
                filter: "blur(200px)",
                opacity: 0.2,
              }}
            />
            {/* LightClaw 图标 */}
            <img
              src="/assets/landing/where-to-use/lightclaw-icon.png"
              alt="LightClaw"
              className="absolute"
              style={{ left: 32, top: 42, width: 57, height: 53 }}
            />
            {/* LightClaw Logo 文字 */}
            <img
              src="/assets/landing/where-to-use/lightclaw-logo-text.svg"
              alt="LightClaw"
              className="absolute"
              style={{ left: 40, top: 160, width: 117, height: 32 }}
            />
            {/* 描述文字 */}
            <p
              className="absolute text-[16px] font-normal leading-[1.75] text-black/70"
              style={{ left: 40, top: 208, width: 304 }}
            >
              一键进入LighClaw聊天，让交流变得更加便捷！
            </p>
          </TiltCard>

          {/* 卡片2 - QQ */}
          <TiltCard
            variants={fadeInUp}
            className="relative overflow-hidden rounded-2xl bg-white"
            style={{ height: 296 }}
          >
            {/* 青色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 49,
                top: -36.5,
                width: 307,
                height: 106,
                backgroundColor: "#90FFFD",
                filter: "blur(200px)",
                opacity: 0.2,
              }}
            />
            {/* QQ 图标 */}
            <div
              className="absolute overflow-hidden rounded"
              style={{ left: 40, top: 40, width: 48, height: 56 }}
            >
              <img
                src="/assets/landing/where-to-use/qq-logo.png"
                alt="QQ"
                className="h-full w-full object-cover"
              />
            </div>
            {/* QQ 标题 */}
            <span
              className="absolute font-heading text-[24px] font-medium leading-[1.33] text-black/90"
              style={{ left: 40, top: 160 }}
            >
              QQ
            </span>
            {/* 描述文字 */}
            <p
              className="absolute text-[16px] font-normal leading-[1.75] text-black/70"
              style={{ left: 40, top: 208, width: 304 }}
            >
              轻松一键连接QQ聊天，享受无缝沟通的乐趣！
            </p>
          </TiltCard>

          {/* 卡片3 - 微信 */}
          <TiltCard
            variants={fadeInUp}
            className="relative overflow-hidden rounded-2xl bg-white"
            style={{ height: 294 }}
          >
            {/* 绿色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 49,
                top: -36.5,
                width: 307,
                height: 106,
                backgroundColor: "#90FFA6",
                filter: "blur(200px)",
                opacity: 0.2,
              }}
            />
            {/* 微信图标 */}
            <img
              src="/assets/landing/where-to-use/wechat-logo-550dda.png"
              alt="微信"
              className="absolute object-contain"
              style={{ left: 33, top: 40, width: 56, height: 56 }}
            />
            {/* 微信标题 */}
            <span
              className="absolute font-heading text-[24px] font-medium leading-[1.33] text-black/90"
              style={{ left: 41, top: 160 }}
            >
              微信
            </span>
            {/* 描述文字 */}
            <p
              className="absolute text-[16px] font-normal leading-[1.75] text-black/70"
              style={{ left: 40, top: 208, width: 304 }}
            >
              迅速连接微信会话，随时随地保持联系！
            </p>
          </TiltCard>
        </motion.div>
      </div>
    </section>
  );
}

import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
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
  const t = useT();

  return (
    <section
      id="where-to-use"
      className="relative z-[1] overflow-hidden"
      style={{ backgroundColor: "#FFFFFF", borderRadius: "61px 61px 0 0" }}
    >
      <div className="mx-auto w-full max-w-[1200px] px-6 pb-[64px] pt-[56px] md:px-10 md:pb-[120px] md:pt-[88px]">
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
            <span
              className="inline-flex items-center gap-2 rounded-[38px] px-5 py-1.5 text-[18px] font-medium leading-[1.33] text-white"
              style={{
                background: "linear-gradient(117deg, rgba(2,2,2,1) 0%, rgba(19,16,30,1) 72%, rgba(90,81,255,1) 92%, rgba(210,121,255,1) 100%)",
              }}
            >
              <img
                  src={assetUrl("/assets/landing/where-to-use/where-to-use-badge-icon.svg")}
                alt=""
                className="h-7 w-7"
              />
              {t("在哪用")}
            </span>
          </motion.div>
          <motion.h2
            variants={titleReveal}
            className="font-heading text-[28px] font-semibold leading-[1.5] text-black md:text-[36px] md:leading-[1.78]"
          >
            {t("你的 App，直接可以用")}
          </motion.h2>
        </motion.div>

        {/* 四卡片区域 - QQ / 微信 / 飞书 / 企业微信：移动端 1列 → 平板 2列 → 桌面 4列 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-4"
        >
          {/* 卡片1 - QQ */}
          <TiltCard
            variants={fadeInUp}
            className="relative flex-1 overflow-hidden rounded-2xl bg-white"
            style={{ border: "1px solid #E9ECF1" }}
          >
            {/* 青色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 0,
                top: -19,
                width: "100%",
                height: 38,
                backgroundColor: "#90FFFD",
                filter: "blur(100px)",
                opacity: 0.1,
              }}
            />
            <div className="relative flex flex-col gap-8 px-10 py-8">
              {/* QQ 图标 */}
              <div className="h-10 w-10 overflow-hidden">
                <img
                  src={assetUrl("/assets/landing/where-to-use/qq-logo-standard.png")}
                  alt="QQ"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-heading text-[24px] font-medium leading-[1.33] text-black/90">
                  {t("QQ")}
                </h3>
                <p className="text-[16px] font-normal leading-[1.75] text-black/70">
                  {t("轻松一键连接QQ聊天，享受无缝沟通的乐趣。")}
                </p>
              </div>
            </div>
          </TiltCard>

          {/* 卡片2 - 微信 */}
          <TiltCard
            variants={fadeInUp}
            className="relative flex-1 overflow-hidden rounded-2xl bg-white"
            style={{ border: "1px solid #E9ECF1" }}
          >
            {/* 绿色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 0,
                top: -19,
                width: "100%",
                height: 38,
                backgroundColor: "#10CC42",
                filter: "blur(100px)",
                opacity: 0.1,
              }}
            />
            <div className="relative flex flex-col gap-8 px-10 py-8">
              {/* 微信图标 */}
              <div className="h-10 w-10 overflow-hidden">
                <img
                  src={assetUrl("/assets/landing/where-to-use/wechat-logo-550dda.png")}
                  alt="WeChat"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-heading text-[24px] font-medium leading-[1.33] text-black/90">
                  {t("微信")}
                </h3>
                <p className="text-[16px] font-normal leading-[1.75] text-black/70">
                  {t("迅速连接微信会话，随时随地保持联系。")}
                </p>
              </div>
            </div>
          </TiltCard>

          {/* 卡片3 - 飞书 */}
          <TiltCard
            variants={fadeInUp}
            className="relative flex-1 overflow-hidden rounded-2xl bg-white"
            style={{ border: "1px solid #E9ECF1" }}
          >
            {/* 紫色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 0,
                top: -19,
                width: "100%",
                height: 38,
                backgroundColor: "#7972FF",
                filter: "blur(100px)",
                opacity: 0.1,
              }}
            />
            <div className="relative flex flex-col gap-8 px-10 py-8">
              {/* 飞书图标 */}
              <div className="h-10 w-10 overflow-hidden">
                <img
                  src={assetUrl("/assets/landing/where-to-use/feishu-logo.png")}
                  alt="Lark"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-heading text-[24px] font-medium leading-[1.33] text-black/90">
                  {t("飞书")}
                </h3>
                <p className="text-[16px] font-normal leading-[1.75] text-black/70">
                  {t("文档、会议与聊天深度融合，点燃团队创造力火花。")}
                </p>
              </div>
            </div>
          </TiltCard>

          {/* 卡片4 - 企业微信（即将支持） */}
          <TiltCard
            variants={fadeInUp}
            className="relative flex-1 overflow-hidden rounded-2xl bg-white"
            style={{ border: "1px solid #E9ECF1" }}
          >
            {/* 蓝色光晕 */}
            <div
              className="pointer-events-none absolute"
              style={{
                left: 0,
                top: -19,
                width: "100%",
                height: 38,
                backgroundColor: "#6BB5FF",
                filter: "blur(100px)",
                opacity: 0.1,
              }}
            />
            <div className="relative flex flex-col gap-8 px-10 py-8">
              {/* 企业微信图标 */}
              <div className="h-10 w-10 overflow-hidden">
                <img
                  src={assetUrl("/assets/landing/where-to-use/wecom-logo.png")}
                  alt="WeCom"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-heading text-[24px] font-medium leading-[1.33] text-black/90">
                  {t("企业微信（即将支持）")}
                </h3>
                <p className="text-[16px] font-normal leading-[1.75] text-black/70">
                  {t("让沟通与工作流深度结合，随时随地开启丝滑协作。")}
                </p>
              </div>
            </div>
          </TiltCard>
        </motion.div>
      </div>
    </section>
  );
}

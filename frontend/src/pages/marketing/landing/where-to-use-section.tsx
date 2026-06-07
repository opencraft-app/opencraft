import { useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { isGlobal } from "@/lib/region";
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

/* ── 卡片数据类型 ──
 * icon 支持两种形态：
 *  - 形如 "/assets/..." 的静态资源路径（通过 assetUrl 包装）
 *  - 一个渲染 React 节点的函数，用于 lucide 等组件化图标占位
 */
type CardIcon =
  | { kind: "img"; src: string; alt: string }
  | { kind: "node"; render: () => React.ReactNode };

interface UseCaseCard {
  /** React key */
  key: string;
  /** 品牌光晕色 */
  glow: string;
  /** 图标 */
  icon: CardIcon;
  /** 已翻译好的主标题 */
  title: string;
  /** 已翻译好的描述 */
  desc: string;
}

/* ── 国内站卡片生成（组件内调用以便 t() 走字面量，extract 脚本可扫） ── */
function useCnCards(): UseCaseCard[] {
  const t = useT();
  return [
    {
      key: "qq",
      glow: "#90FFFD",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/qq-logo-standard.png"), alt: "QQ" },
      title: t("QQ"),
      desc: t("轻松一键连接QQ聊天，享受无缝沟通的乐趣。"),
    },
    {
      key: "wechat",
      glow: "#10CC42",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/wechat-logo-550dda.png"), alt: "WeChat" },
      title: t("微信"),
      desc: t("迅速连接微信会话，随时随地保持联系。"),
    },
    {
      key: "feishu",
      glow: "#7972FF",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/feishu-logo.png"), alt: "Lark" },
      title: t("飞书"),
      desc: t("文档、会议与聊天深度融合，点燃团队创造力火花。"),
    },
    {
      key: "wecom",
      glow: "#6BB5FF",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/wecom-logo.png"), alt: "WeCom" },
      title: t("企业微信"),
      desc: t("将 Hermes Agent 接入企业微信会话，让团队沟通与工作流协作更顺畅。"),
    },
  ];
}

/* ── 国际站卡片生成（WeChat / Telegram / WhatsApp / Discord，真·品牌 Logo） ── */
function useGlobalCards(): UseCaseCard[] {
  const t = useT();
  return [
    {
      key: "wechat",
      glow: "#10CC42",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/wechat-logo-550dda.png"), alt: "WeChat" },
      title: t("WeChat"),
      desc: t("迅速连接微信会话，随时随地保持联系。"),
    },
    {
      key: "telegram",
      glow: "#229ED9",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/telegram-logo.png"), alt: "Telegram" },
      title: t("Telegram"),
      desc: t("轻松一键连接 Telegram 聊天，畅享安全高效的全球沟通体验。"),
    },
    {
      key: "whatsapp",
      glow: "#25D366",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/whatsapp-logo.png"), alt: "WhatsApp" },
      title: t("WhatsApp"),
      desc: t("快速连接 WhatsApp 聊天，日常联系与消息处理更便捷。"),
    },
    {
      key: "discord",
      glow: "#5865F2",
      icon: { kind: "img", src: assetUrl("/assets/landing/where-to-use/discord-logo.png"), alt: "Discord" },
      title: t("Discord"),
      desc: t("连接 Discord 社群频道，让实时交流与协作更加自由。"),
    },
  ];
}

/* ── 单卡片渲染 ── */
function UseCaseCardView({ card }: { card: UseCaseCard }) {
  return (
    <TiltCard
      variants={fadeInUp}
      className="relative flex-1 overflow-hidden rounded-2xl bg-white"
      style={{ border: "1px solid #E9ECF1" }}
    >
      {/* 品牌色光晕 */}
      <div
        className="pointer-events-none absolute"
        style={{
          left: 0,
          top: -19,
          width: "100%",
          height: 38,
          backgroundColor: card.glow,
          filter: "blur(100px)",
          opacity: 0.1,
        }}
      />
      <div className="relative flex flex-col gap-8 px-10 py-8">
        {/* 图标 */}
        <div className="h-10 w-10 overflow-hidden">
          {card.icon.kind === "img" ? (
            <img
              src={card.icon.src}
              alt={card.icon.alt}
              className="h-full w-full object-contain"
            />
          ) : (
            card.icon.render()
          )}
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="font-heading text-[24px] font-medium leading-[1.33] text-black/90">
            {card.title}
          </h3>
          <p className="text-[16px] font-normal leading-[1.75] text-black/70">
            {card.desc}
          </p>
        </div>
      </div>
    </TiltCard>
  );
}

export function WhereToUseSection() {
  const t = useT();
  /* 两个 hook 无条件都调用以符合 Rules of Hooks；
   * isGlobal 是编译期常量，terser 会把未选中的一支在打包时消除为死代码。 */
  const cnCards = useCnCards();
  const globalCards = useGlobalCards();
  const cards = isGlobal ? globalCards : cnCards;

  return (
    <section
      id="where-to-use"
      className="relative z-[1] overflow-hidden"
      /* 刻意不设置 backgroundColor：依赖外层页面白底（避免遮挡 hero 区背景图末端的色调过渡）。
         若未来 hero 背景延伸到此区域，请改为 transparent 或重新评估色调衔接。 */
      style={{ borderRadius: "61px 61px 0 0" }}
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

        {/* 四卡片区域：移动端 1列 → 平板 2列 → 桌面 4列
         * 数据按区域（isGlobal）选择：国内站 QQ/微信/飞书/企微，国际站 WeChat/Telegram/WhatsApp/Discord */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-4"
        >
          {cards.map((card) => (
            <UseCaseCardView key={card.key} card={card} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

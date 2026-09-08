import { motion } from "framer-motion";

import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { fadeInUp, staggerContainer, titleReveal, viewportConfig } from "./constants";

/* ── 标签数据（3 行，每行 6 个，共 18 个场景） ── */
type TagItem = { icon: string; label: string };

const TAG_ICON_BASE = "/assets/landing/what-it-does";

/** 根据当前语言生成 3 行标签；i18n key 只放在 t 函数内部调用时传入。 */
function buildTagRows(t: ReturnType<typeof useT>): TagItem[][] {
  return [
    [
      { icon: `${TAG_ICON_BASE}/marketing.png`, label: t("市场营销") },
      { icon: `${TAG_ICON_BASE}/food.png`, label: t("营养食谱") },
      { icon: `${TAG_ICON_BASE}/analysis.png`, label: t("行业分析") },
      { icon: `${TAG_ICON_BASE}/email.png`, label: t("处理邮件") },
      { icon: `${TAG_ICON_BASE}/health.png`, label: t("健康追踪") },
      { icon: `${TAG_ICON_BASE}/timer.png`, label: t("定时任务") },
    ],
    [
      { icon: `${TAG_ICON_BASE}/product-compare.png`, label: t("选品竞品") },
      { icon: `${TAG_ICON_BASE}/price-compare.png`, label: t("商品比价") },
      { icon: `${TAG_ICON_BASE}/poster.png`, label: t("海报创作") },
      { icon: `${TAG_ICON_BASE}/document.png`, label: t("文档总结") },
      { icon: `${TAG_ICON_BASE}/game.png`, label: t("网页游戏") },
      { icon: `${TAG_ICON_BASE}/ppt.png`, label: t("制作 PPT") },
    ],
    [
      { icon: `${TAG_ICON_BASE}/meeting.png`, label: t("会议纪要") },
      { icon: `${TAG_ICON_BASE}/news.png`, label: t("新闻推送") },
      { icon: `${TAG_ICON_BASE}/water.png`, label: t("提醒喝水") },
      { icon: `${TAG_ICON_BASE}/finance.png`, label: t("智能理财") },
      { icon: `${TAG_ICON_BASE}/website.png`, label: t("网站开发") },
      { icon: `${TAG_ICON_BASE}/private-marketing.png`, label: t("私域营销") },
    ],
  ];
}

/* 每行对应的背景色（来自 Figma 三色循环） */
const ROW_COLORS = ["#F7FAFF", "#FFFAEF", "#FFF7F8"] as const;
/* 每行滚动方向（奇数行反向） */
const ROW_DIRECTIONS: Array<"left" | "right"> = ["left", "right", "left"];
/* 每行的循环时长（秒），越长越慢；不同行略有差异更有错落感 */
const ROW_DURATIONS = [38, 44, 40] as const;

/* ── 徽章的 Sparkle 图标（内联 SVG） ── */
function SparkleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M10 1.5L11.9 7.1C12.24 8.1 13.03 8.89 14.03 9.23L19.63 11.13L14.03 13.03C13.03 13.37 12.24 14.16 11.9 15.16L10 20.76L8.1 15.16C7.76 14.16 6.97 13.37 5.97 13.03L0.37 11.13L5.97 9.23C6.97 8.89 7.76 8.1 8.1 7.1L10 1.5Z"
        fill="url(#sparkle-g)"
      />
      <defs>
        <linearGradient id="sparkle-g" x1="0" y1="0" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFC779" />
          <stop offset="1" stopColor="#FF8051" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ── 单行滚动标签（无缝跑马灯：把标签重复一份，使用 CSS animation 平移 -50%） ── */
function TagRow({
  tags,
  bgColor,
  direction,
  durationSec,
}: {
  tags: TagItem[];
  bgColor: string;
  direction: "left" | "right";
  durationSec: number;
}) {
  /* 为了无缝循环，把标签重复 2 份 */
  const loopTags = [...tags, ...tags];

  const animationName = direction === "left" ? "lw-marquee-left" : "lw-marquee-right";

  return (
    <div className="relative overflow-hidden" style={{ width: "100%" }}>
      <div
        className="flex items-center"
        style={{
          width: "max-content",
          gap: 16,
          animation: `${animationName} ${durationSec}s linear infinite`,
        }}
      >
        {loopTags.map((tag, idx) => (
          <div
            key={`${tag.label}-${idx}`}
            className="flex flex-shrink-0 items-center gap-[6px] rounded-[48px] border"
            style={{
              backgroundColor: bgColor,
              borderColor: "rgba(217, 217, 217, 0.5)",
              padding: "8px 40px",
            }}
          >
            <div className="h-7 w-7 overflow-hidden">
              <img
                src={assetUrl(tag.icon)}
                alt=""
                className="h-full w-full object-contain"
                draggable={false}
              />
            </div>
            <span className="font-heading text-[16px] font-medium leading-[1.5] text-black">
              {tag.label}
            </span>
          </div>
        ))}
      </div>
      {/* 左右两端羽化蒙层：只保留末端 82px 的白→透明渐变（设计稿 319:6329 的渐变段） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[2]"
        style={{
          width: 82,
          background:
            "linear-gradient(90deg, #FFFFFF 0%, rgba(255,255,255,0) 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-[2]"
        style={{
          width: 82,
          background:
            "linear-gradient(-90deg, #FFFFFF 0%, rgba(255,255,255,0) 100%)",
        }}
      />
    </div>
  );
}

export function WhatItDoesSection() {
  const t = useT();
  const tagRows = buildTagRows(t);

  return (
    <section
      id="what-it-does"
      className="relative z-[1] overflow-hidden bg-white"
    >
      <div className="mx-auto w-full max-w-[1200px] px-6 pt-[48px] pb-[48px] md:px-10 md:pt-[72px] md:pb-[72px]">
        {/* 头部：Badge + 标题（左对齐） */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="mb-16"
          style={{ maxWidth: 360 }}
        >
          {/* 橙色渐变 Badge：能做什么 */}
          <motion.div variants={fadeInUp} className="mb-4">
            <span
              className="inline-flex items-center gap-2 rounded-[38px] px-5 py-1.5 text-[20px] font-medium leading-[1.2] text-white"
              style={{
                background:
                  "linear-gradient(126deg, rgba(2,2,2,1) 0%, rgba(30,16,16,1) 79%, rgba(255,128,81,1) 95%, rgba(255,199,121,1) 100%)",
              }}
            >
              <SparkleIcon />
              {t("能做什么")}
            </span>
          </motion.div>

          {/* 主标题（移动端字号缩小） */}
          <motion.h2
            variants={titleReveal}
            className="font-heading text-[28px] font-semibold leading-[1.5] text-black md:text-[36px] md:leading-[1.78]"
          >
            {t("你只管说，它帮你办")}
          </motion.h2>
        </motion.div>

        {/* 三行滚动标签 */}
        <motion.div
          variants={fadeInUp}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="flex flex-col gap-6"
        >
          {tagRows.map((row, i) => (
            <TagRow
              key={i}
              tags={row}
              bgColor={ROW_COLORS[i % ROW_COLORS.length] ?? "#F7FAFF"}
              direction={ROW_DIRECTIONS[i % ROW_DIRECTIONS.length] ?? "left"}
              durationSec={ROW_DURATIONS[i % ROW_DURATIONS.length] ?? 40}
            />
          ))}
        </motion.div>
      </div>

      {/* 跑马灯动画（组件内联 style，避免影响全局） */}
      <style>{`
        @keyframes lw-marquee-left {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes lw-marquee-right {
          0%   { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
      `}</style>
    </section>
  );
}

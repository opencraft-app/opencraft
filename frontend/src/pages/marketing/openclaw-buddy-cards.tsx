/**
 * 抽卡卡牌的视觉原语：卡背（CardBack）+ 卡面（SoulFaceCard）。
 * 抽卡 modal 与 BuddyPanel 的 9 格网格共用。
 *
 * 卡背图、拼图 icon、彩虹边框颜色都从 SkillHub COS 公开资源直链；
 * 视觉对齐 SkillHub `/hermes` DrawModal 与 `/hermes/edit-soul`。
 */

import { Eye } from "lucide-react";
import { useT } from "@/i18n/t";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { getSoulVisuals } from "@/lib/soul-visuals";

/** 卡背纹理（来自 SkillHub COS，公开图片资源） */
export const CARD_BACK_IMG =
  "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/86be223d-cfc5-41bf-9950-e7d5b1353e13.png";

/** 拼图图标（来自 SkillHub COS） */
export const PUZZLE_ICON =
  "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/d224cdb8-a36f-43ef-8da7-99ba79ef5cba.png";

/** 彩虹渐变高亮边框（active 态） */
export const RAINBOW_GRADIENT =
  "linear-gradient(224deg, #1446FF 0%, #249CFF 25%, #7AF1FF 51%, #FFD900 74%, #FF966D 100%)";

/**
 * CardBack —— 卡牌背面。灰底（默认）或彩虹渐变（active）边框 + 卡背纹理 + 拼图 icon。
 *
 * 用法：
 *   - 抽卡 modal 跑灯过程中的 6 张候选卡（active 跟随高亮）
 *   - BuddyPanel 9 格网格里未抽到的空卡槽（默认态）
 */
export function CardBack({
  active = false,
  iconClassName = "h-8 w-8",
}: {
  active?: boolean;
  /** 拼图 icon 尺寸的 tailwind 类，默认 h-8 w-8（32px）。slot 槽位用更大的 icon。 */
  iconClassName?: string;
}) {
  return (
    <div
      className="relative aspect-[112/157] w-full overflow-hidden rounded transition-shadow duration-200"
      style={{
        background: active ? RAINBOW_GRADIENT : "#E9E9E9",
        padding: active ? 2 : 0.6,
        boxShadow: active ? "0 32px 54px rgba(0,0,0,0.05)" : "none",
      }}
    >
      <div className="relative h-full w-full overflow-hidden rounded-[3px] bg-white">
        <img
          src={CARD_BACK_IMG}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <img
          src={PUZZLE_ICON}
          alt=""
          draggable={false}
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${iconClassName}`}
        />
        <div
          className="pointer-events-none absolute rounded-[3px] border"
          style={{
            inset: 2.5,
            borderColor: "rgba(0,0,0,0.08)",
            borderWidth: 0.6,
          }}
        />
      </div>
    </div>
  );
}

/**
 * SoulFaceCard —— 翻牌后的人设正面，soul.bgUrl 作整卡背景图 + 底部 displayName + summary。
 *
 * size：
 *   - "slot"：宽度 100% 自适应 grid cell（BuddyPanel 9 格用），保持 112/157 纵横比
 *   - "small"：156px 宽（抽卡 modal 翻牌时的小卡）
 *   - "large"：240px 宽（reveal 阶段的大卡）+ 4px 白色描边 + 强阴影 + 「人设解读」按钮
 */
export function SoulFaceCard({
  soul,
  size,
  onInterpret,
}: {
  soul: SkillHubSoul;
  size: "slot" | "small" | "large";
  onInterpret?: () => void;
}) {
  const t = useT();
  const visuals = getSoulVisuals(soul);
  const isLarge = size === "large";
  const isSlot = size === "slot";
  return (
    <div
      className="relative overflow-hidden rounded-[10px]"
      style={{
        width: isSlot ? "100%" : isLarge ? 240 : 156,
        aspectRatio: isLarge ? "240 / 338" : "112 / 157",
        containerType: isSlot ? "inline-size" : undefined,
        background: visuals.bgUrl
          ? `url(${visuals.bgUrl}) center/cover no-repeat`
          : "#f0f0f0",
        border: isLarge ? "4px solid #fff" : "2px solid #fff",
        boxShadow: isLarge
          ? "0 26px 63px rgba(0,0,0,0.08)"
          : "0 12px 32px rgba(0,0,0,0.10)",
      }}
    >
      {/* 底部信息浮层 */}
      <div className={`absolute inset-x-3 bottom-3 flex flex-col ${isLarge ? "gap-1" : "gap-0.5"}`}>
        <div
          className={`text-center font-normal text-black ${
            isLarge ? "leading-[1.4em]" : "leading-[1.25em]"
          }`}
          style={{
            fontFamily: "var(--font-chuangji)",
            fontSize: isLarge ? 20 : isSlot ? "clamp(10px, 13cqw, 15px)" : 15,
          }}
        >
          {soul.displayName}
        </div>
        <p
          className={`line-clamp-2 leading-[1.5em] ${
            isLarge ? "text-center" : "text-left"
          }`}
          style={{
            color: "rgba(0,0,0,0.7)",
            fontSize: isLarge ? 13 : isSlot ? "clamp(8px, 9.5cqw, 11px)" : 11,
          }}
        >
          {soul.summary}
        </p>
        {/* 「人设解读」link：slot/small 尺寸用 SkillHub 同款迷你内联样式 */}
        {!isLarge && onInterpret && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onInterpret();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onInterpret();
              }
            }}
            className="mt-1 flex cursor-pointer items-center justify-end gap-[3px] text-black/55 transition-colors duration-200 hover:text-[#3957FF]"
          >
            <Eye className="h-3 w-3" />
            <span className="text-[9px] leading-[1.4em] underline">
              {t("人设解读")}
            </span>
          </div>
        )}
        {isLarge && onInterpret && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onInterpret}
              className="inline-flex items-center gap-1 font-medium underline underline-offset-4 transition-opacity hover:opacity-70"
              style={{
                color: "rgba(0,0,0,0.72)",
                fontSize: 12,
                lineHeight: "18px",
              }}
            >
              <Eye className="h-3 w-3" />
              {t("人设解读")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * SoulSpecRenderer —— 把 SkillHub 公共 souls API 返回的 `content` 字段渲染成结构化文档。
 *
 * 后端返回的 content **不是 markdown**：是一段中文段落，用 `【xxx】` 区分小节、单换行分行。
 * 直接喂给 markdown 渲染器会被压成一坨没结构的长文（markdown 把单换行当作空格），
 * 所以这里按 `【xxx】` 自己分段、每行 `<p>`，避免格式乱掉。
 */
export function SoulSpecRenderer({ content }: { content: string }) {
  if (!content) return null;
  const lines = content.split("\n");
  return (
    <div className="text-sm leading-7" style={{ color: "rgba(0,0,0,0.75)" }}>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const headerMatch = trimmed.match(/^【(.+?)】(.*)$/);
        if (headerMatch) {
          const title = headerMatch[1] ?? "";
          const rest = (headerMatch[2] ?? "").trim();
          return (
            <div key={i} className="mt-5 first:mt-0">
              <h4
                className="text-[15px] font-semibold"
                style={{ color: "rgba(0,0,0,0.90)" }}
              >
                {title}
              </h4>
              {rest && <p className="mt-2">{rest}</p>}
            </div>
          );
        }
        return (
          <p key={i} className="mt-2 first:mt-0">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

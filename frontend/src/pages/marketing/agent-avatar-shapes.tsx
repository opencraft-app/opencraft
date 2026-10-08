/**
 * 几何体头像
 * ──────────────────────────────────────────────────────────────
 * 纯 SVG 绘制的机器人头像：一个几何形状 + 两只眼睛。
 * 形状定义与 Expo 原生侧栏共用；换色/换形状不需要图片请求。
 *
 * 用法：
 *   <GeometricAvatar shapeId="blob" color="#C2489B" size={96} />
 */

import { useMemo } from "react";

import { AVATAR_SHAPES, type AvatarShapeId } from '@opencraft/mobile-bot-bridge/avatar-shapes';
import { cn } from "@/lib/utils";

/* Avatar shapes */

export { AVATAR_SHAPES };
export type { AvatarShapeId };

/** Resolve labels at render time so language changes also update accessible names. */
export const getAvatarShapeLabel = (id: AvatarShapeId, t: (message: string) => string): string => {
  switch (id) {
    case "circle": return t("圆形");
    case "squircle": return t("圆角方");
    case "square": return t("方形");
    case "teardrop": return t("水滴");
    case "hexagon": return t("六边形");
    case "burst": return t("齿轮");
    case "triangle": return t("三角");
    case "egg": return t("蛋形");
    // Match GeometricAvatar's default shape if persisted data has an unknown id.
    case "blob":
    default: return t("水母");
  }
};

/* ──────────────────────────────── 配色 ──────────────────────────────── */

/**
 * 头像可选配色。
 *
 * 走鲜亮实色（高饱和 / 中高明度），而不是之前那套低饱和柔光色 ——
 * 头像在侧边栏里只有 32px，低饱和色缩到那个尺寸后几乎分辨不出彼此，
 * 一排 bot 看上去是一片灰蒙蒙的糖果色。鲜亮实色在小尺寸下才立得住。
 *
 * 明度统一压在能承载白色眼睛的区间：太浅眼睛会糊，太深又回到深色压迫感。
 */
export const AVATAR_COLORS = [
  { id: "violet", label: "亮紫", value: "#8B5CF6" },
  { id: "tangerine", label: "橘橙", value: "#F97316" },
  { id: "azure", label: "亮蓝", value: "#3B82F6" },
  { id: "teal", label: "青绿", value: "#14B8A6" },
  { id: "emerald", label: "翠绿", value: "#10B981" },
  { id: "amber", label: "琥珀黄", value: "#F59E0B" },
  { id: "rose", label: "玫红", value: "#F43F5E" },
  { id: "pink", label: "亮粉", value: "#EC4899" },
  { id: "indigo", label: "靛蓝", value: "#6366F1" },
  { id: "lime", label: "青柠绿", value: "#65A30D" },
];

export const DEFAULT_AVATAR_SHAPE: AvatarShapeId = "blob";
/** 默认取第一个（亮紫），与 LightVela 品牌紫色接近 */
export const DEFAULT_AVATAR_COLOR = AVATAR_COLORS[0]!.value;

/* ──────────────────────────────── 组件 ──────────────────────────────── */

export const GeometricAvatar = ({
  shapeId,
  color,
  size = 96,
  className,
  alive = false,
}: {
  shapeId: AvatarShapeId;
  color: string;
  size?: number;
  className?: string;
  /**
   * 开启「活着」的循环动效：呼吸 + 定时眨眼 + 眼珠左右看。
   * 只给当前选中的大头像开，列表里的小头像保持安静，
   * 否则一屏十几个头像同时动会很吵。
   * prefers-reduced-motion 下由 styles.css 的全局规则自动停掉。
   */
  alive?: boolean;
}) => {
  const shape = useMemo(
    () => AVATAR_SHAPES.find((item) => item.id === shapeId) ?? AVATAR_SHAPES[0]!,
    [shapeId],
  );

  /* 眼睛几何：两枚竖直胶囊，深色半透明叠在形体上，任何配色下都清晰 */
  const eyeTop = shape.eyeY - 6;
  const leftEyeX = 50 - shape.eyeDx - 3;
  const rightEyeX = 50 + shape.eyeDx - 3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("lv-avatar", alive && "lv-avatar--alive", className)}
      aria-hidden="true"
      focusable="false"
    >
      {/* 形体与眼睛一起缩放，呼吸时不会错位 —— 所以动效挂在这层 g 上 */}
      <g className="lv-avatar__body" style={{ transformOrigin: "50px 55px" }}>
        <path d={shape.path} fill={color} />
        {/*
          眼珠横向游移挂在这层；眨眼的纵向压缩挂在每只眼睛自己身上。

          眼睛用白色：配色换成鲜亮实色后，原来的深色眼珠（rgba(0,0,0,0.82)）
          在饱和底色上会糊成一团，32px 的侧边栏头像尤其看不清。
        */}
        <g className="lv-avatar__eyes">
          <rect
            className="lv-avatar__eye"
            x={leftEyeX}
            y={eyeTop}
            width={6}
            height={12}
            rx={3}
            fill="#FFFFFF"
            style={{ transformOrigin: `${leftEyeX + 3}px ${shape.eyeY}px` }}
          />
          <rect
            className="lv-avatar__eye"
            x={rightEyeX}
            y={eyeTop}
            width={6}
            height={12}
            rx={3}
            fill="#FFFFFF"
            style={{ transformOrigin: `${rightEyeX + 3}px ${shape.eyeY}px` }}
          />
        </g>
      </g>
    </svg>
  );
};

/* ─────────────────────────────── 随机工具 ─────────────────────────────── */

/** 从数组里随机取一个，可排除当前值避免"换了个寂寞" */
const pickRandom = <T,>(list: T[], exclude?: T): T => {
  const pool = exclude === undefined ? list : list.filter((item) => item !== exclude);
  const source = pool.length > 0 ? pool : list;
  return source[Math.floor(Math.random() * source.length)]!;
};

/** 随机一组「形状候选 + 配色」，供「换一批」使用 */
export const randomizeAvatarBatch = (params: {
  /** 当前配色，用于避免换出同色 */
  currentColor?: string;
  /** 候选形状个数 */
  count?: number;
}) => {
  const { currentColor, count = 8 } = params;
  const shuffled = [...AVATAR_SHAPES].sort(() => Math.random() - 0.5).slice(0, count);
  return {
    shapes: shuffled,
    color: pickRandom(AVATAR_COLORS.map((item) => item.value), currentColor),
  };
};

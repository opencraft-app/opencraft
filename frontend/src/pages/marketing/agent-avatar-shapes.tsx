/**
 * 几何体头像（静态 Demo）
 * ──────────────────────────────────────────────────────────────
 * 纯 SVG 绘制的机器人头像：一个几何形状 + 两只眼睛。
 * 形状与配色都是前端常量，不依赖任何图片资源，换色/换形状零请求。
 *
 * 用法：
 *   <GeometricAvatar shapeId="blob" color="#C2489B" size={96} />
 */

import { useMemo } from "react";

import { cn } from "@/lib/utils";

/* ──────────────────────────────── 形状 ──────────────────────────────── */

export type AvatarShapeId =
  | "blob"
  | "circle"
  | "squircle"
  | "square"
  | "teardrop"
  | "hexagon"
  | "burst"
  | "triangle"
  | "egg";

/** 形状定义：统一 100×100 viewBox，path 为形体轮廓 */
type ShapeDef = {
  id: AvatarShapeId;
  label: string;
  path: string;
  /** 眼睛中心 Y（部分形状重心偏移，需要单独微调） */
  eyeY: number;
  /** 两眼间距的一半 */
  eyeDx: number;
};

/** Resolve labels at render time so language changes also update accessible names. */
export const getAvatarShapeLabel = (id: AvatarShapeId, t: (message: string) => string): string => ({
  blob: t("水母"),
  circle: t("圆形"),
  squircle: t("圆角方"),
  square: t("方形"),
  teardrop: t("水滴"),
  hexagon: t("六边形"),
  burst: t("齿轮"),
  triangle: t("三角"),
  egg: t("蛋形"),
})[id];

export const AVATAR_SHAPES: ShapeDef[] = [
  {
    id: "blob",
    label: "水母",
    // 不规则圆润 blob，左右略不对称，手绘感
    path: "M50 8c16 0 29 6 36 17 7 11 8 26 4 38-4 12-14 22-28 25-14 3-30 1-40-8C12 71 6 57 8 43 10 29 18 18 30 12c6-3 13-4 20-4z",
    eyeY: 50,
    eyeDx: 12,
  },
  {
    id: "circle",
    label: "圆形",
    path: "M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88z",
    eyeY: 50,
    eyeDx: 12,
  },
  {
    id: "squircle",
    label: "圆角方",
    path: "M32 8h36c14 0 24 10 24 24v36c0 14-10 24-24 24H32C18 92 8 82 8 68V32C8 18 18 8 32 8z",
    eyeY: 50,
    eyeDx: 12,
  },
  {
    id: "square",
    label: "方形",
    path: "M24 10h52c8 0 14 6 14 14v52c0 8-6 14-14 14H24c-8 0-14-6-14-14V24c0-8 6-14 14-14z",
    eyeY: 50,
    eyeDx: 12,
  },
  {
    id: "teardrop",
    label: "水滴",
    // 上尖下圆的水滴
    path: "M50 6c14 20 34 36 34 54a34 34 0 0 1-68 0C16 42 36 26 50 6z",
    eyeY: 60,
    eyeDx: 11,
  },
  {
    id: "hexagon",
    label: "六边形",
    path: "M46 7a8 8 0 0 1 8 0l30 17a8 8 0 0 1 4 7v34a8 8 0 0 1-4 7L54 89a8 8 0 0 1-8 0L16 72a8 8 0 0 1-4-7V31a8 8 0 0 1 4-7z",
    eyeY: 50,
    eyeDx: 12,
  },
  {
    id: "burst",
    label: "齿轮",
    // 星芒 / 齿轮状，12 个尖
    path: "M50 4l7 10 12-6 3 13 13 0-3 13 11 7-8 10 8 10-11 7 3 13-13 0-3 13-12-6-7 10-7-10-12 6-3-13-13 0 3-13-11-7 8-10-8-10 11-7-3-13 13 0 3-13 12 6z",
    eyeY: 50,
    eyeDx: 11,
  },
  {
    id: "triangle",
    label: "三角",
    path: "M43 12a8 8 0 0 1 14 0l32 58a8 8 0 0 1-7 12H18a8 8 0 0 1-7-12z",
    eyeY: 58,
    eyeDx: 11,
  },
  {
    id: "egg",
    label: "蛋形",
    path: "M50 6c18 0 32 20 32 42 0 24-14 40-32 40S18 72 18 48C18 26 32 6 50 6z",
    eyeY: 52,
    eyeDx: 12,
  },
];

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
  { id: "tangerine", label: "橘橙", value: "#F97316" },
  { id: "violet", label: "亮紫", value: "#8B5CF6" },
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

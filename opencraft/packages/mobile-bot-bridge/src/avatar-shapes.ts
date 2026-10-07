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

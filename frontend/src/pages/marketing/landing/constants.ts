/**
 * Landing page shared animation variants, viewport config, and asset URLs.
 */

export const fadeInUp = {
  hidden: { opacity: 0, y: 24, filter: "blur(4px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
  },
};

export const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.15, delayChildren: 0.1 },
  },
};

export const titleReveal = {
  hidden: { opacity: 0, y: 32, filter: "blur(8px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] },
  },
};

export const cardReveal = {
  hidden: { opacity: 0, y: 20, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

export const viewportConfig = { once: true, margin: "-80px" as const };

/* ── 微动效增强 variants ── */

/** 逐词渐入（Hero 标题用） */
export const wordStagger = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.2 },
  },
};

export const wordReveal = {
  hidden: { opacity: 0, y: 20, filter: "blur(6px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

/** 水平线从中心向两侧展开 */
export const lineExpand = {
  hidden: { scaleX: 0, opacity: 0 },
  visible: {
    scaleX: 1,
    opacity: 1,
    transition: { duration: 0.8, ease: [0.22, 1, 0.36, 1] },
  },
};

/** 垂直线从上向下生长 */
export const lineGrow = {
  hidden: { scaleY: 0, opacity: 0 },
  visible: {
    scaleY: 1,
    opacity: 1,
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.3 },
  },
};

/** 步骤连接线滚动生长 */
export const stepLineGrow = {
  hidden: { scaleY: 0 },
  visible: (idx: number) => ({
    scaleY: 1,
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: idx * 0.18 + 0.3 },
  }),
};

/* ── Hero 小动物悬浮上升动画（无翻转） ── */

/** 悬浮上升容器（三张图同时浮现，无错开） */
/* delayChildren 0.6s：光束刚扫到灯泡区域时，三张装饰图一起被"照"出来；staggerChildren 0 表示同步出现 */
export const heroFloatStagger = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0, delayChildren: 0.6 },
  },
};

/** 小动物从下方淡入上浮 — 中间 */
export const heroFloatUp = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

/** 小动物从下方淡入上浮 — 左侧 */
export const heroFloatUpLeft = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

/** 小动物从下方淡入上浮 — 右侧 */
export const heroFloatUpRight = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1],
    },
  },
};

export const MASCOT_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/b66bfc9f-cc73-4f9c-8b4b-efde1e6a2cb4.png";

export const CHAT_AVATAR_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/694c7386-bfcf-4bb0-8393-efc9589d296f.png";

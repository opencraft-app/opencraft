/**
 * Soul 视觉资产表 —— 镜像自 SkillHub 前端 `client/src/constants/souls.ts`。
 *
 * SkillHub 公共 API `/api/v1/souls` **不**返回这些字段（它们在他们前端 hardcoded），
 * 但图片 URL 都是腾讯云 COS 公开资源、跨域可用，所以 lightvela 直接复用同一份 URL，
 * 不另外下载/转存。
 *
 * 维护提醒：
 *   - 16 张 soul 是 SkillHub v1.0.0 基础人设，预期改动频率极低；
 *   - 真要同步，去 SkillHub 项目的 `constants/souls.ts` 把 id/avatar/bgUrl/color 抄过来即可；
 *   - 其它字段（languageSystem / interpretation / description）lightvela 用不到，不复刻。
 */
import type { SkillHubSoul } from "@/lib/skillhub-api";

/** 5 种主题渐变色（reveal 阶段全屏背景 + 卡片底色） */
export const SOUL_COLOR_MAP = {
  orange: "linear-gradient(0deg, #FFF 39.42%, #FFA600 100%)",
  green: "linear-gradient(0deg, #FFF 39.42%, #62BD4C 100%)",
  red: "linear-gradient(0deg, #FFF 39.42%, #FF5059 100%)",
  purple: "linear-gradient(0deg, #FFF 39.42%, #7E61FF 100%)",
  blue: "linear-gradient(0deg, #FFF 39.42%, #2B80FF 100%)",
} as const;

type ColorKey = keyof typeof SOUL_COLOR_MAP;

export interface SoulVisual {
  /** 圆形头像 PNG（COS 公开资源） */
  avatar: string;
  /** 全卡背景图 PNG（COS 公开资源），翻牌后正面用 */
  bgUrl: string;
  /** reveal 阶段的全屏渐变色 key */
  colorKey: ColorKey;
}

/** 抽中后 reveal 阶段的星点装饰（顶部图层） */
export const REVEAL_STAR_BG =
  "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/05754669-9cd1-4032-8d93-c8318528374c.png";

/**
 * slug → 视觉资源映射表。
 *
 * key 是 SkillHub 公共 API 返回的 `slug`（也是他们前端 souls.ts 里的 `id`）。
 * 16 项与后端 souls 池一一对应；如果将来后端新增 soul 而本表未更新，
 * `getSoulVisuals` 会返回 fallback。
 */
export const SOUL_VISUALS: Record<string, SoulVisual> = {
  YYDS: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/c3cdd954-645d-4c9e-996f-8a8d8672a9ca.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8fe8367a-6121-4aac-a04f-c50f14dda5d1.png",
    colorKey: "orange",
  },
  HHHH: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/2ade6af1-5bc1-4ca4-b7a2-aecd79dc761a.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8e39a82d-c934-40b4-afcc-7a0a061dd994.png",
    colorKey: "blue",
  },
  MIAO: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5d88fc18-328a-4a3e-b625-5af4e3038b4e.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/9c65c633-a434-4956-b7cd-c6ea2ca366ce.png",
    colorKey: "red",
  },
  "OH-NO": {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/42a9a89f-7717-4905-bffd-fdce4a83cad5.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8366d614-f093-4036-809c-39baa8d802c7.png",
    colorKey: "purple",
  },
  WHY: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/306c9126-44fb-4370-8c94-f0f5020abe9d.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/39138036-83a0-48bd-a0b0-42e4004a4eb8.png",
    colorKey: "purple",
  },
  GRASS: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/1f1881ca-8076-4d65-85b3-2716c94bb16f.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/4f9dfbd8-624b-48e8-ab7f-03113ca3cfd9.png",
    colorKey: "orange",
  },
  MONK: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8dd87793-270a-46b9-9576-867c0d48ca71.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/9be7bf66-7217-4004-9c9c-1c7d897ef8b1.png",
    colorKey: "blue",
  },
  MUM: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/20834ac8-008d-439a-b7ab-9712a0415a55.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/658e5af8-dab7-4449-8077-8dfa04072288.png",
    colorKey: "red",
  },
  SOLO: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/45438cc6-2edd-4ef3-92d6-378ce811cc0d.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a82a8b80-ead4-4a5e-92e9-62541ce3ac54.png",
    colorKey: "blue",
  },
  GOOD: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/b2824aaf-1267-40d0-9188-844b122f4494.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/61789429-0f30-4855-8e87-fe1370e7ae8f.png",
    colorKey: "green",
  },
  MALO: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/f9f77646-a9cd-401d-a2ab-ed25d68dd58f.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/33ca9e4c-2b31-4a19-b6d6-29bd601c8e9e.png",
    colorKey: "orange",
  },
  FAKE: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/1f190e38-029d-4d72-bf25-434a189ec7b6.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/82d68aee-c5da-420b-8395-0cdb1a4347aa.png",
    colorKey: "green",
  },
  "LOVE-R": {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/357b580c-3116-4279-9017-643b031074a2.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/bd76ce58-e62b-4fff-9e2c-50f55324299c.png",
    colorKey: "purple",
  },
  ZZZZ: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e56b5b9e-a5c1-44e0-8771-3d1f50a7fa62.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/33d9de76-e154-440b-a114-d8935b50abe1.png",
    colorKey: "green",
  },
  "WORK-er": {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/cf14b2eb-50d6-4a3a-861e-427db90c2615.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/823bd4f1-a0be-4cf3-96cb-77fe154b1d85.png",
    colorKey: "blue",
  },
  GOGO: {
    avatar:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/beec9fcb-e3ae-47dd-8d2d-f255810e8d49.png",
    bgUrl:
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/7dfc8997-21f3-438a-9764-006d89917163.png",
    colorKey: "orange",
  },
};

// ── EN (international) slug aliases ──────────────────────────────────────
// Westernized EN personas reuse the same character art as their canonical
// archetype (by row order). Purely ADDITIVE: CN paths still resolve via the
// original slugs above and are completely unaffected.
Object.assign(SOUL_VISUALS, {
  ["GOAT"]: SOUL_VISUALS["YYDS"],
  ["LOL"]: SOUL_VISUALS["HHHH"],
  ["MEOW"]: SOUL_VISUALS["MIAO"],
  ["NO-FILTER"]: SOUL_VISUALS["GRASS"],
  ["MOMMY"]: SOUL_VISUALS["MUM"],
  ["STEADY"]: SOUL_VISUALS["GOOD"],
  ["LIVEWIRE"]: SOUL_VISUALS["MALO"],
  ["CHAMELEON"]: SOUL_VISUALS["FAKE"],
  ["GRINDER"]: SOUL_VISUALS["WORK-er"],
  ["GO-MODE"]: SOUL_VISUALS["GOGO"],
});

/** Fallback：未知 slug 时返回中性视觉（避免运行时 undefined 崩溃） */
const FALLBACK_VISUAL: SoulVisual = {
  avatar: "",
  bgUrl: "",
  colorKey: "blue",
};

export function getSoulVisuals(soul: Pick<SkillHubSoul, "slug">): SoulVisual {
  return SOUL_VISUALS[soul.slug] ?? FALLBACK_VISUAL;
}

export function getSoulColor(soul: Pick<SkillHubSoul, "slug">): string {
  return SOUL_COLOR_MAP[getSoulVisuals(soul).colorKey];
}

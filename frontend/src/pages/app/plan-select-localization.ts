import type { PlanOption } from "@/domain/types";

export type Translate = (text: string, options?: Record<string, unknown>) => string;

const translatePlanText = (text: string, t: Translate): string => {
  switch (text) {
    case "免费体验":
      return t("免费体验");
    case "先用一个 Bot 跑通创建、测试和配置的完整主链路。":
      return t("先用一个 Bot 跑通创建、测试和配置的完整主链路。");
    case "免费":
      return t("免费");
    case "当前开放 · 确认后直接进入控制台":
      return t("当前开放 · 确认后直接进入控制台");
    case "创建 1 个 Bot":
      return t("创建 1 个 Bot");
    case "实时工作台对话测试":
      return t("实时工作台对话测试");
    case "Settings 核心字段编辑":
      return t("Settings 核心字段编辑");
    case "选择免费体验":
      return t("选择免费体验");
    case "为更高频的个人使用和更长在线时长预留位置。":
      return t("为更高频的个人使用和更长在线时长预留位置。");
    case "Coming Soon":
    case "即将推出":
      return t("即将推出");
    case "更多配额与自动化能力即将开放":
      return t("更多配额与自动化能力即将开放");
    case "更高的对话与运行额度":
      return t("更高的对话与运行额度");
    case "更多 Bot 数量":
      return t("更多 Bot 数量");
    case "更完整的发布与版本能力":
      return t("更完整的发布与版本能力");
    case "为更重度的运行场景和未来高级能力预留位置。":
      return t("为更重度的运行场景和未来高级能力预留位置。");
    case "高并发与更完整的协作能力后续开放":
      return t("高并发与更完整的协作能力后续开放");
    case "更高并发与更长运行时长":
      return t("更高并发与更长运行时长");
    case "高级监控与回滚能力":
      return t("高级监控与回滚能力");
    case "未来团队协作能力预留":
      return t("未来团队协作能力预留");
    default:
      return t(text);
  }
};

/**
 * 翻译仓库返回的套餐字段，同时保留可用性、排序和未来新增字段。
 * 文案 switch 使用静态 t() 参数，确保 i18n extractor 能发现中文 key。
 */
export const localizePlanOption = (plan: PlanOption, t: Translate): PlanOption => ({
  ...plan,
  name: translatePlanText(plan.name, t),
  description: translatePlanText(plan.description, t),
  priceLabel: translatePlanText(plan.priceLabel, t),
  priceNote: translatePlanText(plan.priceNote, t),
  features: plan.features.map((feature) => translatePlanText(feature, t)),
  ctaLabel: translatePlanText(plan.ctaLabel, t),
});

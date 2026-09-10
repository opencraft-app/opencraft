// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { PlanOption } from "./types";

export const planCatalog: PlanOption[] = [
  {
    tier: "free",
    name: "免费体验",
    description: "先用一个 Bot 跑通创建、测试和配置的完整主链路。",
    priceLabel: "免费",
    priceNote: "当前开放 · 确认后直接进入控制台",
    features: [
      "创建 1 个 Bot",
      "实时工作台对话测试",
      "Settings 核心字段编辑",
    ],
    available: true,
    featured: true,
    ctaLabel: "选择免费体验",
  },
  {
    tier: "plus",
    name: "Plus",
    description: "为更高频的个人使用和更长在线时长预留位置。",
    priceLabel: "Coming Soon",
    priceNote: "更多配额与自动化能力即将开放",
    features: [
      "更高的对话与运行额度",
      "更多 Bot 数量",
      "更完整的发布与版本能力",
    ],
    available: false,
    ctaLabel: "Coming Soon",
  },
  {
    tier: "max",
    name: "Max",
    description: "为更重度的运行场景和未来高级能力预留位置。",
    priceLabel: "Coming Soon",
    priceNote: "高并发与更完整的协作能力后续开放",
    features: [
      "更高并发与更长运行时长",
      "高级监控与回滚能力",
      "未来团队协作能力预留",
    ],
    available: false,
    ctaLabel: "Coming Soon",
  },
];

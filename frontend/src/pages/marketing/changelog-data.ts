/**
 * 更新日志数据（changelog 页与 Agent 总览「产品动态」共用）。
 *
 * 国内站与国际站的条目由 isGlobal 编译期分支分别维护；每条文案直接以
 * 字面量调用 t()，以便被 i18n-extract 扫描。
 */

import type { TranslateFn } from "@/i18n/t";
import { isGlobal } from "@/lib/region";
import { getChangelogUpgradeCopy } from "@/pages/marketing/changelog-upgrade-copy";

export type ChangelogEntry = {
  id: string;
  title: string;
  desc?: string;
  badge?: string;
  /** 卡片视觉样式：lobster=上线图 / multiBot=创建多个 Bot 图 / planUpgrade=套餐升配页图 / cloudStorage=云存储图 / instanceStorage=实例存储图 / skillPackages=技能包图 / skillsRevamp=技能页面图 / skillPackagesRevamp=技能包页面图 / diagnosticsCenter=诊断中心图 / achievements=成就图 / wecom=企业微信通道图 / dingtalk=钉钉通道图 / personaUpload=上传人设文件图 / schedule=定时任务图 / zeroTokenScheduledTasks=0 Token 定时任务图 / automationSkill=定时任务调用技能图 / automationUpstream=定时任务上游任务图 / chat=网页对话图 / memory=记忆页图 / skillsBulkInstall=技能批量安装图 / automationTemplates=定时任务模板图 / qqGroupMentions=QQ 群聊 @ 机器人图 / traditionalChinese=繁体中文图 / deepseekHarness=DeepSeek Harness 图 / workbench=工作台图 / none=无图 */
  visual: "lobster" | "multiBot" | "planUpgrade" | "cloudStorage" | "instanceStorage" | "skillPackages" | "skillsRevamp" | "skillPackagesRevamp" | "diagnosticsCenter" | "advancedSettings" | "deepseekHarness" | "achievements" | "wecom" | "dingtalk" | "personaUpload" | "soul" | "schedule" | "zeroTokenScheduledTasks" | "automationSkill" | "automationUpstream" | "chat" | "memory" | "skillsBulkInstall" | "automationTemplates" | "qqGroupMentions" | "traditionalChinese" | "skill-package" | "workbench" | "none";
};

export type ChangelogMonthGroup = {
  id: string;
  month: string;
  entries: ChangelogEntry[];
};

export function buildChangelogGroups(t: TranslateFn, locale: string): ChangelogMonthGroup[] {
  const upgradeCopy = getChangelogUpgradeCopy(locale, isGlobal);
  /* 数据驱动；每条文案直接通过翻译函数调用字面量，以便被 i18n-extract 扫描。
     国内站与国际站的渠道事实不同，使用 isGlobal 编译期分支分别维护。 */
  const launchDesc = isGlobal
    ? t("支持一键创建云端 Hermes Agent，支持快速接入 Telegram、WhatsApp、Discord、Slack 等通道，支持主流模型 API 接入，支持一键安装 Skill 技能。")
    : t("支持一键创建云端 Hermes Agent，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。");
  const skillsPageDesc = isGlobal
    ? t("支持从 ClawHub 和 skills.sh 搜索并一键安装技能；在精选技能页面浏览热门推荐和场景分类、查看技能详情。")
    : t("支持从 SkillHub 搜索并一键安装技能；在精选技能页面浏览热门推荐和场景分类、查看技能详情。");
  const instanceStorageEntry: ChangelogEntry = {
    id: "instance-storage",
    title: t("LightVela 支持查看 Agent 实例存储空间"),
    desc: t("云存储页面现在会显示 Agent 实例的总容量、已用容量和可用容量，并将 Agent 运行环境、系统预留空间和云存储文件计入使用量计算。"),
    visual: "instanceStorage",
  };
  const zeroTokenScheduledTasksEntry: ChangelogEntry = {
    id: "zero-token-scheduled-tasks",
    title: t("定时任务新增通知任务和脚本任务"),
    desc: t("支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。"),
    visual: "zeroTokenScheduledTasks",
  };
  const multiBotEntry: ChangelogEntry = {
    id: "multi-bot-creation",
    title: t("LightVela 支持创建多个 Bot"),
    desc: t("在同一个 Agent 中创建多个 Bot，让它们各司其职；每个 Bot 的记忆、技能、定时任务、模型和通道配置相互隔离。"),
    visual: "multiBot",
  };

  const upgradeEntry: ChangelogEntry = {
    id: "subscription-upgrade",
    title: upgradeCopy.title,
    desc: upgradeCopy.desc,
    visual: "planUpgrade",
  };
  const channelTestEntry: ChangelogEntry = {
    id: "channel-test-message",
    title: t("聊天通道支持发送测试消息"),
    desc: t("已连接的聊天通道可发送一条测试消息，在对应聊天软件中确认是否收到，快速验证消息是否送达。"),
    visual: "none",
  };

  return [
    {
      id: "2026-10",
      month: t("2026 年 10 月"),
      entries: [
        {
          id: "multi-bot-web-chat",
          title: t("LightVela 支持与多个 Bot 网页对话"),
          desc: t("现在可以在 LightVela 网页中直接与主 Bot 之外的其他 Bot 对话，无需切换到外部聊天通道。"),
          visual: "none",
        },
      ],
    },
    ...(isGlobal
      ? [
          {
            id: "2026-09",
            month: upgradeCopy.month,
            entries: [
              channelTestEntry,
              upgradeEntry,
              multiBotEntry,
              zeroTokenScheduledTasksEntry,
              instanceStorageEntry,
              {
                id: "workbench",
                title: t("LightVela 支持创建和发布工作台"),
                desc: t("支持在 LightVela 中选择模板或从零开始创建个人工作台，并以静态网站的形式直接发布、预览、更新和管理自己的工作台。"),
                badge: "Beta",
                visual: "workbench" as const,
              },
            ],
          },
          {
            id: "2026-08",
            month: t("2026 年 8 月"),
            entries: [
              {
                id: "deepseek-harness",
                title: t("LightVela 实验室新增 DeepSeek Harness"),
                desc: t("在 Hermes Agent 之外安装和管理 DeepSeek Harness，使用专属 WebUI、模型提供商配置、插件管理、工作区和独立服务控制。"),
                badge: "Beta",
                visual: "deepseekHarness" as const,
              },
              {
                id: "automation-form-test-run",
                title: t("定时任务支持测试运行"),
                desc: t("创建或编辑定时任务时，可以先运行一次当前任务内容，无需保存即可确认执行效果，再决定是否创建或更新任务。"),
                visual: "none" as const,
              },
              {
                id: "advanced-settings",
                title: t("LightVela 新增 Hermes Agent 高级设置"),
                desc: t("自定义 Hermes Agent 管理长期记忆、用户画像和长对话上下文的方式，并灵活调整压缩设置。"),
                visual: "advancedSettings" as const,
              },
              {
                id: "persona-file-upload",
                title: t("LightVela 支持上传自定义人设文件"),
                desc: t("上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。"),
                visual: "personaUpload" as const,
              },
              {
                id: "automation-upstream-task",
                title: t("定时任务支持关联上游任务"),
                desc: t("创建或编辑定时任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。"),
                visual: "automationUpstream" as const,
              },
              {
                id: "skills-install-and-sources",
                title: t("技能页面支持批量安装与来源查看"),
                desc: t("安装多个 Skill 时可以查看实时进度，并从技能页面直接打开 ClawHub 或 skills.sh 的原始来源页面。"),
                visual: "skillsBulkInstall" as const,
              },
              {
                id: "qq-group-mentions",
                title: t("支持在 QQ 群聊中 @ 机器人"),
                desc: t("将 Hermes Agent 添加到 QQ 群后，@ 机器人即可开始对话。"),
                visual: "qqGroupMentions" as const,
              },
              {
                id: "traditional-chinese",
                title: t("支持繁体中文"),
                desc: t("现在可以使用繁体中文浏览 LightVela 的公开页面、产品文档和账号流程。"),
                visual: "traditionalChinese" as const,
              },
              {
                id: "indonesian-language",
                title: t("LightVela 支持印度尼西亚语"),
                desc: t("现在可以使用印度尼西亚语浏览 LightVela 的公开页面、产品文档和账号流程。"),
                visual: "none" as const,
              },
              {
                id: "global-official-launch",
                title: t("LightVela 正式上线并启用付费服务"),
                desc: t("LightVela 国际站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。"),
                visual: "none" as const,
              },
            ],
          },
        ]
      : [
          {
            id: "2026-09",
            month: upgradeCopy.month,
            entries: [
              channelTestEntry,
              upgradeEntry,
              multiBotEntry,
              zeroTokenScheduledTasksEntry,
              instanceStorageEntry,
              {
                id: "workbench",
                title: t("LightVela 支持创建和发布工作台"),
                desc: t("支持在 LightVela 中选择模板或从零开始创建个人工作台，并以静态网站的形式直接发布、预览、更新和管理自己的工作台。"),
                badge: "Beta",
                visual: "workbench" as const,
              },
            ],
          },
          {
            id: "2026-08",
            month: t("2026 年 8 月"),
            entries: [
              {
                id: "deepseek-harness",
                title: t("LightVela 实验室新增 DeepSeek Harness"),
                desc: t("在 Hermes Agent 之外安装和管理 DeepSeek Harness，使用专属 WebUI、模型提供商配置、插件管理、工作区和独立服务控制。"),
                badge: "Beta",
                visual: "deepseekHarness" as const,
              },
              {
                id: "automation-form-test-run",
                title: t("定时任务支持测试运行"),
                desc: t("创建或编辑定时任务时，可以先运行一次当前任务内容，无需保存即可确认执行效果，再决定是否创建或更新任务。"),
                visual: "none" as const,
              },
              {
                id: "advanced-settings",
                title: t("LightVela 新增 Hermes Agent 高级设置"),
                desc: t("自定义 Hermes Agent 管理长期记忆、用户画像和长对话上下文的方式，并灵活调整压缩设置。"),
                visual: "advancedSettings" as const,
              },
              {
                id: "persona-file-upload",
                title: t("LightVela 支持上传自定义人设文件"),
                desc: t("上传 Markdown 人设文件后，可继续编辑或直接注入 Agent；已注入的人设文件也支持随时编辑和下载。"),
                visual: "personaUpload" as const,
              },
              {
                id: "automation-upstream-task",
                title: t("定时任务支持关联上游任务"),
                desc: t("创建或编辑定时任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。"),
                visual: "automationUpstream" as const,
              },
              {
                id: "dingtalk-channel",
                title: t("LightVela 支持钉钉通道"),
                desc: t("现在可以将 Hermes Agent 接入钉钉，在钉钉会话中直接与云端智能伙伴对话。"),
                visual: "dingtalk" as const,
              },
              {
                id: "qq-group-mentions",
                title: t("支持在 QQ 群聊中 @ 机器人"),
                desc: t("将 Hermes Agent 添加到 QQ 群后，@ 机器人即可开始对话。"),
                visual: "qqGroupMentions" as const,
              },
            ],
          },
        ]),
    {
      id: "2026-07",
      month: t("2026 年 7 月"),
      entries: [
        {
          id: "skills-page-revamp",
          title: t("技能页面全新升级"),
          desc: skillsPageDesc,
          visual: "skillsRevamp",
        },
        ...(isGlobal
          ? [
              {
                id: "skill-packages-global",
                title: t("LightVela 支持技能包"),
                desc: t("快速安装技能组合，让 Agent 从单点技能走向完整工作流。"),
                visual: "skillPackagesRevamp" as const,
              },
              {
                id: "automation-templates",
                title: t("定时任务模板"),
                desc: t("选择一个现成的定时任务模板，先运行一次，确认效果后再将其转为持续执行的定时任务。"),
                visual: "automationTemplates" as const,
              },
            ]
          : []),
        {
          id: "automation-skill-invocation",
          title: t("定时任务支持调用技能"),
          desc: t("创建或编辑定时任务时，可以选择需要调用的技能。Agent 会在执行任务前加载该技能，帮助定时任务更稳定地调用技能。"),
          visual: "automationSkill",
        },
        ...(!isGlobal
          ? [
              {
                id: "skill-package",
                title: t("LightVela 支持技能包"),
                desc: t("快速安装技能组合，让 Agent 从单点技能走向完整工作流。"),
                visual: "skill-package" as const,
              },
              {
                id: "domestic-official-launch",
                title: t("LightVela 正式上线并启用付费服务"),
                desc: t("LightVela 产品中国站正式上线，同步启用付费服务。你可以根据使用需求选择合适的订阅套餐。"),
                visual: "none" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "2026-06",
      month: t("2026 年 6 月"),
      entries: [
        {
          id: "diagnostics-center",
          title: t("诊断中心上线，让 Agent 排查更简单"),
          desc: t("集中查看 Hermes Agent 最近日志，并执行模型配置重置、Agent 重装等维护操作，帮助快速定位和解决问题。"),
          visual: "diagnosticsCenter",
        },
        {
          id: "cloud-storage",
          title: t("LightVela 支持云存储管理"),
          desc: t("现在可以在 LightVela 中查看和管理 Hermes Agent 的云存储文件，上传、下载、整理工作资料更方便。"),
          visual: "cloudStorage",
        },
        {
          id: "achievements",
          title: t("LightVela 支持成就模块"),
          desc: t("不断深入使用 Hermes Agent，将会解锁更多新鲜成就，记录你的探索进度。"),
          visual: "achievements",
        },
        ...(!isGlobal
          ? [
              {
                id: "wecom",
                title: t("LightVela 支持企业微信通道"),
                desc: t("现在可以将 Hermes Agent 接入企业微信，在企业微信会话中直接与云端智能伙伴对话。"),
                visual: "wecom" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "2026-05",
      month: t("2026 年 5 月"),
      entries: [
        {
          id: "soul",
          title: t("Soul 人设能力上线"),
          desc: t("为 Hermes Agent 抽取并保存专属 Soul 人设，一键注入后通过 /new 开启带有新人设的新对话。"),
          visual: "soul",
        },
        {
          id: "web-chat",
          title: t("LightVela 支持网页内对话"),
          desc: t("无需切换到外部通道，现在可以在 LightVela 网页内直接与 Hermes Agent 对话。"),
          visual: "chat",
        },
        {
          id: "memory",
          title: t("LightVela 支持查看 Hermes Agent 记忆"),
          desc: t("在控制台查看 Hermes Agent 的记忆、用户画像和字符占用，帮助你了解 Agent 当前掌握的上下文。"),
          visual: "memory",
        },
        {
          id: "scheduled-tasks",
          title: t("LightVela 支持设置定时任务"),
          desc: t("为 Agent 设置周期、间隔或单次定时任务，让它按计划执行提醒、总结、通知等日常工作。"),
          visual: "schedule",
        },
      ],
    },
    {
      id: "2026-04",
      month: t("2026 年 4 月"),
      entries: [
        {
          id: "beta-launch",
          title: t("LightVela 产品公测上线"),
          desc: launchDesc,
          visual: "lobster",
        },
      ],
    },
  ];
}

/** 按时间倒序取最近 limit 条，附带所属月份（已本地化的月份文案） */
export function getRecentChangelogEntries(t: TranslateFn, locale: string, limit: number) {
  return buildChangelogGroups(t, locale)
    .flatMap((group) => group.entries.map((entry) => ({ ...entry, month: group.month })))
    .slice(0, limit);
}

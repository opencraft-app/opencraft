/**
 * 更新日志页面
 * 还原 Figma 设计：https://www.figma.com/design/UlSg2y8cH1vc3n86WTrWhG/lightclaw独立站?node-id=231-4224
 * 布局：左侧日期（140px） + 右侧（标题 24px + 描述 + 配图卡片）
 */

import { motion } from "framer-motion";
import { CalendarCheck } from "lucide-react";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LegalFooter } from "@/components/site/legal-footer";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { isGlobal } from "@/lib/region";

/* ═══════════════════════════════════════════════════════════════
   Animation Variants
   ═══════════════════════════════════════════════════════════════ */

const fadeInUp = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.12, delayChildren: 0.1 },
  },
};

const viewportConfig = { once: true, margin: "-40px" as const };

/* ═══════════════════════════════════════════════════════════════
   更新记录数据
   ═══════════════════════════════════════════════════════════════ */

type ChangelogEntry = {
  id: string;
  title: string;
  desc?: string;
  /** 卡片视觉样式：lobster=上线图 / cloudStorage=云存储图 / skillPackages=技能包图 / skillsRevamp=技能页面图 / skillPackagesRevamp=技能包页面图 / diagnosticsCenter=诊断中心图 / achievements=成就图 / wecom=企业微信通道图 / dingtalk=钉钉通道图 / personaUpload=上传人设文件图 / schedule=自动任务图 / automationSkill=自动任务调用技能图 / automationUpstream=自动任务上游任务图 / chat=网页对话图 / memory=记忆页图 / skillsBulkInstall=技能批量安装图 / automationTemplates=自动任务模板图 / qqGroupMentions=QQ 群聊 @ 机器人图 / traditionalChinese=繁体中文图 / none=无图 */
  visual: "lobster" | "cloudStorage" | "skillPackages" | "skillsRevamp" | "skillPackagesRevamp" | "diagnosticsCenter" | "advancedSettings" | "achievements" | "wecom" | "dingtalk" | "personaUpload" | "soul" | "schedule" | "automationSkill" | "automationUpstream" | "chat" | "memory" | "skillsBulkInstall" | "automationTemplates" | "qqGroupMentions" | "traditionalChinese" | "skill-package" | "none";
};

type ChangelogMonthGroup = {
  id: string;
  month: string;
  entries: ChangelogEntry[];
};

/* ═══════════════════════════════════════════════════════════════
   配图卡片 — 还原 Figma 设计稿中的插图卡片
   ═══════════════════════════════════════════════════════════════ */

export function VisualCard({ variant }: { variant: "lobster" | "cloudStorage" | "skillPackages" | "skillsRevamp" | "skillPackagesRevamp" | "diagnosticsCenter" | "advancedSettings" | "achievements" | "wecom" | "dingtalk" | "personaUpload" | "soul" | "schedule" | "automationSkill" | "automationUpstream" | "chat" | "memory" | "skillsBulkInstall" | "automationTemplates" | "qqGroupMentions" | "traditionalChinese" | "skill-package" }) {
  const t = useT();
  const { i18n } = useTranslation();
  const useGlobalAssets = isGlobal || !i18n.language.startsWith("zh");
  const useGlobalChineseAsset = i18n.language.startsWith("zh");
  /* 国际站中英文 changelog 均使用国际版截图；国内站继续使用中文截图。 */
  const imgPath =
    variant === "cloudStorage"
      ? useGlobalAssets
        ? "/assets/changelog/lightvela-cloud-storage-en.png"
        : "/assets/changelog/lightvela-cloud-storage.webp"
      : variant === "skillPackages"
      ? "/assets/changelog/skill-packages.png"
      : variant === "achievements"
      ? useGlobalAssets
        ? "/assets/changelog/lightvela-achievements-en.png"
        : "/assets/changelog/lightvela-achievements.webp"
      : variant === "skillsRevamp"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-skills-page-global-zh.webp"
          : "/assets/changelog/lightvela-skills-page-global-en.webp"
        : "/assets/changelog/lightvela-skills-page-domestic-zh.webp"
      : variant === "skillPackagesRevamp"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-skill-packages-global-zh.webp"
          : "/assets/changelog/lightvela-skill-packages-global-en.webp"
        : "/assets/changelog/lightvela-skill-package-cn.webp"
      : variant === "skillsBulkInstall"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-skills-bulk-install-global-zh.png"
        : "/assets/changelog/lightvela-skills-bulk-install-global-en.png"
      : variant === "automationUpstream"
      ? isGlobal && useGlobalChineseAsset
        ? "/assets/changelog/lightvela-automation-upstream-task-global-zh.png"
        : "/assets/changelog/lightvela-automation-upstream-task.png"
      : variant === "automationTemplates"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-automation-templates-global-zh.png"
        : "/assets/changelog/lightvela-automation-templates-global-en.png"
      : variant === "qqGroupMentions"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-qq-group-mentions-global-zh.png"
        : "/assets/changelog/lightvela-qq-group-mentions-global-en.png"
      : variant === "traditionalChinese"
      ? "/assets/changelog/lightvela-traditional-chinese-global-all.png"
      : variant === "diagnosticsCenter"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-diagnostics-global-zh.webp"
          : "/assets/changelog/lightvela-diagnostics-global-en.webp"
        : "/assets/changelog/lightvela-diagnostics-domestic-zh.webp"
      : variant === "advancedSettings"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-advanced-settings-cn.png"
          : "/assets/changelog/lightvela-advanced-settings-en.png"
        : "/assets/changelog/lightvela-advanced-settings-cn.png"
      : variant === "wecom"
      ? "/assets/changelog/lightvela-wecom-channel.webp"
      : variant === "dingtalk"
      ? "/assets/changelog/lightvela-dingtalk-channel.png"
      : variant === "personaUpload"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-persona-upload-global-zh.png"
          : "/assets/changelog/lightvela-persona-upload-global-en.png"
        : "/assets/changelog/lightvela-persona-upload.png"
      : variant === "chat"
      ? useGlobalAssets
        ? "/assets/changelog/agentchat-web-chat-en.png"
        : "/assets/changelog/agentchat-web-chat.webp"
      : variant === "memory"
      ? useGlobalAssets
        ? "/assets/changelog/hermes-memory-en.png"
        : "/assets/changelog/hermes-memory.webp"
      : variant === "schedule"
      ? useGlobalAssets
        ? "/assets/changelog/scheduled-tasks-en.png"
        : "/assets/changelog/scheduled-tasks.webp"
      : variant === "automationSkill"
      ? useGlobalAssets
        ? "/assets/changelog/automation-skill-invocation-en.png"
        : "/assets/changelog/automation-skill-invocation.png"
      : variant === "skill-package"
      ? "/assets/changelog/lightvela-skill-package-cn.webp"
      : variant === "soul"
        ? isGlobal
          ? useGlobalChineseAsset
            ? "/assets/changelog/soul-persona-global-zh.webp"
            : "/assets/changelog/soul-persona-global-en.webp"
          : "/assets/changelog/soul-persona-domestic-zh.webp"
      : isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-launch-global-zh.webp"
          : "/assets/changelog/lightvela-launch-global-en.webp"
        : "/assets/changelog/lightvela-launch.webp";
  const altText =
    variant === "cloudStorage"
      ? t("LightVela 支持云存储管理")
      : variant === "skillPackages"
      ? t("新增技能包功能")
      : variant === "skillsRevamp"
      ? t("技能页面全新升级")
      : variant === "skillPackagesRevamp"
      ? t("LightVela 支持技能包")
      : variant === "skillsBulkInstall"
      ? t("技能页面支持批量安装与来源查看")
      : variant === "automationUpstream"
      ? t("自动任务支持关联上游任务")
      : variant === "automationTemplates"
      ? t("自动任务模板")
      : variant === "qqGroupMentions"
      ? t("支持在 QQ 群聊中 @ 机器人")
      : variant === "traditionalChinese"
      ? t("支持繁体中文")
      : variant === "diagnosticsCenter"
      ? t("诊断中心上线，让 Agent 排查更简单")
      : variant === "advancedSettings"
      ? t("LightVela 新增 Hermes Agent 高级设置")
      : variant === "achievements"
      ? t("LightVela 支持成就模块")
      : variant === "wecom"
      ? t("LightVela 支持企业微信通道")
      : variant === "dingtalk"
      ? t("LightVela 支持钉钉通道")
      : variant === "personaUpload"
      ? t("LightVela 支持上传自定义人设文件")
      : variant === "chat"
      ? t("LightVela 支持网页内对话")
      : variant === "memory"
      ? t("LightVela 支持查看 Hermes Agent 记忆")
      : variant === "schedule"
      ? t("LightVela 支持设置自动任务")
      : variant === "automationSkill"
      ? t("自动任务调用技能设置")
      : variant === "skill-package"
      ? t("LightVela 支持技能包")
      : variant === "soul"
        ? t("Soul 人设能力上线")
        : t("LightVela 产品内测上线");
  const aspectRatio =
    variant === "cloudStorage"
      ? useGlobalAssets ? "1280 / 935" : "2140 / 1532"
      : variant === "skillPackages"
      ? "2328 / 1370"
      : variant === "achievements"
      ? useGlobalAssets ? "1275 / 663" : "2140 / 1198"
      : variant === "skillsRevamp"
      ? isGlobal
        ? useGlobalChineseAsset ? "1279 / 867" : "1285 / 863"
        : "1161 / 785"
      : variant === "skillPackagesRevamp"
      ? isGlobal
        ? useGlobalChineseAsset ? "1279 / 635" : "1275 / 666"
        : "1166 / 680"
      : variant === "skillsBulkInstall"
      ? useGlobalChineseAsset ? "1284 / 806" : "1270 / 805"
      : variant === "automationUpstream"
      ? isGlobal && useGlobalChineseAsset ? "718 / 234" : "816 / 356"
      : variant === "automationTemplates"
      ? useGlobalChineseAsset ? "1629 / 1090" : "1657 / 1117"
      : variant === "qqGroupMentions"
      ? useGlobalChineseAsset ? "1864 / 844" : "1863 / 844"
      : variant === "traditionalChinese"
      ? "2202 / 1286"
      : variant === "diagnosticsCenter"
      ? isGlobal
        ? useGlobalChineseAsset ? "1281 / 615" : "1283 / 638"
        : "1454 / 1045"
      : variant === "advancedSettings"
      ? isGlobal
        ? useGlobalChineseAsset ? "1165 / 930" : "1403 / 1121"
        : "1165 / 930"
      : variant === "wecom"
      ? "2160 / 844"
      : variant === "dingtalk"
      ? "816 / 356"
      : variant === "personaUpload"
      ? isGlobal
        ? useGlobalChineseAsset ? "1282 / 644" : "1410 / 642"
        : "1410 / 642"
      : variant === "chat"
      ? useGlobalAssets ? "1677 / 938" : "1742 / 903"
      : variant === "memory"
      ? useGlobalAssets ? "1637 / 961" : "2326 / 1322"
      : variant === "schedule"
        ? useGlobalAssets ? "1784 / 882" : "1952 / 806"
      : variant === "automationSkill"
        ? "820 / 282"
        : variant === "skill-package"
        ? "1166 / 680"
        : variant === "soul"
          ? isGlobal ? "1279 / 808" : "1451 / 917"
          : "710 / 360";
  /* LightVela 正式上线卡片 — 直接使用设计稿/截图资产 */
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{
        width: "100%",
        maxWidth: "710px",
        aspectRatio,
        backgroundColor: variant === "skillPackages" ? "#FFFFFF" : "#FFF5EE",
        border: variant === "skillPackages" ? "1px solid rgba(0,0,0,0.08)" : "none",
        boxShadow: variant === "skillPackages" ? "0 8px 24px rgba(0,0,0,0.06)" : "none",
      }}
    >
      <img
        src={assetUrl(imgPath)}
        alt={altText}
        className={`absolute inset-0 h-full w-full rounded-[inherit] ${variant === "lobster" ? "object-cover" : "object-contain"}`}
        loading="lazy"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Changelog Content
   ═══════════════════════════════════════════════════════════════ */

function ChangelogContent() {
  const t = useT();
  /* 数据驱动；每条文案直接通过翻译函数调用字面量，以便被 i18n-extract 扫描。
     国内站与国际站的渠道事实不同，使用 isGlobal 编译期分支分别维护。 */
  const launchDesc = isGlobal
    ? t("支持一键创建云端 Hermes Agent，支持快速接入 Telegram、WhatsApp、Discord、Slack 等通道，支持主流模型 API 接入，支持一键安装 Skill 技能。")
    : t("支持一键创建云端 Hermes Agent，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。");
  const skillsPageDesc = isGlobal
    ? t("支持从 ClawHub 和 skills.sh 搜索并一键安装技能；在精选技能页面浏览热门推荐和场景分类、查看技能详情。")
    : t("支持从 SkillHub 搜索并一键安装技能；在精选技能页面浏览热门推荐和场景分类、查看技能详情。");

  const changelogGroups: ChangelogMonthGroup[] = [
    ...(isGlobal
      ? [
          {
            id: "2026-08",
            month: t("2026 年 8 月"),
            entries: [
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
                title: t("自动任务支持关联上游任务"),
                desc: t("创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。"),
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
            ],
          },
        ]
      : [
          {
            id: "2026-08",
            month: t("2026 年 8 月"),
            entries: [
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
                title: t("自动任务支持关联上游任务"),
                desc: t("创建或编辑自动任务时，可以关联一个上游任务。后续该任务执行时，会使用上游任务最近一次的输出作为上下文。"),
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
                title: t("自动任务模板"),
                desc: t("选择一个现成的自动任务模板，先运行一次，确认效果后再将其转为持续执行的自动任务。"),
                visual: "automationTemplates" as const,
              },
            ]
          : []),
        {
          id: "automation-skill-invocation",
          title: t("自动任务支持调用技能"),
          desc: t("创建或编辑自动任务时，可以选择需要调用的技能。Agent 会在执行任务前加载该技能，帮助自动任务更稳定地调用技能。"),
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
          desc: t("为 Hermes Agent 抽取并保存专属 Soul 人设，一键注入后通过 /new 开启带有新人设的新会话。"),
          visual: "soul",
        },
        {
          id: "web-chat",
          title: t("LightVela 支持网页内对话"),
          desc: t("无需切换到外部通道，现在可以在 LightVela 网页内基于 AgentChat 直接与 Hermes Agent 对话。"),
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
          title: t("LightVela 支持设置自动任务"),
          desc: t("为 Agent 设置周期、间隔或单次自动任务，让它按计划执行提醒、总结、通知等日常工作。"),
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
          title: t("LightVela 产品内测上线"),
          desc: launchDesc,
          visual: "lobster",
        },
      ],
    },
  ];

  return (
    <section
      style={{ backgroundColor: "var(--lw-bg)", paddingTop: "8rem", paddingBottom: "6rem" }}
    >
      <div
        className="mx-auto px-6 md:px-8"
        style={{ maxWidth: "1200px" }}
      >
        {/* 页面标题区 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="mb-16"
        >
          <motion.h1
            variants={fadeInUp}
            style={{
              fontSize: "clamp(2.5rem, 5vw, 3rem)",
              fontWeight: 600,
              color: "var(--lw-fg)",
              letterSpacing: "-0.02em",
            lineHeight: 1.33,
            }}
          >
            {t("更新日志")}
          </motion.h1>
          <motion.p
            variants={fadeInUp}
            className="mt-4 text-base"
            style={{
              color: "rgba(0,0,0,0.5)",
              lineHeight: 1.5,
              maxWidth: "none",
              whiteSpace: "nowrap",
            }}
          >
            {t("记录每一次产品迭代与功能上线，让你清晰了解 LightVela 的持续进化。")}
          </motion.p>
        </motion.div>

        {/* 更新条目列表 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="space-y-20"
        >
          {changelogGroups.map((group) => {
            const showTimeline = group.entries.length > 1;

            return (
              <motion.section
                key={group.id}
                variants={fadeInUp}
                className="grid grid-cols-1 gap-6 md:grid-cols-[140px_1fr] md:gap-16"
              >
                {/* 左列：月份 */}
                <div className="pt-1">
                  <p
                    className="inline-flex h-12 items-center gap-4"
                    style={{
                      color: "#6E47FF",
                      fontSize: "16px",
                      fontWeight: 400,
                      lineHeight: 1.5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <CalendarCheck className="size-5 shrink-0" aria-hidden="true" />
                    <span>{group.month}</span>
                  </p>
                </div>

                {/* 右列：月内条目 */}
                <div>
                  {group.entries.map((entry, index) => (
                    <article
                      key={entry.id}
                      className={showTimeline ? "grid grid-cols-[28px_1fr] gap-4 pb-16 last:pb-0" : ""}
                    >
                      {showTimeline && (
                        <div className="relative flex justify-center pt-2">
                          {index < group.entries.length - 1 && (
                            <span
                              className="absolute left-1/2 top-5 bottom-[-4rem] w-px -translate-x-1/2"
                              style={{ backgroundColor: "rgba(0,0,0,0.12)" }}
                            />
                          )}
                          <span
                            className="relative z-10 mt-1 h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: "var(--lw-fg)", boxShadow: "0 0 0 6px var(--lw-bg)" }}
                          />
                        </div>
                      )}

                      <div>
                        <h2
                          style={{
                            fontSize: "24px",
                            fontWeight: 500,
                            color: "var(--lw-fg)",
                            lineHeight: 1.5,
                            letterSpacing: "-0.01em",
                            marginBottom: entry.desc ? "20px" : "24px",
                          }}
                        >
                          {entry.title}
                        </h2>

                        {entry.desc && (
                          <p
                            style={{
                              fontSize: "16px",
                              fontWeight: 400,
                              color: "rgba(0,0,0,0.9)",
                              lineHeight: 1.75,
                              marginBottom: "24px",
                            }}
                          >
                            {entry.desc}
                          </p>
                        )}

                        {entry.visual !== "none" && (
                          <VisualCard variant={entry.visual} />
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </motion.section>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Changelog Page
   ═══════════════════════════════════════════════════════════════ */

type ChangelogPageProps = {
  authControls?: ReactNode;
  currentPath?: string;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};

export const ChangelogPage = ({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: ChangelogPageProps = {}) => {
  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
    >
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        currentSection="changelog"
        locale={publicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />
      <main className="z-10 flex-grow pt-[60px]">
        <ChangelogContent />
      </main>
      <LegalFooter />
    </div>
  );
};

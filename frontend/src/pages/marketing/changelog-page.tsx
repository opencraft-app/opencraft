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
import { useLocaleOverride, useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { isGlobal } from "@/lib/region";
import { buildChangelogGroups } from "@/pages/marketing/changelog-data";
import { getChangelogUpgradeCopy } from "@/pages/marketing/changelog-upgrade-copy";

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
   更新记录数据 → changelog-data.ts（与 Agent 总览「产品动态」共用）
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   配图卡片 — 还原 Figma 设计稿中的插图卡片
   ═══════════════════════════════════════════════════════════════ */

const zeroTokenScheduledTasksGlobalAssets: Record<string, string> = {
  "zh-CN": "/assets/changelog/scheduled-tasks-notification-global-zh-CN.webp",
  "zh-Hant": "/assets/changelog/scheduled-tasks-notification-zh-Hant.webp",
  "en-US": "/assets/changelog/scheduled-tasks-notification-en-US.webp",
  "id-ID": "/assets/changelog/scheduled-tasks-notification-id-ID.webp",
  es: "/assets/changelog/scheduled-tasks-notification-es.webp",
  "ja-JP": "/assets/changelog/scheduled-tasks-notification-ja-JP.webp",
  "ko-KR": "/assets/changelog/scheduled-tasks-notification-ko-KR.webp",
  "ms-MY": "/assets/changelog/scheduled-tasks-notification-en-US.webp",
  "th-TH": "/assets/changelog/scheduled-tasks-notification-en-US.webp",
};

export function VisualCard({ variant }: { variant: "lobster" | "multiBot" | "planUpgrade" | "cloudStorage" | "instanceStorage" | "skillPackages" | "skillsRevamp" | "skillPackagesRevamp" | "diagnosticsCenter" | "advancedSettings" | "deepseekHarness" | "achievements" | "wecom" | "dingtalk" | "personaUpload" | "soul" | "schedule" | "zeroTokenScheduledTasks" | "automationSkill" | "automationUpstream" | "chat" | "memory" | "skillsBulkInstall" | "automationTemplates" | "qqGroupMentions" | "traditionalChinese" | "malayLanguage" | "skill-package" | "workbench" }) {
  const t = useT();
  const { i18n } = useTranslation();
  const locale = useLocaleOverride() ?? i18n.language;
  const useGlobalAssets = isGlobal || !i18n.language.startsWith("zh");
  const useGlobalChineseAsset = i18n.language.startsWith("zh");
  const zeroTokenScheduledTasksAsset = isGlobal
    ? zeroTokenScheduledTasksGlobalAssets[i18n.language] ?? "/assets/changelog/scheduled-tasks-notification-en-US.webp"
    : "/assets/changelog/scheduled-tasks-notification-zh-CN.webp";
  /* 国际站中英文 changelog 均使用国际版截图；国内站继续使用中文截图。 */
  const imgPath =
    variant === "planUpgrade"
      ? isGlobal
        ? "/assets/changelog/lightvela-plan-upgrade-global-en.png"
        : "/assets/changelog/lightvela-plan-upgrade-cn.png"
      : variant === "multiBot"
      ? isGlobal && !useGlobalChineseAsset
        ? "/docs-images/bots-switching-create-en.webp"
        : "/docs-images/bots-switching-create.webp"
      : variant === "zeroTokenScheduledTasks"
      ? zeroTokenScheduledTasksAsset
      : variant === "instanceStorage"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-instance-storage-zh.webp"
        : "/assets/changelog/lightvela-instance-storage-en.webp"
      : variant === "cloudStorage"
      ? useGlobalAssets
        ? "/assets/changelog/lightvela-cloud-storage-en.webp"
        : "/assets/changelog/lightvela-cloud-storage.webp"
      : variant === "workbench"
      ? isGlobal && !useGlobalChineseAsset
        ? "/assets/changelog/lightvela-workbench-global-en.webp"
        : "/assets/changelog/lightvela-workbench-zh.webp"
      : variant === "skillPackages"
      ? "/assets/changelog/skill-packages.webp"
      : variant === "achievements"
      ? useGlobalAssets
        ? "/assets/changelog/lightvela-achievements-en.webp"
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
        ? "/assets/changelog/lightvela-skills-bulk-install-global-zh.webp"
        : "/assets/changelog/lightvela-skills-bulk-install-global-en.webp"
      : variant === "automationUpstream"
      ? isGlobal && useGlobalChineseAsset
        ? "/assets/changelog/lightvela-automation-upstream-task-global-zh.webp"
        : "/assets/changelog/lightvela-automation-upstream-task.webp"
      : variant === "automationTemplates"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-automation-templates-global-zh.webp"
        : "/assets/changelog/lightvela-automation-templates-global-en.webp"
      : variant === "qqGroupMentions"
      ? useGlobalChineseAsset
        ? "/assets/changelog/lightvela-qq-group-mentions-global-zh.webp"
        : "/assets/changelog/lightvela-qq-group-mentions-global-en.webp"
      : variant === "traditionalChinese"
      ? "/assets/changelog/lightvela-traditional-chinese-global-all.webp"
      : variant === "malayLanguage"
      ? "/assets/changelog/lightvela-malay-international-home.webp"
      : variant === "diagnosticsCenter"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-diagnostics-global-zh.webp"
          : "/assets/changelog/lightvela-diagnostics-global-en.webp"
        : "/assets/changelog/lightvela-diagnostics-domestic-zh.webp"
      : variant === "advancedSettings"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-advanced-settings-cn.webp"
          : "/assets/changelog/lightvela-advanced-settings-en.webp"
        : "/assets/changelog/lightvela-advanced-settings-cn.webp"
      : variant === "deepseekHarness"
      ? isGlobal && !useGlobalChineseAsset
        ? "/assets/changelog/lightvela-deepseek-harness-global.webp"
        : "/assets/changelog/lightvela-deepseek-harness-cn.webp"
      : variant === "wecom"
      ? "/assets/changelog/lightvela-wecom-channel.webp"
      : variant === "dingtalk"
      ? "/assets/changelog/lightvela-dingtalk-channel.webp"
      : variant === "personaUpload"
      ? isGlobal
        ? useGlobalChineseAsset
          ? "/assets/changelog/lightvela-persona-upload-global-zh.webp"
          : "/assets/changelog/lightvela-persona-upload-global-en.webp"
        : "/assets/changelog/lightvela-persona-upload.webp"
      : variant === "chat"
      ? useGlobalAssets
        ? "/assets/changelog/agentchat-web-chat-en.webp"
        : "/assets/changelog/agentchat-web-chat.webp"
      : variant === "memory"
      ? useGlobalAssets
        ? "/assets/changelog/hermes-memory-en.webp"
        : "/assets/changelog/hermes-memory.webp"
      : variant === "schedule"
      ? useGlobalAssets
        ? "/assets/changelog/scheduled-tasks-en.webp"
        : "/assets/changelog/scheduled-tasks.webp"
      : variant === "automationSkill"
      ? useGlobalAssets
        ? "/assets/changelog/automation-skill-invocation-en.webp"
        : "/assets/changelog/automation-skill-invocation.webp"
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
    variant === "planUpgrade"
      ? getChangelogUpgradeCopy(locale, isGlobal).title
      : variant === "multiBot"
      ? t("LightVela 支持创建多个 Bot")
      : variant === "zeroTokenScheduledTasks"
      ? t("定时任务新增通知任务和脚本任务")
      : variant === "instanceStorage"
      ? t("LightVela 支持查看 Agent 实例存储空间")
      : variant === "cloudStorage"
      ? t("LightVela 支持云存储管理")
      : variant === "workbench"
      ? t("LightVela 支持创建和发布工作台")
      : variant === "skillPackages"
      ? t("新增技能包功能")
      : variant === "skillsRevamp"
      ? t("技能页面全新升级")
      : variant === "skillPackagesRevamp"
      ? t("LightVela 支持技能包")
      : variant === "skillsBulkInstall"
      ? t("技能页面支持批量安装与来源查看")
      : variant === "automationUpstream"
      ? t("定时任务支持关联上游任务")
      : variant === "automationTemplates"
      ? t("定时任务模板")
      : variant === "qqGroupMentions"
      ? t("支持在 QQ 群聊中 @ 机器人")
      : variant === "traditionalChinese"
      ? t("支持繁体中文")
      : variant === "malayLanguage"
      ? t("LightVela 国际站支持马来语")
      : variant === "diagnosticsCenter"
      ? t("诊断中心上线，让 Agent 排查更简单")
      : variant === "advancedSettings"
      ? t("LightVela 新增 Hermes Agent 高级设置")
      : variant === "deepseekHarness"
      ? t("LightVela 实验室新增 DeepSeek Harness")
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
      ? t("LightVela 支持设置定时任务")
      : variant === "automationSkill"
      ? t("定时任务调用技能设置")
      : variant === "skill-package"
      ? t("LightVela 支持技能包")
      : variant === "soul"
        ? t("Soul 人设能力上线")
        : t("LightVela 产品公测上线");
  const aspectRatio =
    variant === "planUpgrade"
      ? "2200 / 1240"
      : variant === "multiBot"
      ? isGlobal && !useGlobalChineseAsset ? "1690 / 931" : "3408 / 1878"
      : variant === "zeroTokenScheduledTasks"
      ? "760 / 656"
      : variant === "instanceStorage"
      ? useGlobalChineseAsset ? "2372 / 1262" : "2367 / 1259"
      : variant === "cloudStorage"
      ? useGlobalAssets ? "1280 / 935" : "2140 / 1532"
      : variant === "workbench"
      ? isGlobal && !useGlobalChineseAsset ? "2372 / 1226" : "2372 / 1221"
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
      : variant === "malayLanguage"
      ? "1440 / 900"
      : variant === "diagnosticsCenter"
      ? isGlobal
        ? useGlobalChineseAsset ? "1281 / 615" : "1283 / 638"
        : "1454 / 1045"
      : variant === "advancedSettings"
      ? isGlobal
        ? useGlobalChineseAsset ? "1043 / 1282" : "1055 / 1285"
        : "1043 / 1282"
      : variant === "deepseekHarness"
      ? isGlobal && !useGlobalChineseAsset ? "2168 / 1287" : "2172 / 1286"
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
        className={`absolute inset-0 h-full w-full rounded-[inherit] ${
          variant === "lobster"
            ? "object-cover"
            : variant === "multiBot"
              ? "translate-y-[10%] scale-150 object-contain"
              : "object-contain"
        }`}
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
  const { i18n } = useTranslation();
  const locale = useLocaleOverride() ?? i18n.language;
  const changelogGroups = buildChangelogGroups(t, locale);

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
            className="mt-4 text-base whitespace-normal md:whitespace-nowrap"
            style={{
              color: "rgba(0,0,0,0.5)",
              lineHeight: 1.5,
              maxWidth: "none",
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
                          className="flex flex-wrap items-center gap-2 text-balance"
                          style={{
                            fontSize: "24px",
                            fontWeight: 500,
                            color: "var(--lw-fg)",
                            lineHeight: 1.5,
                            letterSpacing: "-0.01em",
                            marginBottom: entry.desc ? "20px" : "24px",
                          }}
                        >
                          <span>{entry.title}</span>
                          {entry.badge && (
                            <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium leading-none text-violet-700">
                              {entry.badge}
                            </span>
                          )}
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

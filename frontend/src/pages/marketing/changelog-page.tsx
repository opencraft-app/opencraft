/**
 * 更新日志页面
 * 还原 Figma 设计：https://www.figma.com/design/UlSg2y8cH1vc3n86WTrWhG/lightclaw独立站?node-id=231-4224
 * 布局：左侧日期（140px） + 右侧（标题 24px + 描述 + 配图卡片）
 */

import { motion } from "framer-motion";
import { type ReactNode } from "react";

import { LegalFooter } from "@/components/site/legal-footer";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { RenderUserMenuLink } from "@/components/site/user-avatar-menu";
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
  title: string;
  desc?: string;
  /** 卡片视觉样式：lobster=上线图 / cloudStorage=云存储图 / achievements=成就图 / wecom=企业微信图 / soul=人设能力图 / schedule=自动任务图 / chat=网页对话图 / memory=记忆页图 / none=无图 */
  visual: "lobster" | "cloudStorage" | "achievements" | "wecom" | "soul" | "schedule" | "chat" | "memory" | "none";
};

type ChangelogMonthGroup = {
  month: string;
  entries: ChangelogEntry[];
};

/* ═══════════════════════════════════════════════════════════════
   配图卡片 — 还原 Figma 设计稿中的插图卡片
   ═══════════════════════════════════════════════════════════════ */

function VisualCard({ variant }: { variant: "lobster" | "cloudStorage" | "achievements" | "wecom" | "soul" | "schedule" | "chat" | "memory" }) {
  const t = useT();
  /* 国际站（lightvela.com）始终使用英文版截图（含 Telegram/WhatsApp/Discord/Slack 图标），
     即使用户切换为中文，该配图仍保留英文版——避免同一站点出现国内渠道图标的信息错位；
     国内站则始终使用中文版（含 QQ/微信/飞书图标）。 */
  const imgPath =
    variant === "cloudStorage"
      ? "/assets/changelog/lightvela-cloud-storage.webp"
      : variant === "achievements"
      ? "/assets/changelog/lightvela-achievements.webp"
      : variant === "wecom"
      ? "/assets/changelog/lightvela-wecom-channel.webp"
      : variant === "chat"
      ? "/assets/changelog/agentchat-web-chat.webp"
      : variant === "memory"
      ? "/assets/changelog/hermes-memory.webp"
      : variant === "schedule"
      ? "/assets/changelog/scheduled-tasks.webp"
      : variant === "soul"
      ? "/assets/changelog/soul-persona.webp"
      : isGlobal
        ? "/assets/changelog/lightvela-launch-en.webp"
        : "/assets/changelog/lightvela-launch.webp";
  const altText =
    variant === "cloudStorage"
      ? t("LightVela 支持云存储")
      : variant === "achievements"
      ? t("LightVela 支持成就模块")
      : variant === "wecom"
      ? t("LightVela 支持企业微信通道")
      : variant === "chat"
      ? t("LightVela 支持网页内对话")
      : variant === "memory"
      ? t("LightVela支持查看Hermes Agent记忆")
      : variant === "schedule"
      ? t("LightVela 支持设置自动任务")
      : variant === "soul"
        ? t("Soul 人设能力上线")
        : t("LightVela内测上线");
  const aspectRatio =
    variant === "cloudStorage"
      ? "2140 / 1532"
      : variant === "achievements"
      ? "2140 / 1198"
      : variant === "wecom"
      ? "2160 / 844"
      : variant === "chat"
      ? "1742 / 903"
      : variant === "memory"
      ? "2326 / 1322"
      : variant === "schedule"
        ? "1952 / 806"
        : variant === "soul"
          ? "2044 / 748"
          : "710 / 360";
  /* LightVela 正式上线卡片 — 直接使用 Figma 导出的合成图 */
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{
        width: "100%",
        maxWidth: "710px",
        aspectRatio,
        backgroundColor: "#FFF5EE",
      }}
    >
      <img
        src={assetUrl(imgPath)}
        alt={altText}
        className={`absolute inset-0 h-full w-full ${variant === "lobster" ? "object-cover" : "object-contain"}`}
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
     国际站与国内站的「接入通道」差异通过两条独立字面量承载——
       · 国际站：Telegram / WhatsApp / Discord / Slack（中英文均展示国际渠道）
       · 国内站：QQ / 微信 / 飞书（中文展示国内渠道）
     isGlobal 是 Vite 编译期常量，未命中的分支会被 tree-shake 掉，
     不会污染另一侧站点的 bundle。 */
  const launchDesc = isGlobal
    ? t("支持一键创建云端 Hermes，支持接入 WeChat、Telegram、WhatsApp、Discord 通道")
    : t("支持一键创建云端 Hermes，支持快速接入 QQ、微信、飞书通道，支持主流模型 API 接入，支持一键安装 Skill 技能。");

  const mayChangelogGroup: ChangelogMonthGroup | null = isGlobal
    ? null
    : {
        month: t("2026 年 5 月"),
        entries: [
          {
            title: t("LightVela 支持网页内对话"),
            desc: t("无需切换到外部通道，现在可以在 LightVela 网页内基于 AgentChat 直接与 Hermes Agent 对话。"),
            visual: "chat",
          },
          {
            title: t("LightVela支持查看Hermes Agent记忆"),
            desc: t("在控制台查看 Hermes Agent 的记忆、用户画像和字符占用，帮助你了解 Agent 当前掌握的上下文。"),
            visual: "memory",
          },
          {
            title: t("LightVela 支持设置自动任务"),
            desc: t("为 Agent 设置周期、间隔或单次自动任务，让它按计划执行提醒、总结、通知等日常工作。"),
            visual: "schedule",
          },
          {
            title: t("Soul 人设能力上线"),
            desc: t("为 Hermes Agent 抽取并保存专属 Soul 人设，一键注入后通过 /new 开启带有新人设的新会话。"),
            visual: "soul",
          },
        ],
      };

  const changelogGroups: ChangelogMonthGroup[] = [
    {
      month: t("2026 年 6 月"),
      entries: [
        {
          title: t("LightVela 支持云存储"),
          desc: t("现在可以在 LightVela 中查看和管理 Hermes Agent 的云存储文件，上传、下载、整理工作资料更方便。"),
          visual: "cloudStorage",
        },
        {
          title: t("LightVela 支持成就模块"),
          desc: t("不断深入使用 Hermes Agent，将会解锁更多新鲜成就，记录你的探索进度。"),
          visual: "achievements",
        },
        {
          title: t("LightVela 支持企业微信通道"),
          desc: t("现在可以将 Hermes Agent 接入企业微信，在企业微信会话中直接与云端智能伙伴对话。"),
          visual: "wecom",
        },
      ],
    },
    ...(mayChangelogGroup ? [mayChangelogGroup] : []),
    {
      month: t("2026 年 4 月"),
      entries: [
        {
          title: t("LightVela内测上线"),
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
              maxWidth: "480px",
            }}
          >
            {t("记录每一个版本的成长，持续迭代，只为给你更好的体验。")}
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
                key={group.month}
                variants={fadeInUp}
                className="grid grid-cols-1 gap-6 md:grid-cols-[140px_1fr] md:gap-16"
              >
                {/* 左列：月份 */}
                <div className="pt-1">
                  <p
                    style={{
                      fontSize: "16px",
                      fontWeight: 400,
                      color: "rgba(0,0,0,0.5)",
                      lineHeight: 2,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {group.month}
                  </p>
                </div>

                {/* 右列：月内条目 */}
                <div>
                  {group.entries.map((entry, index) => (
                    <article
                      key={`${group.month}-${entry.title}`}
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
  renderUserMenuLink?: RenderUserMenuLink;
};

export const ChangelogPage = ({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
  renderUserMenuLink,
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
        renderUserMenuLink={renderUserMenuLink}
      />
      <main className="z-10 flex-grow pt-[60px]">
        <ChangelogContent />
      </main>
      <LegalFooter />
    </div>
  );
};

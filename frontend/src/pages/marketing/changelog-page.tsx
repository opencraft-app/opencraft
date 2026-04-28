/**
 * 更新日志页面
 * 还原 Figma 设计：https://www.figma.com/design/UlSg2y8cH1vc3n86WTrWhG/lightclaw独立站?node-id=231-4224
 * 布局：左侧日期（140px） + 右侧（标题 24px + 描述 + 配图卡片）
 */

import { motion } from "framer-motion";
import { useState } from "react";

import { LoginModal } from "@/components/site/login-modal";
import { LegalFooter } from "@/components/site/legal-footer";
import { useSession } from "@/contexts/session-context";
import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { isGlobal } from "@/lib/region";

import { LandingNavbar } from "./landing/landing-navbar";

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
  date: string;
  title: string;
  desc?: string;
  /** 卡片视觉样式：lobster=产品截图 / none=无图 */
  visual: "lobster" | "none";
};

/* ═══════════════════════════════════════════════════════════════
   配图卡片 — 还原 Figma 设计稿中的插图卡片
   ═══════════════════════════════════════════════════════════════ */

function VisualCard({ variant: _variant }: { variant: "lobster" }) {
  const t = useT();
  /* 国际站（lightvela.com）始终使用英文版截图（含 Telegram/WhatsApp/Discord/Slack 图标），
     即使用户切换为中文，该配图仍保留英文版——避免同一站点出现国内渠道图标的信息错位；
     国内站则始终使用中文版（含 QQ/微信/飞书图标）。 */
  const imgPath = isGlobal
    ? "/changelog/lightvela-launch-en.png"
    : "/changelog/lightvela-launch.png";
  /* LightVela 正式上线卡片 — 直接使用 Figma 导出的合成图 */
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{
        width: "100%",
        maxWidth: "710px",
        aspectRatio: "710 / 360",
        backgroundColor: "#FFF5EE",
      }}
    >
      <img
        src={assetUrl(imgPath)}
        alt={t("LightVela 正式上线")}
        className="absolute inset-0 h-full w-full object-cover"
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
    ? t("支持一键创建云端 Hermes，支持接入 Telegram、WhatsApp、Discord、Slack 通道")
    : t("支持一键创建云端 Hermes，支持接入 QQ、微信、飞书通道");

  const changelogData: ChangelogEntry[] = [
    {
      date: t("2026 年 4 月 21 日"),
      title: t("LightVela 正式上线"),
      desc: launchDesc,
      visual: "lobster",
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
          {changelogData.map((entry, i) => (
            <motion.article
              key={i}
              variants={fadeInUp}
              className="grid grid-cols-1 gap-6 md:grid-cols-[140px_1fr] md:gap-16"
            >
              {/* 左列：日期 */}
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
                  {entry.date}
                </p>
              </div>

              {/* 右列：标题 + 描述 + 配图 */}
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
            </motion.article>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Changelog Page
   ═══════════════════════════════════════════════════════════════ */

export const ChangelogPage = () => {
  const [showLogin, setShowLogin] = useState(false);
  const { isAuthenticated } = useSession();

  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
    >
      <LandingNavbar onLoginClick={() => setShowLogin(true)} isLoggedIn={isAuthenticated} />
      <main className="z-10 flex-grow">
        <ChangelogContent />
      </main>
      <LegalFooter />
      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
};

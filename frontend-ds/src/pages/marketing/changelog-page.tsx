/**
 * 更新日志页面
 * 设计风格与落地页（landing-page）保持一致：冰火实验室 — 新瑞士主义 × 有机科技感
 */

import { motion } from "framer-motion";
import { Link } from "react-router-dom";

import { LoginModal } from "@/components/site/login-modal";
import { LegalFooter } from "@/components/site/legal-footer";
import { useSession } from "@/contexts/session-context";
import { useState } from "react";

const LOGO_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5affb0c4-cfed-4614-aa34-6868d88f1717.svg";

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
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const viewportConfig = { once: true, margin: "-40px" as const };

/* ═══════════════════════════════════════════════════════════════
   更新记录数据
   ═══════════════════════════════════════════════════════════════ */

type ChangelogEntry = {
  date: string;
  version: string;
  tag: "新功能" | "优化" | "修复" | "预告";
  title: string;
  desc: string;
  highlights?: string[];
  tags?: string[];
};

const changelogData: ChangelogEntry[] = [
  {
    date: "2026-03-29",
    version: "v1.0.0",
    tag: "新功能",
    title: "LightClaw 正式上线",
    desc: "第一个生产可用版本发布，支持一键创建云端 OpenClaw 并接入 QQ 通道。",
    highlights: [
      "支持一键创建云端 OpenClaw，无需配置模型",
      "支持接入 QQ 通道",
    ],
    tags: ["云端部署", "QQ 通道", "免配置"],
  },
];

const tagColors: Record<ChangelogEntry["tag"], string> = {
  "新功能": "var(--lw-accent)",
  "优化": "#10B981",
  "修复": "#6366F1",
  "预告": "#F59E0B",
};

const tagBgColors: Record<ChangelogEntry["tag"], string> = {
  "新功能": "rgba(230,111,98,0.1)",
  "优化": "rgba(16,185,129,0.1)",
  "修复": "rgba(99,102,241,0.1)",
  "预告": "rgba(245,158,11,0.1)",
};

/* ═══════════════════════════════════════════════════════════════
   Navbar
   ═══════════════════════════════════════════════════════════════ */

const navLinks = [
  { label: "更新日志", href: "/changelog" },
  { label: "产品文档", href: "#", comingSoon: true },
  { label: "养虾博客", href: "#", comingSoon: true },
];

function ChangelogNavbar({ onLoginClick }: { onLoginClick: () => void }) {
  const { isAuthenticated: isLoggedIn } = useSession();

  return (
    <header
      className="fixed top-0 inset-x-0 z-50 border-b"
      style={{
        backgroundColor: "rgba(247,248,250,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderColor: "rgba(233,236,240,0.8)",
      }}
    >
      <div
        className="mx-auto flex items-center justify-between px-6 md:px-8"
        style={{ maxWidth: "var(--lw-max-content)", height: "64px" }}
      >
        <Link to="/" className="flex items-center">
          <img
            src={LOGO_URL}
            alt="LightClaw"
            className="object-contain"
            style={{ height: "32px" }}
          />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            link.comingSoon ? (
              <span
                key={link.href}
                className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)] cursor-default"
              >
                {link.label}
                <span className="rounded-full border border-[var(--lw-border)] bg-[var(--lw-bg)] px-2 py-0.5 text-[10px] font-normal leading-none text-[var(--text-tertiary)]">
                  即将上线
                </span>
              </span>
            ) : (
              <a
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-[var(--text-secondary)] transition-colors duration-200 hover:text-[var(--text-primary)]"
              >
                {link.label}
              </a>
            )
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          {isLoggedIn ? (
            <Link
              to="/openclaw/settings"
              className="rounded-full px-5 py-2 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5"
              style={{
                background: "#fff",
                color: "#333",
                boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
              }}
            >
              我的 LightClaw
            </Link>
          ) : (
            <button
              onClick={onLoginClick}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.375rem",
                backgroundColor: "var(--lw-accent)",
                color: "#fff",
                padding: "0.375rem 0.875rem",
                borderRadius: "9999px",
                fontWeight: 700,
                fontSize: "0.75rem",
                border: "1px solid var(--lw-accent)",
                cursor: "pointer",
                boxShadow: "var(--shadow-glow)",
              }}
            >
              创建LightClaw
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Changelog Timeline
   ═══════════════════════════════════════════════════════════════ */

function ChangelogTimeline() {
  return (
    <section
      style={{ backgroundColor: "var(--lw-bg)", paddingTop: "6rem", paddingBottom: "8rem" }}
    >
      <div className="mx-auto px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>

        {/* 标题区 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={viewportConfig}
          className="mb-16"
        >
          <motion.p
            variants={fadeInUp}
            className="mb-4 text-sm font-semibold uppercase tracking-widest"
            style={{ color: "var(--lw-accent)", letterSpacing: "0.12em" }}
          >
            产品更新
          </motion.p>
          <motion.h1
            variants={fadeInUp}
            style={{
              fontSize: "clamp(2rem, 4vw, 3.25rem)",
              fontWeight: 900,
              color: "var(--lw-fg)",
              letterSpacing: "-0.03em",
              lineHeight: 1.1,
            }}
          >
            更新日志
          </motion.h1>
          <motion.p
            variants={fadeInUp}
            className="mt-4 text-base"
            style={{ color: "var(--lw-fg-secondary)", lineHeight: 1.7, maxWidth: "480px" }}
          >
            记录每一个版本的成长，持续迭代，只为给你更好的体验。
          </motion.p>
        </motion.div>

        {/* 时间线 */}
        <div className="relative">
          <motion.div variants={staggerContainer} initial="hidden" whileInView="visible" viewport={viewportConfig} className="space-y-8">
            {changelogData.map((entry, i) => (
              <motion.div key={i} variants={fadeInUp} className="relative flex">
                {/* 左侧：日期+版本 */}
                <div className="hidden w-[140px] flex-shrink-0 pr-5 pt-6 text-right md:block">
                  <p className="text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>{entry.date}</p>
                  <p className="mt-1 text-xs font-bold" style={{ color: "var(--lw-accent)" }}>{entry.version}</p>
                </div>
                {/* 中间：竖线+圆点 */}
                <div className="relative flex flex-col items-center" style={{ width: "24px" }}>
                  <div className="mt-6 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: tagColors[entry.tag], boxShadow: `0 0 0 3px var(--lw-bg)` }}>
                    <div className="h-1.5 w-1.5 rounded-full bg-white" />
                  </div>
                  {i < changelogData.length - 1 && <div className="w-px flex-1" style={{ backgroundColor: "var(--lw-border)" }} />}
                </div>
                {/* 右侧：卡片 */}
                <div className="flex-1 pl-5 pb-2">
                  <div className="mb-2 md:hidden">
                    <span className="text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>{entry.date}</span>
                    <span className="ml-2 text-xs font-bold" style={{ color: "var(--lw-accent)" }}>{entry.version}</span>
                  </div>
                  <div className="rounded-2xl" style={{ padding: "24px", backgroundColor: "var(--lw-bg)", border: "1px solid var(--lw-border)", boxShadow: "0 2px 12px rgba(0,0,0,0.03)" }}>
                    <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ marginBottom: "12px", backgroundColor: tagBgColors[entry.tag], color: tagColors[entry.tag] }}>{entry.tag}</span>
                    <h3 className="text-left text-lg font-bold" style={{ color: "var(--lw-fg)", letterSpacing: "-0.015em", marginBottom: "10px" }}>{entry.title}</h3>
                    {entry.highlights && (
                      <ul className="text-left" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {entry.highlights.map((h, j) => (
                          <li key={j} className="flex items-start gap-2 text-sm" style={{ color: "var(--lw-fg-secondary)" }}>
                            <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: "var(--lw-fg-secondary)" }} />
                            <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.tags && (
                      <>
                        <div style={{ marginTop: "16px", marginBottom: "16px", height: "1px", backgroundColor: "#F0F0F0" }} />
                        <div className="flex flex-wrap" style={{ gap: "8px" }}>
                          {entry.tags.map((t, j) => (
                            <span key={j} className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "#F3F4F6", color: "var(--lw-fg-tertiary)" }}>{t}</span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Changelog Page
   ═══════════════════════════════════════════════════════════════ */

export const ChangelogPage = () => {
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "var(--lw-bg)", color: "var(--lw-fg)" }}
    >
      <ChangelogNavbar onLoginClick={() => setShowLogin(true)} />
      <main className="z-10 flex-grow">
        <ChangelogTimeline />
      </main>
      <LegalFooter />
      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
};

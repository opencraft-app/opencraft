/**
 * 关于我们落地页
 * 板块：Hero（球体半露）→ 我们的故事 → 高亮宣言 + 找到我们
 * 设计风格：极简大气，白色 + 浅灰背景，新瑞士主义
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

import { LoginModal } from "@/components/site/login-modal";
import { LegalFooter } from "@/components/site/legal-footer";
import { useSession } from "@/contexts/session-context";
import { useT, t as rawT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";

import { LandingNavbar } from "./landing/landing-navbar";

/* ═══════════════════════════════════════════════════════════════
   Hero Section — 球体只露上半圆弧 + 居中标题
   ═══════════════════════════════════════════════════════════════ */

function HeroSection() {
  const t = useT();
  return (
    <section
      style={{
        position: "relative",
        height: "clamp(280px, 32vw, 420px)",
        overflow: "hidden",
        background: "#ffffff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Ball — centered horizontally, only top half visible */}
      <div
        style={{
          position: "absolute",
          top: "9%",
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
          userSelect: "none",
          zIndex: 1,
        }}
      >
        <motion.img
          src="/assets/landing/about/ball.png"
          alt=""
          draggable={false}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 2.0, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={{
            width: "clamp(750px, 97vw, 1290px)",
            height: "clamp(750px, 97vw, 1290px)",
            objectFit: "cover",
            borderRadius: "50%",
            display: "block",
          }}
        />
      </div>

      {/* Soft edge mask — bottom gradient fade */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "120px",
          background: "linear-gradient(to bottom, transparent, #ffffff)",
          zIndex: 3,
          pointerEvents: "none",
        }}
      />

      {/* Text — positioned in upper-center area above ball */}
      <div
        style={{
          position: "relative",
          zIndex: 4,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: "16px",
          marginTop: "clamp(20px, 4vw, 60px)",
        }}
      >
        <motion.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.0, delay: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={{
            fontSize: "clamp(32px, 4.8vw, 56px)",
            fontWeight: 500,
            color: "#1a1a1a",
            letterSpacing: "0.02em",
            lineHeight: 1.2,
            margin: 0,
          }}
        >
          {t("关于 LightVela")}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.0, delay: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={{
            fontSize: "clamp(14px, 1.6vw, 17px)",
            fontWeight: 300,
            color: "#666",
            letterSpacing: "0.08em",
            margin: 0,
          }}
        >
          {t("每一个数字灵魂，值得被温柔点亮")}
        </motion.p>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   我们的故事 Section — 时间线风格
   ═══════════════════════════════════════════════════════════════ */

/**
 * 故事时间线段落。
 * 注意：模块顶层不能调用 React Hook，因此使用 i18n 命令式接口 `rawT`，
 * 该接口与 `useT()` 共享同一份 zh→key 反查表，且已被 i18n-extract 收录。
 * 实际取值时机为模块加载时——在 i18next 初始化后，语言切换会触发整页刷新，
 * 所以这里取一次值即可（与 `getBotStatusLabel` 的处理方式一致）。
 */
const getStoryParagraphs = () => [
  {
    id: "origin",
    tag: rawT("起源"),
    text: rawT("2026 年 3 月 6 日，我们在深圳腾讯大厦楼下举办了第一场 OpenClaw 公益装机活动，没想到直接引爆了全国装虾热潮，也得到了 OpenClaw 创始人 Peter 的点赞转发。于是，在践行 AI 普惠的路上，我们决定再走一步，在全国各地开展线下公益装机活动，深圳龙岗的千人装机节成为中国最大规模的单场 AI 工具安装活动。再后来，Hermes Agent 的出现，我们也快速迭代跟进，旨在帮助用户能快速拥抱 AI Agent 前沿技术。"),
  },
  {
    id: "insight",
    tag: rawT("洞察"),
    text: rawT("40+ 个城市，456 场活动，7 万人。这场运动让我们意识到：人们需要的不只是一次安装，而是持续、稳定、无门槛的 AI 服务。LightVela 因此诞生——将 AI Agent 的完整能力搬上云端，7×24 小时待命，数据完全归你。"),
  },
  {
    id: "promise",
    tag: rawT("承诺"),
    text: rawT("从装虾到全民拥抱 AI Agent，我们一直在。"),
    isClosing: true,
  },
];

function StorySection() {
  const t = useT();
  const storyParagraphs = getStoryParagraphs();
  return (
    <section
      style={{
        background: "#ffffff",
        padding: "110px 0 140px",
        borderTop: "1px solid rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ maxWidth: "860px", margin: "0 auto", padding: "0 52px" }}>
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.9 }}
          style={{ marginBottom: "60px" }}
        >
          <h2
            style={{
              fontSize: "clamp(22px, 3.2vw, 36px)",
              fontWeight: 500,
              color: "#0a0a0a",
              letterSpacing: "0.02em",
              marginBottom: "14px",
            }}
          >
            {t("我们的故事")}
          </h2>
          <div style={{ width: "28px", height: "2px", background: "#0a0a0a" }} />
        </motion.div>

        {/* Attribution */}
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.1 }}
          style={{
            fontSize: "14px",
            color: "#888",
            letterSpacing: "0.04em",
            marginBottom: "52px",
            lineHeight: 1.8,
            fontWeight: 300,
          }}
        >
          {t("LightVela 由腾讯轻量云团队出品。")}
        </motion.p>

        {/* Paragraphs with tags */}
        <div style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
          {storyParagraphs.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.95, delay: i * 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
              style={{ display: "flex", gap: "28px", alignItems: "flex-start" }}
            >
              {/* Tag column */}
              <div
                style={{
                  flexShrink: 0,
                  width: "44px",
                  paddingTop: "4px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <span
                  style={{
                    fontSize: "10px",
                    color: "#bbb",
                    letterSpacing: "0.1em",
                    writingMode: "vertical-rl",
                    fontWeight: 300,
                  }}
                >
                  {p.tag}
                </span>
                {i < storyParagraphs.length - 1 && (
                  <div
                    style={{
                      width: 1,
                      height: "32px",
                      background: "linear-gradient(to bottom, rgba(0,0,0,0.12), transparent)",
                    }}
                  />
                )}
              </div>

              {/* Body text */}
              <p
                style={{
                  fontSize: p.isClosing ? "clamp(16px, 2vw, 20px)" : "clamp(13px, 1.5vw, 15px)",
                  color: p.isClosing ? "#0a0a0a" : "#2a2a2a",
                  lineHeight: p.isClosing ? 1.9 : 2.2,
                  letterSpacing: "0.03em",
                  flex: 1,
                  fontWeight: p.isClosing ? 500 : 300,
                  margin: 0,
                }}
              >
                {p.text}
              </p>
            </motion.div>
          ))}
        </div>




      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════
   高亮宣言 Section — 参考 character.ai about 大字居中风格
   ═══════════════════════════════════════════════════════════════ */

function HighlightSection() {
  const t = useT();
  const [showQR, setShowQR] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* 星光粒子动效 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let particles: { x: number; y: number; size: number; speed: number; opacity: number; flickerSpeed: number }[] = [];

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };

    const initParticles = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      const count = Math.floor((w * h) / 8000); // 粒子密度
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        size: Math.random() * 1.8 + 0.6,
        speed: Math.random() * 0.3 + 0.15,
        opacity: Math.random() * 0.7 + 0.3,
        flickerSpeed: Math.random() * 0.02 + 0.005,
      }));
    };

    let time = 0;
    const animate = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);
      time += 1;

      for (const p of particles) {
        p.y -= p.speed;
        // 到达顶部后从底部重新出现
        if (p.y < -10) {
          p.y = h + 10;
          p.x = Math.random() * w;
        }
        // 闪烁
        const flicker = Math.sin(time * p.flickerSpeed + p.x) * 0.3 + 0.7;
        const alpha = p.opacity * flicker;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fill();

        // 辉光效果
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.15})`;
        ctx.fill();
      }

      animId = requestAnimationFrame(animate);
    };

    resize();
    initParticles();
    animate();

    window.addEventListener("resize", () => {
      resize();
      initParticles();
    });

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <section
      style={{
        position: "relative",
        padding: "64px 40px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "28px",
        backgroundImage: "url('/assets/landing/about/hignlight-bg.jpg')",
        backgroundSize: "cover",
        backgroundPosition: "top center",
        backgroundAttachment: "fixed",
        backgroundRepeat: "no-repeat",
        overflow: "hidden",
      }}
    >
      {/* 毛玻璃遮罩层 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backdropFilter: "blur(5px)",
          WebkitBackdropFilter: "blur(5px)",
          background: "rgba(255, 255, 255, 0.3)",
        }}
      />

      {/* 上边缘模糊过渡 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "60px",
          background: "linear-gradient(to bottom, #ffffff, transparent)",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />

      {/* 下边缘模糊过渡 */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "60px",
          background: "linear-gradient(to top, #ffffff, transparent)",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />

      {/* Canvas 星光粒子 */}
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          zIndex: 1,
          pointerEvents: "none",
        }}
      />

      <motion.h3
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 1.0, ease: [0.25, 0.46, 0.45, 0.94] }}
        style={{
          position: "relative",
          zIndex: 3,
          maxWidth: "780px",
          fontSize: "clamp(20px, 3.2vw, 36px)",
          fontWeight: 400,
          color: "#1a1a1a",
          lineHeight: 1.8,
          letterSpacing: "0.02em",
          textAlign: "center",
          margin: 0,
        }}
      >
        {t("我们把 AI Agent 搬上云端，让你无需折腾部署，随时唤醒，对话数据永远只属于你。")}
      </motion.h3>

      {/* 找到我们按钮 + 悬浮二维码 */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, delay: 0.3 }}
        style={{
          position: "relative",
          zIndex: 3,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
        onMouseEnter={() => setShowQR(true)}
        onMouseLeave={() => setShowQR(false)}
      >
        {/* 二维码 absolute 悬浮在按钮上方，不占位 */}
        <AnimatePresence>
          {showQR && (
            <motion.div
              initial={{ opacity: 0, scale: 0.88, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.88, y: 10 }}
              transition={{ type: "spring", stiffness: 380, damping: 26 }}
              style={{
                position: "absolute",
                bottom: "calc(100% + 12px)",
                left: "50%",
                marginLeft: "-96px",
                padding: "14px",
                background: "#ffffff",
                borderRadius: "12px",
                boxShadow: "0 12px 40px rgba(0,0,0,0.12)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "8px",
                width: "192px",
              }}
            >
              <img
                src={isGlobal ? "/assets/landing/about/International-Discord.png" : "/assets/landing/about/community-qr.png"}
                alt={t("加入交流群")}
                style={{ width: "160px", height: "160px", borderRadius: "6px" }}
              />
              <span style={{ fontSize: "11px", color: "#888", letterSpacing: "0.04em" }}>
                {isGlobal ? t("扫码加入Discord交流群") : t("扫码加入交流群")}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          style={{
            padding: "10px 24px",
            borderRadius: "8px",
            border: "1px solid rgba(0,0,0,0.1)",
            background: "#ffffff",
            color: "#1a1a1a",
            fontSize: "13px",
            fontWeight: 400,
            letterSpacing: "0.04em",
            cursor: "pointer",
            transition: "box-shadow 0.3s ease",
            boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span style={{ fontSize: "14px" }}>✦</span>
          {t("找到我们")}
        </motion.button>
      </motion.div>
    </section>
  );
}








/* ═══════════════════════════════════════════════════════════════
   关于我们页面主组件
   ═══════════════════════════════════════════════════════════════ */

export const AboutPage = () => {
  const { isAuthenticated } = useSession();
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div
      className="landing-page relative flex min-h-screen flex-col"
      style={{ background: "#ffffff", color: "#1a1a1a", overflowX: "hidden" }}
    >
      <LandingNavbar onLoginClick={() => setShowLogin(true)} isLoggedIn={isAuthenticated} />

      <main className="z-10 flex-grow pt-[60px]">
        {/* 首屏 Hero */}
        <HeroSection />

        {/* 我们的故事 */}
        <StorySection />

        {/* 高亮宣言 + 找到我们 */}
        <HighlightSection />
      </main>

      <LegalFooter />

      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
};

import { LegalFooter } from "@/components/site/legal-footer";
import { motion } from "framer-motion";
import { ArrowRight, Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { BrandMark } from "@/components/site/brand-mark";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { assetUrl } from "@/lib/asset-url";
import { AGENTS_HOME_PATH } from "@/lib/agent-routes";

/* ─── Navbar ─── */

const SuccessNavbar = () => {
  const { isLoggedIn } = useOpenClaw();

  return (
    <header className="lw-setup-navbar">
      <div className="mx-auto flex items-center justify-between px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>
        <BrandMark to="/" />
        {isLoggedIn ? (
          <UserAvatarMenu />
        ) : (
          <Link
            to="/"
            className="rounded-full px-5 py-2 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5"
            style={{
              background: "#fff",
              color: "#333",
              boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
            }}
          >
            返回首页
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Confetti Dots ─── */

const ConfettiDots = () => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden">
    {Array.from({ length: 20 }).map((_, i) => (
      <motion.div
        key={i}
        className="absolute rounded-full"
        style={{
          width: Math.random() * 8 + 4,
          height: Math.random() * 8 + 4,
          background: ["#e66f62", "#f0a878", "#FFD93D", "#6BCB77", "#4D96FF"][i % 5],
          left: `${Math.random() * 100}%`,
          top: `${Math.random() * 60}%`,
        }}
        initial={{ opacity: 0, scale: 0, y: -20 }}
        animate={{
          opacity: [0, 1, 1, 0],
          scale: [0, 1, 1, 0.5],
          y: [0, 20, 60, 120],
        }}
        transition={{
          duration: 2.5,
          delay: i * 0.1,
          ease: "easeOut",
        }}
      />
    ))}
  </div>
);

/* ─── Avatar Helper ─── */

const LIGHTCLAW_AVATARS = [assetUrl('/hermes_logo.png')];

const getAvatarForBot = (botId: string) => {
  let hash = 0;
  for (let i = 0; i < botId.length; i++) {
    hash = ((hash << 5) - hash) + botId.charCodeAt(i);
    hash |= 0;
  }
  return LIGHTCLAW_AVATARS[Math.abs(hash) % LIGHTCLAW_AVATARS.length];
};

/* ─── Success Page ─── */

export const OpenClawSuccessPage = () => {
  const { bots } = useOpenClaw();
  // 获取最新创建的 Agent，用于成功页确认信息。
  const latestBot = bots.length > 0
    ? bots.reduce((latest, bot) =>
      new Date(bot.createdAt) > new Date(latest.createdAt) ? bot : latest
    )
    : null;

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <SuccessNavbar />

      <main className="relative z-10 flex flex-grow items-center justify-center pb-8 pt-24">
        <section className="relative mx-auto w-full max-w-lg px-6 md:px-8">
          <ConfettiDots />

          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1] }}
            className="relative z-10 flex flex-col items-center text-center"
          >
            {/* Success Icon */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, duration: 0.5, type: "spring", stiffness: 200, damping: 15 }}
              className="mb-3"
            >
              <img src={assetUrl('/hermes_logo.png')} alt="Hermes" className="h-28 w-28 object-contain" />
            </motion.div>

            {/* Title */}
            <motion.h1
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
              className="whitespace-nowrap"
              style={{ fontSize: "clamp(1.5rem, 3.5vw, 2rem)", marginBottom: "0.75rem" }}
            >
              🎉 Hermes 创建成功！
            </motion.h1>

            {/* Description */}
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              className="text-base leading-relaxed whitespace-nowrap"
              style={{ color: "#666", marginBottom: "1.5rem" }}
            >
              你的 Hermes 已准备就绪，可以前往设置页进一步配置接入通道。
            </motion.p>

            {/* Created Agent Preview Card */}
            {latestBot && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.5 }}
                className="lw-setup-card mb-8 w-full overflow-hidden"
              >
                <div className="flex items-center gap-4 p-5">
                  <div
                    className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
                    style={{ background: "rgba(255,240,230,0.8)" }}
                  >
                    <img src={getAvatarForBot(latestBot.id)} alt="" className="h-12 w-12 object-contain" />
                  </div>

                  <div className="min-w-0 flex-1 text-left">
                    <h4 className="truncate text-base font-bold" style={{ color: "var(--lw-fg)" }}>{latestBot.name}</h4>
                    <p className="mt-1 text-xs" style={{ color: "#999" }}>
                      Agent 已准备就绪，可以继续配置接入通道。
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* CTA Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.5 }}
              className="flex w-full flex-col items-center gap-4"
            >
              <Link
                to={AGENTS_HOME_PATH}
                className="lw-btn-primary w-full max-w-md justify-center"
              >
                <Bot className="h-4 w-4" />
                管理我的智能体伙伴
                <ArrowRight className="h-4 w-4" />
              </Link>
            </motion.div>
          </motion.div>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
};

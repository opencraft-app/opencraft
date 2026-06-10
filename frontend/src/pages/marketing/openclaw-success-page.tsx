import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Bot, FileText, Download, X, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useRepositories } from "@/contexts/repository-context";
import { BrandMark } from "@/components/site/brand-mark";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { avatarImageUrl } from "@/lib/avatar-image";
import { assetUrl } from "@/lib/asset-url";
import { AGENTS_HOME_PATH } from "@/router/paths";

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

/* ─── Birth Certificate Modal ─── */

const BirthCertificateModal = ({
  bot,
  onClose
}: {
  bot: { id: string; name: string; createdAt: string };
  onClose: () => void;
}) => {
  const repositories = useRepositories();
  const certificateRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [bornCardLoading, setBornCardLoading] = useState(true);
  const [bornCardError, setBornCardError] = useState<string | null>(null);
  const [bornCardOrder, setBornCardOrder] = useState<number | null>(null);
  const [bornCardCreatedAt, setBornCardCreatedAt] = useState(bot.createdAt);

  useEffect(() => {
    let cancelled = false;

    setBornCardLoading(true);
    setBornCardError(null);

    repositories.bots.getBotBornCard(bot.id)
      .then((card) => {
        if (cancelled) {
          return;
        }
        setBornCardOrder(card.bornNumberForChina);
        setBornCardCreatedAt(card.createdAt);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "出生证明加载失败";
        setBornCardError(message);
        setBornCardOrder(null);
        setBornCardCreatedAt(bot.createdAt);
      })
      .finally(() => {
        if (!cancelled) {
          setBornCardLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bot.createdAt, bot.id, repositories.bots]);

  const createdDate = new Date(bornCardCreatedAt);
  const year = createdDate.getFullYear();
  const month = createdDate.getMonth() + 1;
  const day = createdDate.getDate();

  const avatarPath = getAvatarForBot(bot.id) ?? "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png";
  const avatarUrl = avatarImageUrl(avatarPath);

  const handleDownload = async () => {
    if (!certificateRef.current || downloading) return;

    setDownloading(true);
    try {
      const html2canvas = (await import("html2canvas")).default;

      const canvas = await html2canvas(certificateRef.current, {
        backgroundColor: "#FFD4A8",
        scale: 2,
        useCORS: false,
        allowTaint: true,
        logging: false,
        imageTimeout: 15000,
      });

      const link = document.createElement("a");
      link.download = `龙虾出生证明_${bot.name}_${year}${month}${day}.png`;
      link.href = canvas.toDataURL("image/png", 1.0);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("下载失败:", error);
    } finally {
      setDownloading(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
          className="relative flex flex-col items-center"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 证书主体 */}
          <div
            ref={certificateRef}
            data-certificate="true"
            style={{
              width: 600,
              backgroundColor: "#FFD4A8",
              backgroundImage: "linear-gradient(145deg, #FFD4A8 0%, #FFCA94 15%, #FFE4C8 50%, #FFCA94 85%, #FFD4A8 100%)",
              borderRadius: 12,
              position: "relative",
              overflow: "hidden",
              boxShadow: "0 25px 60px rgba(0,0,0,0.25), 0 10px 20px rgba(0,0,0,0.15)"
            }}
          >
            {/* 装饰波浪线 */}
            <div style={{ position: "absolute", top: 20, left: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", top: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", bottom: 20, left: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ position: "absolute", bottom: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2" />
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5" />
              </svg>
            </div>

            <div style={{ padding: "32px 40px 36px" }}>
              {/* 标题 */}
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <h2
                  style={{
                    fontSize: 36,
                    fontWeight: 900,
                    letterSpacing: 4,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    color: "#E66F62",
                    textShadow: "2px 2px 0 rgba(230,111,98,0.15), -1px -1px 0 rgba(255,255,255,0.5)",
                    margin: 0,
                    lineHeight: 1.2
                  }}
                >
                  <span style={{ fontSize: 30, color: "#E66F62", opacity: 0.6 }}>『</span>
                  小龙虾出生证明
                  <span style={{ fontSize: 30, color: "#E66F62", opacity: 0.6 }}>』</span>
                </h2>
              </div>

              {/* 主体卡片 */}
              <div
                style={{
                  backgroundColor: "rgba(255,250,245,0.95)",
                  border: "3px solid rgba(230,111,98,0.15)",
                  borderRadius: 12,
                  padding: 24,
                  marginLeft: 12,
                  marginRight: 12
                }}
              >
                <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
                  {/* 龙虾图片 */}
                  <div style={{ flexShrink: 0 }}>
                    <div
                      style={{
                        width: 144,
                        height: 144,
                        overflow: "hidden",
                        borderRadius: 12,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(255,240,230,0.8)"
                      }}
                    >
                      <img
                        src={avatarUrl}
                        alt="Hermes宝宝"
                        style={{ width: 128, height: 128, objectFit: "contain" }}
                      />
                    </div>
                  </div>

                  {/* 信息 */}
                  <div style={{ flex: 1, paddingTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", color: "#5C4033" }}>
                        龙虾昵称：
                      </span>
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#5C4033", wordBreak: "break-all" }}>
                        {bot.name}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", color: "#5C4033" }}>
                        家庭住址：
                      </span>
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#5C4033" }}>
                        LightVela
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                      <span style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", color: "#5C4033" }}>
                        出生日期：
                      </span>
                      <span style={{ fontSize: 16, fontWeight: 600, color: "#5C4033" }}>
                        {year}年{month}月{day}日
                      </span>
                    </div>
                  </div>
                </div>

                {/* 底部徽章 */}
                <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                  {bornCardLoading ? (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 10,
                        paddingLeft: 24,
                        paddingRight: 24,
                        paddingTop: 12,
                        paddingBottom: 12,
                        borderRadius: 9999,
                        backgroundColor: "rgba(255,245,238,0.9)",
                        border: "2px solid rgba(230,111,98,0.2)",
                        color: "#E66F62",
                        fontSize: 15,
                        fontWeight: 700,
                      }}
                    >
                      <Loader2 className="h-4 w-4 animate-spin" />
                      出生编号加载中...
                    </div>
                  ) : bornCardError ? (
                    <div
                      style={{
                        maxWidth: 360,
                        padding: "12px 18px",
                        borderRadius: 16,
                        backgroundColor: "rgba(255,245,238,0.95)",
                        border: "2px solid rgba(230,111,98,0.2)",
                        color: "#A14E45",
                        fontSize: 14,
                        fontWeight: 600,
                        textAlign: "center",
                      }}
                    >
                      出生编号暂时不可用，请稍后重试。
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        paddingLeft: 24,
                        paddingRight: 24,
                        paddingTop: 12,
                        paddingBottom: 12,
                        borderRadius: 9999,
                        backgroundColor: "rgba(255,245,238,0.9)",
                        border: "2px solid rgba(230,111,98,0.25)"
                      }}
                    >
                      <span style={{ fontSize: 14, marginRight: 4, color: "#E66F62" }}>✦</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#E66F62" }}>今天出生的第</span>
                      <span style={{ fontSize: 30, fontWeight: 900, marginLeft: 4, marginRight: 4, color: "#E66F62", textShadow: "1px 1px 0 rgba(230,111,98,0.2)" }}>
                        {bornCardOrder}
                      </span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#E66F62" }}>个Hermes宝宝</span>
                      <span style={{ fontSize: 14, marginLeft: 4, color: "#E66F62" }}>✦</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 按钮区域 */}
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={handleDownload}
              disabled={downloading || bornCardLoading || !!bornCardError}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
              style={{ background: "#E66F62" }}
            >
              {downloading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  下载中...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  下载图片
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold transition-all hover:bg-[rgba(255,255,255,0.15)]"
              style={{ color: "#fff", background: "rgba(255,255,255,0.1)" }}
            >
              <X className="h-4 w-4" />
              关闭
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

/* ─── Success Page ─── */

export const OpenClawSuccessPage = () => {
  const { bots } = useOpenClaw();
  const [showBirthCert, setShowBirthCert] = useState(false);

  // 获取最新创建的 bot（用于出生证明）
  const latestBot = bots.length > 0
    ? bots.reduce((latest, bot) =>
      new Date(bot.createdAt) > new Date(latest.createdAt) ? bot : latest
    )
    : null;

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <SuccessNavbar />

      {/* 出生证明弹窗 */}
      {showBirthCert && latestBot && (
        <BirthCertificateModal
          bot={latestBot}
          onClose={() => setShowBirthCert(false)}
        />
      )}

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
              🎉 恭喜，第{bots.length}个 Hermes 创建成功！
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

            {/* Birth Certificate Preview Card */}
            {latestBot && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.5 }}
                className="lw-setup-card mb-8 w-full cursor-pointer overflow-hidden transition-all hover:shadow-md"
                onClick={() => setShowBirthCert(true)}
              >
                <div className="flex items-center gap-4 p-5">
                  {/* 龙虾头像 */}
                  <div
                    className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
                    style={{ background: "rgba(255,240,230,0.8)" }}
                  >
                    <img src={getAvatarForBot(latestBot.id)} alt="" className="h-12 w-12 object-contain" />
                  </div>

                  {/* 信息 */}
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-base font-bold" style={{ color: "var(--lw-fg)" }}>{latestBot.name}</h4>
                    <p className="mt-1 text-xs" style={{ color: "#999" }}>
                      出生于 {new Date(latestBot.createdAt).getFullYear()}年{new Date(latestBot.createdAt).getMonth() + 1}月{new Date(latestBot.createdAt).getDate()}日
                    </p>
                  </div>

                  {/* 查看出生证明按钮 */}
                  <div
                    className="flex flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold"
                    style={{ background: "rgba(230,111,98,0.08)", color: "var(--lw-accent)" }}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    出生证明
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

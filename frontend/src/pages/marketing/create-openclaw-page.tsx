import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ArrowLeft, Settings2, Sparkles } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SetupStepTimeline } from "@/components/domain/setup-step-timeline";
import { cn } from "@/lib/utils";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import type { SoulTemplate } from "@/repositories/types";
import { BrandMark } from "@/components/site/brand-mark";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { AGENTS_HOME_PATH } from "@/lib/agent-routes";

/* ─── Constants ─── */

const MAX_NAME_LENGTH = 20;
const MAX_INTRO_LENGTH = 200;

const soulTemplateEmojis: Record<string, string> = {
  gentle: "🤗",
  humor: "😄",
  pro: "💼",
};

/* ─── Animation Variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: (custom: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: custom * 0.08, duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  }),
};

/* ─── Navbar ─── */

const CreateNavbar = () => {
  const { isLoggedIn } = useOpenClaw();
  const t = useT();

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
            {t("返回首页")}
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Main Page ─── */

export const CreateOpenClawPage = () => {
  const navigate = useNavigate();
  const t = useT();
  const { isLoggedIn, login, bots, user } = useOpenClaw();
  const repositories = useRepositories();
  const [botName, setBotName] = useState("");
  const [soulTemplate, setSoulTemplate] = useState("");
  const [intro, setIntro] = useState("");
  const [nameError, setNameError] = useState(false);
  const [remoteSoulTemplates, setRemoteSoulTemplates] = useState<SoulTemplate[] | null>(null);

  const quotaExceeded = bots.length >= user.plan.maxBots;

  /* 进入创建页即触发登录态 */
  useEffect(() => {
    if (!isLoggedIn) {
      login();
    }
  }, [isLoggedIn, login]);

  /* 回退用的 SOUL 模板——名称/描述包裭 t() 以便国际化 */
  const fallbackSoulTemplates: SoulTemplate[] = useMemo(() => [
    { id: "gentle", name: t("温柔陪伴"), description: t("温暖细腻，善于倾听与安慰") },
    { id: "humor", name: t("幽默风趣"), description: t("轻松搞笑，让对话充满欢乐") },
    { id: "pro", name: t("专业干练"), description: t("高效务实，直击问题核心") },
  ], [t]);

  /* 拉取后端 SOUL 模板列表，失败时降级到本地回退 */
  useEffect(() => {
    let cancelled = false;
    repositories.bots.listSoulTemplates().then((items) => {
      if (!cancelled) setRemoteSoulTemplates(items);
    }).catch(() => {
      if (!cancelled) setRemoteSoulTemplates(fallbackSoulTemplates);
    });
    return () => { cancelled = true; };
  }, [repositories.bots, fallbackSoulTemplates]);

  /* 构造带"默认模板"选项的完整列表 */
  const soulTemplateOptions = useMemo(() => {
    const remote = remoteSoulTemplates ?? fallbackSoulTemplates;
    return [
      { id: "", name: t("默认模板"), description: t("由系统自动选择最佳模板") },
      ...remote,
    ];
  }, [remoteSoulTemplates, fallbackSoulTemplates, t]);

  const displayName = botName.trim() || t("我的Hermes");

  const previewIntro = intro.trim() || "";

  const handleBindPlan = async () => {
    if (!botName.trim()) {
      setNameError(true);
      return;
    }
    const finalName = botName.trim();
    const finalIntro = intro.trim() || "";

    const selectedSoul = soulTemplateOptions.find((opt) => opt.id === soulTemplate);
    const soulLabel = selectedSoul?.name ?? t("默认模板");
    const soulEmoji = soulTemplate ? (soulTemplateEmojis[soulTemplate] ?? "📝") : "🌟";

    /* 每次创建都走两步：先设置 → 再选套餐 */
    navigate("/subscribe", {
      state: {
        botName: finalName,
        personality: soulLabel,
        personalityEmoji: soulEmoji,
        intro: finalIntro,
        soulTemplateId: soulTemplate || undefined,
      },
    });
  };

  if (quotaExceeded) {
    return (
      <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
        <CreateNavbar />
        <main className="relative z-10 flex flex-grow items-center justify-center pb-8 pt-24">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mx-auto flex max-w-xl flex-col items-center px-6 text-center">
            <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: "rgba(230,111,98,0.06)" }}>
              <Sparkles className="h-8 w-8" style={{ color: "var(--lw-accent)" }} />
            </div>
            <h2 className="mb-4 text-xl font-bold" style={{ color: "#333" }}>{t("已达创建上限")}</h2>
            <p className="mb-10 whitespace-nowrap text-sm leading-relaxed" style={{ color: "#999" }}>{t("当前 {{plan}} 套餐最多可创建 {{max}} 个 Hermes，你已达到上限。", { plan: user.plan.name, max: user.plan.maxBots })}</p>
            <div className="flex gap-3">
              <Link to={AGENTS_HOME_PATH} className="lw-btn-primary">{t("管理我的智能体伙伴")} <ArrowRight className="h-4 w-4" /></Link>
            </div>
            <Link to="/" className="lw-back-link mt-6"><ArrowLeft className="h-3.5 w-3.5" /> {t("返回首页")}</Link>
          </motion.div>
        </main>
        <LegalFooter />
      </div>
    );
  }

  return (
    <div
      className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden"
      style={{ color: "var(--lw-fg)" }}
    >
      <CreateNavbar />

      <main className="relative z-10 flex-grow pt-24 pb-8">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 960 }}>
          {/* Step Timeline — 始终展示 2 步流程 */}
          <SetupStepTimeline currentStep="create" className="mb-10" />

          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-8 text-center"
          >
            <div className="lw-setup-pill mx-auto mb-3">
              <Sparkles className="h-3.5 w-3.5" />
              {t("第一步")}
            </div>
            <h2 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)" }}>{t("创建你的 Hermes")}</h2>
          </motion.div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
            {/* ─── Left: Configuration Form ─── */}
            <motion.div
              initial="hidden"
              animate="visible"
              variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } }}
              className="lg:col-span-3"
            >
              {/* Bot Name */}
              <motion.div custom={1} variants={fadeIn} className="mb-6">
                <label className="lw-label mb-2 flex items-center gap-1">
                  {t("昵称")} <span style={{ color: "#cf3d4c" }}>*</span>
                </label>
                <div
                  className={cn(
                    "flex items-center overflow-hidden rounded-xl border transition-all focus-within:border-[var(--lw-accent)] focus-within:shadow-[0_0_0_3px_rgba(230,111,98,0.08)]",
                    nameError && "border-[var(--lw-accent)]",
                  )}
                  style={{ borderColor: nameError ? "var(--lw-accent)" : "rgba(238,238,238,0.5)", background: "rgba(255,255,255,0.7)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}
                >
                  <input
                    type="text"
                    value={botName}
                    onChange={(e) => {
                      if (e.target.value.length <= MAX_NAME_LENGTH) {
                        setBotName(e.target.value);
                        if (nameError) setNameError(false);
                      }
                    }}
                    placeholder={t("你希望怎么称呼 TA")}
                    className="flex-1 border-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-[#999]"
                    style={{ color: "var(--lw-fg)" }}
                  />
                  <span className="pr-4 text-xs tabular-nums" style={{ color: "#999" }}>
                    {botName.length}/{MAX_NAME_LENGTH}
                  </span>
                </div>
                {nameError && (
                  <div className="mt-3 text-xs font-medium" style={{ color: "var(--lw-accent)" }}>
                    {t("请输入昵称")}
                  </div>
                )}
              </motion.div>

              {/* SOUL Template */}
              <motion.div custom={2} variants={fadeIn} className="mb-6">
                <label className="lw-label mb-2 block">{t("性格设定")}</label>
                <div className="grid grid-cols-2 gap-3">
                  {soulTemplateOptions.map((opt) => {
                    const isActive = soulTemplate === opt.id;
                    const emoji = opt.id ? (soulTemplateEmojis[opt.id] ?? "📝") : "🌟";
                    return (
                      <button
                        key={opt.id}
                        onClick={() => setSoulTemplate(opt.id)}
                        className={cn(
                          "lw-setup-card flex flex-col gap-1 px-4 py-3 text-left",
                          isActive && "lw-setup-card--active",
                        )}
                        style={{
                          background: isActive ? "rgba(230,111,98,0.06)" : "rgba(255,255,255,0.65)",
                          color: isActive ? "var(--lw-accent)" : "#555",
                        }}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <span className="text-lg">{emoji}</span>
                          <span>{opt.name}</span>
                        </span>
                        <span className="text-xs" style={{ color: isActive ? "var(--lw-accent)" : "#999", opacity: 0.85 }}>
                          {opt.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>

              {/* Intro */}
              <motion.div custom={3} variants={fadeIn} className="mb-6">
                <label className="lw-label mb-2 block">{t("简单介绍")}</label>
                <div
                  className="flex items-center overflow-hidden rounded-xl border transition-all focus-within:border-[var(--lw-accent)] focus-within:shadow-[0_0_0_3px_rgba(230,111,98,0.08)]"
                  style={{ borderColor: "rgba(238,238,238,0.5)", background: "rgba(255,255,255,0.7)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}
                >
                  <input
                    type="text"
                    value={intro}
                    onChange={(e) => {
                      if (e.target.value.length <= MAX_INTRO_LENGTH) setIntro(e.target.value);
                    }}
                    placeholder={t("一句话介绍...")}
                    className="flex-1 border-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-[#999]"
                    style={{ color: "var(--lw-fg)" }}
                  />
                  <span className="pr-4 text-xs tabular-nums" style={{ color: "#999" }}>
                    {intro.length}/{MAX_INTRO_LENGTH}
                  </span>
                </div>
              </motion.div>
            </motion.div>

            {/* ─── Right: Live Preview ─── */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="lg:col-span-2"
            >
              <div className="sticky top-24">
                <div className="lw-label mb-2">
                  {t("你的 Hermes")}
                </div>
                <div className="lw-setup-card mb-6 overflow-hidden">
                  {/* Preview Header */}
                  <div className="flex items-center gap-3.5 border-b px-5 py-4" style={{ borderColor: "rgba(238,238,238,0.4)" }}>
                    <div
                      className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
                      style={{ background: "rgba(0,0,0,0.04)" }}
                    >
                      <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png" alt="" className="h-9 w-9 object-cover" />
                    </div>
                    <div className="min-w-0">
                      <AnimatePresence mode="wait">
                        <motion.h4
                          key={displayName}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          className="truncate text-base font-bold"
                          style={{ color: "var(--lw-fg)" }}
                        >
                          {displayName}
                        </motion.h4>
                      </AnimatePresence>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={soulTemplate}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          className="mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)" }}
                        >
                          {soulTemplate ? (soulTemplateEmojis[soulTemplate] ?? "📝") : "🌟"}{" "}
                          {soulTemplateOptions.find((opt) => opt.id === soulTemplate)?.name ?? t("默认模板")}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                  </div>

                  {/* Preview Body - 龙虾身份介绍 */}
                  <div className="px-5 py-4">
                    <AnimatePresence mode="wait">
                      <motion.p
                        key={`${displayName}-${soulTemplate}-${previewIntro}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="text-sm leading-relaxed"
                        style={{ color: "#555" }}
                      >
                        {t("从现在开始我叫")}<span style={{ color: "var(--lw-accent)", fontWeight: 600 }}>{displayName}</span>，
                        {t("SOUL 模板：")}<span style={{ color: "var(--lw-accent)", fontWeight: 600 }}>{soulTemplateOptions.find((opt) => opt.id === soulTemplate)?.name ?? t("默认模板")}</span>。
                        {previewIntro && (
                          <>
                            <br />
                            <span className="mt-2 block" style={{ color: "#777" }}>{previewIntro}</span>
                          </>
                        )}
                      </motion.p>
                    </AnimatePresence>
                  </div>
                </div>

                {/* Bind Plan CTA */}
                <motion.button
                  onClick={() => void handleBindPlan()}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  className="lw-btn-primary w-full justify-center"
                >
                  <>
                    <Settings2 className="h-4 w-4" />
                    {t("下一步：订阅套餐")}
                    <ArrowRight className="h-4 w-4" />
                  </>
                </motion.button>
                <Link
                  to="/"
                  className="lw-back-link mt-3 flex justify-center"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> {t("返回首页")}
                </Link>
              </div>
            </motion.div>
          </div>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
};

import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ArrowLeft, Sparkles, Loader2 } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SetupStepTimeline } from "@/components/domain/setup-step-timeline";
import { cn } from "@/lib/utils";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useRepositories } from "@/contexts/repository-context";
import type { SoulTemplate } from "@/repositories/types";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";

/* ─── Constants ─── */

const MAX_NAME_LENGTH = 20;
const MAX_INTRO_LENGTH = 200;

const fallbackSoulTemplates: SoulTemplate[] = [
  { id: "gentle", name: "温柔陪伴", description: "温暖细腻，善于倾听与安慰" },
  { id: "humor", name: "幽默风趣", description: "轻松搞笑，让对话充满欢乐" },
  { id: "pro", name: "专业干练", description: "高效务实，直击问题核心" },
];

const soulTemplateEmojis: Record<string, string> = {
  gentle: "🤗",
  humor: "😄",
  pro: "💼",
};

/* ─── Animation Variants (Notion-style: subtle, purposeful) ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: (custom: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: custom * 0.06, duration: 0.45, ease: [0.25, 0.1, 0.25, 1] },
  }),
};

/* ─── Notion-style Navbar ─── */

const CreateNavbar = () => {
  const { isLoggedIn } = useOpenClaw();

  return (
    <header
      className="fixed left-0 right-0 top-0 z-50"
      style={{
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(12px) saturate(180%)",
        WebkitBackdropFilter: "blur(12px) saturate(180%)",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      <div className="mx-auto flex h-14 items-center justify-between px-6 md:px-8" style={{ maxWidth: 1200 }}>
        <Link to="/" className="flex items-center">
          <img
            src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5affb0c4-cfed-4614-aa34-6868d88f1717.svg"
            alt="LightClaw"
            className="object-contain"
            style={{ height: 28 }}
          />
        </Link>
        {isLoggedIn ? (
          <UserAvatarMenu />
        ) : (
          <Link
            to="/"
            className="text-sm font-medium transition-colors hover:text-[#0075de]"
            style={{ color: "rgba(0,0,0,0.65)" }}
          >
            返回首页
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Main Page ─── */

export const CreateOpenClawPage = () => {
  const navigate = useNavigate();
  const { isLoggedIn, isSubscribed, login, addBot, bots, user } = useOpenClaw();
  const repositories = useRepositories();
  const [botName, setBotName] = useState("");
  const [soulTemplate, setSoulTemplate] = useState("");
  const [intro, setIntro] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [remoteSoulTemplates, setRemoteSoulTemplates] = useState<SoulTemplate[] | null>(null);

  const quotaExceeded = bots.length >= user.plan.maxBots;
  const canDirectCreate = isSubscribed;

  useEffect(() => {
    if (!isLoggedIn) {
      login();
    }
  }, [isLoggedIn, login]);

  useEffect(() => {
    let cancelled = false;
    repositories.bots.listSoulTemplates().then((items) => {
      if (!cancelled) setRemoteSoulTemplates(items);
    }).catch(() => {
      if (!cancelled) setRemoteSoulTemplates(fallbackSoulTemplates);
    });
    return () => { cancelled = true; };
  }, [repositories.bots]);

  const soulTemplateOptions = useMemo(() => {
    const remote = remoteSoulTemplates ?? fallbackSoulTemplates;
    return [
      { id: "", name: "默认模板", description: "由系统自动选择最佳模板" },
      ...remote,
    ];
  }, [remoteSoulTemplates]);

  const displayName = botName.trim() || "龙虾宝宝";
  const previewIntro = intro.trim() || "";

  const handleBindPlan = async () => {
    if (!botName.trim()) {
      setNameError(true);
      return;
    }
    const finalName = botName.trim();
    const finalIntro = intro.trim() || "";
    const selectedSoul = soulTemplateOptions.find((t) => t.id === soulTemplate);
    const soulLabel = selectedSoul?.name ?? "默认模板";
    const soulEmoji = soulTemplate ? (soulTemplateEmojis[soulTemplate] ?? "📝") : "🌟";

    if (canDirectCreate) {
      setCreating(true);
      setError(null);
      try {
        await addBot({
          name: finalName,
          personality: soulLabel,
          personalityEmoji: soulEmoji,
          intro: finalIntro,
          soulTemplateId: soulTemplate || undefined,
          status: "running",
        });
        navigate("/openclaw/success");
      } catch (err) {
        setError(err instanceof Error ? err.message : "创建失败，请稍后重试。");
      } finally {
        setCreating(false);
      }
    } else {
      navigate("/subscribe", {
        state: {
          botName: finalName,
          personality: soulLabel,
          personalityEmoji: soulEmoji,
          intro: finalIntro,
          soulTemplateId: soulTemplate || undefined,
        },
      });
    }
  };

  /* ── Quota exceeded state ── */
  if (quotaExceeded) {
    return (
      <div className="flex min-h-screen flex-col" style={{ background: "#ffffff", color: "rgba(0,0,0,0.95)" }}>
        <CreateNavbar />
        <main className="flex flex-grow items-center justify-center px-6 pt-14">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mx-auto flex max-w-md flex-col items-center text-center">
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "#f6f5f4" }}>
              <Sparkles className="h-6 w-6" style={{ color: "#615d59" }} />
            </div>
            <h2 className="mb-3 text-xl font-bold" style={{ letterSpacing: "-0.25px" }}>已达创建上限</h2>
            <p className="mb-8 text-sm leading-relaxed" style={{ color: "#615d59" }}>
              当前 {user.plan.name} 套餐最多可创建 {user.plan.maxBots} 只龙虾，你已达到上限。
            </p>
            <Link
              to="/openclaw/settings"
              className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#005bab]"
              style={{ background: "#0075de" }}
            >
              管理我的 LightClaw <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to="/" className="mt-5 inline-flex items-center gap-1 text-sm transition-colors hover:text-[#0075de]" style={{ color: "#a39e98" }}>
              <ArrowLeft className="h-3.5 w-3.5" /> 返回首页
            </Link>
          </motion.div>
        </main>
        <LegalFooter />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "#ffffff", color: "rgba(0,0,0,0.95)" }}>
      <CreateNavbar />

      <main className="flex-grow px-6 pb-16 pt-24 md:px-8">
        <section className="mx-auto" style={{ maxWidth: 920 }}>
          {/* Step Timeline */}
          {!canDirectCreate && <SetupStepTimeline currentStep="create" className="mb-10" />}

          {/* Page Header — Notion style: tight letter-spacing, warm colors */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-10"
          >
            {!canDirectCreate && (
              <div
                className="mb-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: "#f2f9ff", color: "#097fe8", letterSpacing: "0.125px" }}
              >
                <Sparkles className="h-3 w-3" />
                第一步
              </div>
            )}
            <h1
              className="font-bold"
              style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", letterSpacing: "-0.625px", lineHeight: 1.23, color: "rgba(0,0,0,0.95)" }}
            >
              创建你的 LightClaw
            </h1>
            <p className="mt-2 text-base" style={{ color: "#615d59", lineHeight: 1.5 }}>
              为你的 AI 龙虾取个名字，选择性格，然后开始旅程。
            </p>
          </motion.div>

          <div className="grid grid-cols-1 gap-10 lg:grid-cols-5">
            {/* ─── Left: Configuration Form ─── */}
            <motion.div
              initial="hidden"
              animate="visible"
              variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.06 } } }}
              className="lg:col-span-3"
            >
              {/* Bot Name */}
              <motion.div custom={1} variants={fadeIn} className="mb-7">
                <label className="mb-2 block text-sm font-semibold" style={{ color: "rgba(0,0,0,0.95)" }}>
                  昵称 <span style={{ color: "#dd5b00" }}>*</span>
                </label>
                <div
                  className={cn(
                    "flex items-center overflow-hidden rounded-lg transition-all",
                    nameError ? "ring-2 ring-[#dd5b00]/20" : "focus-within:ring-2 focus-within:ring-[#0075de]/20",
                  )}
                  style={{
                    border: nameError ? "1px solid #dd5b00" : "1px solid rgba(0,0,0,0.1)",
                    background: "#ffffff",
                  }}
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
                    placeholder="你希望怎么称呼 TA"
                    className="flex-1 border-none bg-transparent px-4 py-3 text-sm outline-none"
                    style={{ color: "rgba(0,0,0,0.9)", fontWeight: 400 }}
                  />
                  <span className="pr-4 text-xs tabular-nums" style={{ color: "#a39e98" }}>
                    {botName.length}/{MAX_NAME_LENGTH}
                  </span>
                </div>
                {nameError && (
                  <p className="mt-2 text-xs font-medium" style={{ color: "#dd5b00" }}>请输入昵称</p>
                )}
              </motion.div>

              {/* SOUL Template */}
              <motion.div custom={2} variants={fadeIn} className="mb-7">
                <label className="mb-2 block text-sm font-semibold" style={{ color: "rgba(0,0,0,0.95)" }}>性格设定</label>
                <div className="grid grid-cols-2 gap-3">
                  {soulTemplateOptions.map((t) => {
                    const isActive = soulTemplate === t.id;
                    const emoji = t.id ? (soulTemplateEmojis[t.id] ?? "📝") : "🌟";
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSoulTemplate(t.id)}
                        className="flex flex-col gap-1.5 rounded-xl px-4 py-3.5 text-left transition-all"
                        style={{
                          border: isActive ? "1.5px solid #0075de" : "1px solid rgba(0,0,0,0.1)",
                          background: isActive ? "#f2f9ff" : "#ffffff",
                          boxShadow: isActive
                            ? "rgba(0,117,222,0.08) 0px 0px 0px 3px"
                            : "rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px",
                        }}
                      >
                        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: isActive ? "#0075de" : "rgba(0,0,0,0.95)" }}>
                          <span className="text-base">{emoji}</span>
                          <span>{t.name}</span>
                        </span>
                        <span className="text-xs" style={{ color: isActive ? "#0075de" : "#615d59" }}>
                          {t.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>

              {/* Intro */}
              <motion.div custom={3} variants={fadeIn} className="mb-7">
                <label className="mb-2 block text-sm font-semibold" style={{ color: "rgba(0,0,0,0.95)" }}>简单介绍</label>
                <div
                  className="flex items-center overflow-hidden rounded-lg transition-all focus-within:ring-2 focus-within:ring-[#0075de]/20"
                  style={{ border: "1px solid rgba(0,0,0,0.1)", background: "#ffffff" }}
                >
                  <input
                    type="text"
                    value={intro}
                    onChange={(e) => {
                      if (e.target.value.length <= MAX_INTRO_LENGTH) setIntro(e.target.value);
                    }}
                    placeholder="一句话介绍..."
                    className="flex-1 border-none bg-transparent px-4 py-3 text-sm outline-none"
                    style={{ color: "rgba(0,0,0,0.9)" }}
                  />
                  <span className="pr-4 text-xs tabular-nums" style={{ color: "#a39e98" }}>
                    {intro.length}/{MAX_INTRO_LENGTH}
                  </span>
                </div>
              </motion.div>
            </motion.div>

            {/* ─── Right: Live Preview (Notion card style) ─── */}
            <motion.div
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="lg:col-span-2"
            >
              <div className="sticky top-20">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider" style={{ color: "#a39e98" }}>
                  实时预览
                </p>
                <div
                  className="overflow-hidden rounded-xl"
                  style={{
                    border: "1px solid rgba(0,0,0,0.1)",
                    background: "#ffffff",
                    boxShadow: "rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px, rgba(0,0,0,0.01) 0px 0.175px 1.04px",
                  }}
                >
                  {/* Preview Header */}
                  <div
                    className="flex items-center gap-3 px-5 py-4"
                    style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: "#f6f5f4" }}>
                      <img
                        src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png"
                        alt=""
                        className="h-8 w-8 object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <AnimatePresence mode="wait">
                        <motion.h4
                          key={displayName}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          className="truncate text-sm font-bold"
                          style={{ color: "rgba(0,0,0,0.95)", letterSpacing: "-0.25px" }}
                        >
                          {displayName}
                        </motion.h4>
                      </AnimatePresence>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={soulTemplate}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: "#f2f9ff", color: "#097fe8", letterSpacing: "0.125px" }}
                        >
                          {soulTemplate ? (soulTemplateEmojis[soulTemplate] ?? "📝") : "🌟"}{" "}
                          {soulTemplateOptions.find((t) => t.id === soulTemplate)?.name ?? "默认模板"}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                  </div>

                  {/* Preview Body */}
                  <div className="px-5 py-4">
                    <AnimatePresence mode="wait">
                      <motion.p
                        key={`${displayName}-${soulTemplate}-${previewIntro}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="text-sm leading-relaxed"
                        style={{ color: "#615d59" }}
                      >
                        从现在开始我叫
                        <span style={{ color: "#0075de", fontWeight: 600 }}>{displayName}</span>，SOUL 模板：
                        <span style={{ color: "#0075de", fontWeight: 600 }}>
                          {soulTemplateOptions.find((t) => t.id === soulTemplate)?.name ?? "默认模板"}
                        </span>
                        。
                        {previewIntro && (
                          <>
                            <br />
                            <span className="mt-1.5 block" style={{ color: "#a39e98" }}>{previewIntro}</span>
                          </>
                        )}
                      </motion.p>
                    </AnimatePresence>
                  </div>
                </div>

                {/* CTA Button — Notion Blue */}
                {error && (
                  <p
                    className="mt-4 rounded-lg px-4 py-2.5 text-center text-sm font-medium"
                    style={{ background: "rgba(221,91,0,0.06)", color: "#dd5b00" }}
                  >
                    {error}
                  </p>
                )}
                <motion.button
                  onClick={() => void handleBindPlan()}
                  disabled={creating}
                  whileHover={{ scale: creating ? 1 : 1.005 }}
                  whileTap={{ scale: creating ? 1 : 0.995 }}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60"
                  style={{ background: "#0075de" }}
                  onMouseEnter={(e) => { if (!creating) (e.currentTarget as HTMLButtonElement).style.background = "#005bab"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#0075de"; }}
                >
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      创建中...
                    </>
                  ) : canDirectCreate ? (
                    <>
                      创建 LightClaw
                      <ArrowRight className="h-4 w-4" />
                    </>
                  ) : (
                    <>
                      下一步：订阅套餐
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </motion.button>
                <Link
                  to="/"
                  className="mt-3 flex items-center justify-center gap-1 text-sm transition-colors hover:text-[#0075de]"
                  style={{ color: "#a39e98" }}
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> 返回首页
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

import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  MessageCircle,
  Loader2,
  Calendar,
  Mail,
  Database,
  Sparkles,
  ExternalLink,
  X,
  ScanLine,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/site/brand-mark";
import { SetupStepTimeline } from "@/components/domain/setup-step-timeline";

/* ─── Types ─── */

type Channel = "wechat" | "qq" | null;
type SetupStep = "channel" | "persona";
type PersonaId = "jarvis" | "luna" | "spark";

interface Persona {
  id: PersonaId;
  name: string;
  nameEn: string;
  desc: string;
  icon: string;
  skills: { name: string; desc: string; icon: React.ReactNode }[];
}

/* ─── Data ─── */

const personas: Persona[] = [
  {
    id: "jarvis",
    name: "贾维斯",
    nameEn: "Jarvis",
    desc: "冷静理性的全能AI管家，高效精准地完成每一项任务",
    icon: "🤖",
    skills: [
      { name: "Task Schedule", desc: "智能日程管理与任务调度，自动规划每日待办并发送提醒", icon: <Calendar className="h-5 w-5" /> },
      { name: "Email Assistant", desc: "邮件智能撰写，分类归档与定时发送", icon: <Mail className="h-5 w-5" /> },
      { name: "Data Pipeline", desc: "ETL 数据管道自动化，多源数据聚合清洗与报表生成", icon: <Database className="h-5 w-5" /> },
    ],
  },
  {
    id: "luna",
    name: "露娜",
    nameEn: "Luna",
    desc: "温柔体贴的月光精灵，用温柔话语治愈你的每一天",
    icon: "🌙",
    skills: [
      { name: "Task Schedule", desc: "智能日程管理与任务调度，自动规划每日待办并发送提醒", icon: <Calendar className="h-5 w-5" /> },
      { name: "Email Assistant", desc: "邮件智能撰写，分类归档与定时发送", icon: <Mail className="h-5 w-5" /> },
      { name: "Data Pipeline", desc: "ETL 数据管道自动化，多源数据聚合清洗与报表生成", icon: <Database className="h-5 w-5" /> },
    ],
  },
  {
    id: "spark",
    name: "火花",
    nameEn: "Spark",
    desc: "充满激情的创意伙伴，总能带来意想不到的灵感碰撞",
    icon: "🔥",
    skills: [
      { name: "Task Schedule", desc: "智能日程管理与任务调度，自动规划每日待办并发送提醒", icon: <Calendar className="h-5 w-5" /> },
      { name: "Email Assistant", desc: "邮件智能撰写，分类归档与定时发送", icon: <Mail className="h-5 w-5" /> },
      { name: "Data Pipeline", desc: "ETL 数据管道自动化，多源数据聚合清洗与报表生成", icon: <Database className="h-5 w-5" /> },
    ],
  },
];

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] } },
};

const slideIn = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] } },
  exit: { opacity: 0, x: -40, transition: { duration: 0.3 } },
};

/* ─── Shared Navbar ─── */

const SetupNavbar = () => (
  <header className="lw-setup-navbar">
    <div className="mx-auto flex items-center justify-between px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>
        <BrandMark to="/" />
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
    </div>
  </header>
);

/* ─── Channel Step ─── */

const ChannelStep = ({
  onComplete,
  onSkip,
  onBack,
}: {
  onComplete: (channel: Channel) => void;
  onSkip: () => void;
  onBack: () => void;
}) => {
  const [selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [showQrModal, setShowQrModal] = useState(false);

  const handleWechatAuth = () => {
    setShowQrModal(true);
  };

  const handleQrScanComplete = () => {
    setShowQrModal(false);
    setSubmitting(true);
    setTimeout(() => {
      setSuccessMsg("现在，你可以在微信中与龙虾对话啦！");
      setTimeout(() => onComplete("wechat"), 1500);
    }, 800);
  };

  const handleQqSubmit = () => {
    if (!qqAppId.trim() || !qqAppSecret.trim()) return;
    setSubmitting(true);
    setTimeout(() => {
      setSuccessMsg("现在，你可以在QQ中与龙虾对话啦！");
      setTimeout(() => onComplete("qq"), 1500);
    }, 800);
  };

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="visible">
      <div className="mb-8 text-center">
        <div className="lw-setup-pill mx-auto mb-3">
          <MessageCircle className="h-3.5 w-3.5" />
          接入通道
        </div>
        <h2 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)" }}>
          你希望使用哪个通道与龙虾聊天？
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          选择一个即时通讯平台接入你的龙虾
        </p>
      </div>

      {/* WeChat QR Code Modal */}
      <AnimatePresence>
        {showQrModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => setShowQrModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-[var(--shadow-soft)]"
              style={{ background: "rgba(255,255,255,0.95)", borderColor: "rgba(0,0,0,0.06)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close button */}
              <button
                onClick={() => setShowQrModal(false)}
                className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--lw-bg-secondary)] text-[var(--text-tertiary)]"
              >
                <X className="h-4 w-4" />
              </button>

              {/* Icon */}
              <div
                className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl"
                style={{ background: "rgba(7,193,96,0.08)" }}
              >
                <ScanLine className="h-6 w-6" style={{ color: "#07C160" }} />
              </div>

              {/* Title */}
              <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>
                微信扫码接入
              </h3>
              <p className="mb-5 text-center text-sm leading-relaxed text-[var(--text-secondary)]">
                更新微信至最新版本，"扫一扫"完成接入
              </p>

              {/* QR Code placeholder */}
              <div
                className="mb-5 flex h-48 w-48 items-center justify-center rounded-xl border-2 border-dashed"
                style={{ borderColor: "rgba(0,0,0,0.08)", background: "rgba(250,250,250,0.6)" }}
              >
                <div className="flex flex-col items-center gap-2">
                  <img
                    src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=https://lightclaw.ai/wechat-auth"
                    alt="微信扫码"
                    className="h-40 w-40 rounded-lg"
                  />
                </div>
              </div>

              {/* Scan complete button */}
              <button
                onClick={handleQrScanComplete}
                className="lw-btn-primary w-full"
              >
                <Check className="h-4 w-4" /> 完成扫码
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Success overlay */}
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mx-auto mb-6 flex max-w-md items-center gap-3 rounded-2xl border-2 p-4"
            style={{ borderColor: "var(--lw-accent)", background: "rgba(230,111,98,0.03)", boxShadow: "0 8px 32px rgba(230,111,98,0.08)" }}
          >
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--lw-accent)" }}>
              <Check className="h-4 w-4 text-white" />
            </div>
            <p className="text-sm font-semibold" style={{ color: "var(--lw-accent)" }}>{successMsg}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {!successMsg && (
        <div className="mx-auto grid max-w-xl grid-cols-1 gap-5 md:grid-cols-2">
          {/* WeChat Card - 暂未开放，置灰处理 */}
          <button
            disabled
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-3 p-7 text-center",
              "pointer-events-none opacity-40 grayscale cursor-not-allowed",
            )}
          >
            <div className="lw-setup-icon-container flex h-14 w-14 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.06)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-9 w-9 object-contain" />
            </div>
            <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>微信</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">即将开放</p>
          </button>

          {/* QQ Card */}
          <button
            onClick={() => setSelectedChannel("qq")}
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-3 p-7 text-center",
              selectedChannel === "qq" && "lw-setup-card--active"
            )}
          >
            <div className="lw-setup-icon-container flex h-14 w-14 items-center justify-center rounded-xl" style={{ background: "rgba(18,183,245,0.06)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-9 w-9 object-contain" />
            </div>
            <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>QQ</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">通过QQ机器人与龙虾对话</p>
            {selectedChannel === "qq" && (
              <div className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full shadow-[var(--shadow-soft)]" style={{ background: "var(--lw-accent)" }}>
                <Check className="h-3.5 w-3.5 text-white" />
              </div>
            )}
          </button>
        </div>
      )}

      {/* Action area for selected channel */}
      <AnimatePresence mode="wait">
        {selectedChannel === "wechat" && !successMsg && (
          <motion.div
            key="wechat-action"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mx-auto mt-6 max-w-md text-center"
          >
            <button
              onClick={handleWechatAuth}
              disabled={submitting}
              className="lw-btn-primary disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> 授权中...
                </>
              ) : (
                <>
                  前往授权 <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </motion.div>
        )}

        {selectedChannel === "qq" && !successMsg && (
          <motion.div
            key="qq-action"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="mx-auto mt-6 max-w-md space-y-3"
          >
            <div>
              <label className="lw-label mb-1.5 block">
                QQ机器人的App ID
              </label>
              <input
                type="text"
                value={qqAppId}
                onChange={(e) => setQqAppId(e.target.value)}
                placeholder="请输入 App ID"
                className="lw-input"
              />
            </div>
            <div>
              <label className="lw-label mb-1.5 block">
                QQ机器人的App Secret
              </label>
              <input
                type="password"
                value={qqAppSecret}
                onChange={(e) => setQqAppSecret(e.target.value)}
                placeholder="请输入 App Secret"
                className="lw-input"
              />
            </div>
            <button
              onClick={handleQqSubmit}
              disabled={submitting || !qqAppId.trim() || !qqAppSecret.trim()}
              className="lw-btn-primary w-full disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> 添加中...
                </>
              ) : (
                <>
                  添加并应用 <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
            {/* QQ 查看详情链接 */}
            <div className="pt-1 text-center">
              <a
                href="https://q.qq.com/qqbot/openclaw/login.html"
                target="_blank"
                rel="noopener noreferrer"
                className="lw-back-link"
              >
                查看详情 <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom actions: skip & back */}
      {!successMsg && (
        <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-2.5">
          <button onClick={onSkip} className="lw-skip-link">
            跳过，直接在 LightVela 与龙虾对话
          </button>
          <button onClick={onBack} className="lw-back-link">
            <ArrowLeft className="h-3.5 w-3.5" /> 返回上一步
          </button>
        </div>
      )}
    </motion.div>
  );
};

/* ─── Persona Selection Step ─── */

const PersonaSelectView = ({
  onSelect,
  onSkip,
  onBack,
}: {
  onSelect: (persona: Persona) => void;
  onSkip: () => void;
  onBack: () => void;
}) => (
  <motion.div variants={fadeIn} initial="hidden" animate="visible">
    <div className="mb-8 text-center">
      <div className="lw-setup-pill mx-auto mb-3">
        <Sparkles className="h-3.5 w-3.5" />
        配置技能
      </div>
      <h2 style={{ fontSize: "clamp(1.375rem, 3vw, 1.75rem)" }}>
        选择一个技能专家，让你的龙虾技能增强
      </h2>
    </div>

    <div className="mx-auto grid max-w-2xl grid-cols-1 gap-5 md:grid-cols-3">
      {personas.map((persona) => (
        <button
          key={persona.id}
          onClick={() => onSelect(persona)}
          className="lw-setup-card group flex flex-col items-center gap-3 p-6 text-center"
        >
          <div className="lw-setup-icon-container flex h-14 w-14 items-center justify-center rounded-xl text-2xl">
            {persona.icon}
          </div>
          <div>
            <h3 className="text-base font-bold" style={{ color: "var(--lw-fg)" }}>
              {persona.name} <span className="font-normal text-[var(--text-tertiary)]">{persona.nameEn}</span>
            </h3>
          </div>
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{persona.desc}</p>
        </button>
      ))}
    </div>

    <div className="mt-8 flex flex-col items-center gap-2">
      <button onClick={onSkip} className="lw-skip-link">
        略过此步
      </button>
      <button onClick={onBack} className="lw-back-link">
        <ArrowLeft className="h-3.5 w-3.5" /> 返回上一步
      </button>
    </div>
  </motion.div>
);

/* ─── Persona Confirm View (shows skills) ─── */

const PersonaConfirmView = ({
  persona,
  onInstall,
  onBack,
}: {
  persona: Persona;
  onInstall: () => void;
  onBack: () => void;
}) => (
  <motion.div {...slideIn} className="mx-auto max-w-lg">
    <div className="mb-6 text-center">
      <div className="mx-auto mb-3 lw-setup-icon-container h-14 w-14 rounded-xl text-2xl">
        {persona.icon}
      </div>
      <h2 style={{ fontSize: "clamp(1.25rem, 2.5vw, 1.5rem)" }}>
        {persona.name} {persona.nameEn}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
        该专家已为你预装以下 Agent Skills，开箱即用。
      </p>
    </div>

    <div className="space-y-3">
      {persona.skills.map((skill, idx) => (
        <motion.div
          key={idx}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.1 }}
          className="lw-setup-card flex items-start gap-3.5 p-4"
        >
          <div className="lw-setup-icon-container flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl">
            {skill.icon}
          </div>
          <div>
            <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{skill.name}</h4>
            <p className="mt-0.5 text-sm leading-relaxed text-[var(--text-secondary)]">{skill.desc}</p>
          </div>
        </motion.div>
      ))}
    </div>

    <div className="mt-8 flex flex-col items-center gap-2.5">
      <button onClick={onInstall} className="lw-btn-primary">
        开始安装 <Sparkles className="h-4 w-4" />
      </button>
      <button onClick={onBack} className="lw-back-link">
        <ArrowLeft className="h-3.5 w-3.5" /> 返回重新选择
      </button>
    </div>
  </motion.div>
);

/* ─── Installation Progress View ─── */

const InstallProgressView = ({ persona, onComplete }: { persona: Persona; onComplete: () => void }) => {
  const [progress, setProgress] = useState(0);
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const personaLabel = `${persona.name}${persona.nameEn}`;

  const progressSteps = [
    `配置技能专家·${personaLabel}`,
    "安装 Agent Skills（3个）",
    "验证并启动服务",
  ];

  useEffect(() => {
    if (completed) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = prev + Math.random() * 3 + 1;
        if (next >= 100) {
          clearInterval(interval);
          setCompleted(true);
          return 100;
        }
        if (next >= 70) setCurrentStepIdx(2);
        else if (next >= 30) setCurrentStepIdx(1);
        else setCurrentStepIdx(0);
        return next;
      });
    }, 120);

    return () => clearInterval(interval);
  }, [completed]);

  const handleComplete = useCallback(() => {
    setShowSuccess(true);
  }, []);

  return (
    <motion.div {...slideIn} className="mx-auto max-w-md text-center">
      {/* Success Alert */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              className="mx-4 flex max-w-sm flex-col items-center gap-5 rounded-[1.75rem] border p-8 shadow-[var(--shadow-soft)]"
              style={{ background: "rgba(255,255,255,0.95)", borderColor: "rgba(0,0,0,0.06)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)" }}
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: "rgba(230,111,98,0.06)" }}>
                <Check className="h-7 w-7" style={{ color: "var(--lw-accent)" }} />
              </div>
              <div className="text-center">
                <h3 className="mb-1.5 text-xl font-bold" style={{ color: "var(--lw-fg)" }}>
                  你的{personaLabel}已就绪
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  开始对话吧！
                </p>
              </div>
              <button
                onClick={onComplete}
                className="lw-btn-primary"
              >
                开始使用 <ArrowRight className="h-4 w-4" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mb-6">
        <div className="mx-auto mb-3 lw-setup-icon-container h-14 w-14 rounded-xl text-2xl">
          {persona.icon}
        </div>
        <h2 style={{ fontSize: "clamp(1.25rem, 2.5vw, 1.5rem)" }}>
          正在安装 {personaLabel}
        </h2>
        <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
          请稍候，正在为你配置龙虾...
        </p>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-bold" style={{ color: "var(--lw-fg)" }}>安装进度</span>
          <span className="text-xs font-bold" style={{ color: "var(--lw-accent)" }}>{Math.round(progress)}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.04)" }}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: "linear-gradient(90deg, var(--lw-accent), #f0a878)" }}
            initial={{ width: "0%" }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.3, ease: "linear" }}
          />
        </div>
      </div>

      {/* Step list */}
      <div className="space-y-2.5 text-left">
        {progressSteps.map((step, idx) => (
          <div
            key={idx}
            className={cn(
              "lw-setup-card flex items-center gap-3 px-4 py-3 transition-all duration-300",
              idx < currentStepIdx && "!border-[rgba(230,111,98,0.15)] !bg-[rgba(230,111,98,0.04)]",
              idx === currentStepIdx && "!border-[var(--lw-accent)] !bg-[rgba(255,255,255,0.96)]",
              idx > currentStepIdx && "opacity-50"
            )}
            style={idx === currentStepIdx ? { boxShadow: "0 4px 16px rgba(230,111,98,0.1)" } : {}}
          >
            {idx < currentStepIdx ? (
              <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full" style={{ background: "var(--lw-accent)" }}>
                <Check className="h-3 w-3 text-white" />
              </div>
            ) : idx === currentStepIdx ? (
              <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" style={{ color: "var(--lw-accent)" }} />
            ) : (
              <div className="h-5 w-5 flex-shrink-0 rounded-full border-[1.5px]" style={{ borderColor: "rgba(0,0,0,0.12)" }} />
            )}
            <span className="text-sm font-semibold" style={{ color: idx <= currentStepIdx ? "var(--lw-fg)" : "#999" }}>
              {step}
            </span>
          </div>
        ))}
      </div>

      {/* Complete button */}
      {completed && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-8">
          <button onClick={handleComplete} className="lw-btn-primary">
            开始使用 <ArrowRight className="h-4 w-4" />
          </button>
        </motion.div>
      )}
    </motion.div>
  );
};

/* ─── Main Setup Page ─── */

export const OpenClawSetupPage = () => {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<SetupStep>("channel");
  const [_selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [personaView, setPersonaView] = useState<"select" | "confirm" | "install" | "done">("select");

  const handleChannelComplete = (channel: Channel) => {
    setSelectedChannel(channel);
    setCurrentStep("persona");
  };

  const handleChannelSkip = () => {
    navigate("/");
  };

  const handleChannelBack = () => {
    navigate("/subscribe");
  };

  const handlePersonaSelect = (persona: Persona) => {
    setSelectedPersona(persona);
    setPersonaView("confirm");
  };

  const handlePersonaSkip = () => {
    setPersonaView("done");
  };

  const handlePersonaBack = () => {
    setCurrentStep("channel");
  };

  const handleInstall = () => {
    setPersonaView("install");
  };

  const handleInstallComplete = () => {
    setPersonaView("done");
  };

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <SetupNavbar />

      <main className="relative z-10 flex-grow pt-24 pb-8">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>
          {/* Step Timeline */}
          <SetupStepTimeline
            currentStep={currentStep === "channel" ? "create" : "subscribe"}
            className="mb-10"
          />

          {/* Step Content */}
          <AnimatePresence mode="wait">
            {currentStep === "channel" && (
              <motion.div key="channel" {...slideIn}>
                <ChannelStep
                  onComplete={handleChannelComplete}
                  onSkip={handleChannelSkip}
                  onBack={handleChannelBack}
                />
              </motion.div>
            )}

            {currentStep === "persona" && personaView === "select" && (
              <motion.div key="persona-select" {...slideIn}>
                <PersonaSelectView
                  onSelect={handlePersonaSelect}
                  onSkip={handlePersonaSkip}
                  onBack={handlePersonaBack}
                />
              </motion.div>
            )}

            {currentStep === "persona" && personaView === "confirm" && selectedPersona && (
              <motion.div key="persona-confirm" {...slideIn}>
                <PersonaConfirmView
                  persona={selectedPersona}
                  onInstall={handleInstall}
                  onBack={() => setPersonaView("select")}
                />
              </motion.div>
            )}

            {currentStep === "persona" && personaView === "install" && selectedPersona && (
              <motion.div key="persona-install" {...slideIn}>
                <InstallProgressView
                  persona={selectedPersona}
                  onComplete={handleInstallComplete}
                />
              </motion.div>
            )}

            {personaView === "done" && (
              <motion.div key="done" {...slideIn} className="mx-auto max-w-md text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl text-3xl" style={{ background: "rgba(230,111,98,0.06)" }}>
                  🦞
                </div>
                <h2 className="mb-2" style={{ fontSize: "clamp(1.25rem, 2.5vw, 1.5rem)" }}>
                  配置完成！
                </h2>
                <p className="mb-6 text-sm text-[var(--text-secondary)]">
                  你的龙虾已准备就绪，快去体验吧
                </p>
                <Link to="/" className="lw-btn-primary">
                  返回首页 <ArrowRight className="h-4 w-4" />
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
};

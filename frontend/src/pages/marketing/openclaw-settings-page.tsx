// ⚠️ 必须最先 import：本模块在加载时同步完成两件事：
//   1. 设置 `window.VERSION = "en"`（tea-app i18n 模块加载时据此决定 lng）
//   2. 同步调用 SDK 的 `initI18n({ translation })` 注入词条
// 这两步必须在任何 SDK 组件渲染之前完成，否则 SDK 内部的模块级缓存
// （如 `cachedI18nList`、`MODEL_PROVIDER_LIST` 首次访问）会在 i18next
// 未 init 状态下调用 t() 得到 undefined，被 ChannelPanel 的过滤逻辑剔除。
// 语言由 @/lib/region 的 isGlobal + localStorage('lw-locale') 决定。
import "@/lib/i18n-env";

import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  BrainCircuit,
  ChevronDown,
  Check,
  MessageCircle,
  MessageSquare,
  Loader2,
  Calendar,
  Mail,
  Database,
  Sparkles,
  ExternalLink,
  X,
  ScanLine,
  AlertTriangle,
  Crown,
  TerminalSquare,
  Download,
  Plus,
  Trash2,
  UserRound,
  Wand2,
  Wrench,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/asset-url";
import { useOpenClaw, type OpenClawBot } from "@/contexts/openclaw-context";
import { useRepositories } from "@/contexts/repository-context";
import type { TencentPtyClient, TencentPtyConnectionState } from "@/lib/tencent-pty-client";
import { BrandMark } from "@/components/site/brand-mark";
import { LanguageSwitcher } from "@/components/site/language-switcher";
import { useT, t as rawT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { useSession } from "@/contexts/session-context";
import { avatarImageUrl } from "@/lib/avatar-image";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import {
  ModelPanel,
  ChannelPanel,
  SkillPanel,
  createLighthouseConfig,
  createLightClawScripts,
  type IInstanceInfo,
  type IFeatureFlags,
  type IProductConfig,
} from "@tencent/tea-sdk-lightclaw";
import { createMonoDebugExecAdapter } from "@/pages/marketing/openclaw-tat-adapter";
import { createLightVelaCommandExecutor } from "@/pages/marketing/openclaw-command-executor";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/openclaw-console-helpers";
import { BuddyPanel } from "@/pages/marketing/openclaw-buddy-panel";
import { findCompletedCreatingBot, getOpenClawCreateLimitMessage } from "@/pages/marketing/openclaw-create-availability";
import {
  getRestartBlockReason,
  isActiveBotRestarting as computeIsActiveBotRestarting,
  getActiveBotRestartError,
  buildRestartErrorMessage,
  setErrorForBot,
  clearErrorForBot,
  type RestartErrors,
} from "@/pages/marketing/openclaw-restart-gateway";
import {
  getResetBlockReason,
  hermesModelName,
  hermesSwitchModelFullId,
  isExecCommandSucceeded,
  truncateExecOutput,
  RESET_BLOCK_REASON,
} from "@/pages/marketing/openclaw-reset-config";
import { toast } from "@/lib/toast";
import "@tencent/tea-sdk-lightclaw/styles";
// LightVela 对话面板（npm 包 @tencent/agentchat-lightvela-panel@0.2.5-beta.0）
import { LightVelaPanel } from "@tencent/agentchat-lightvela-panel";

/* ─── Types ─── */

type Channel = "wechat" | "qq" | null;
type ConnectedChannel = Exclude<Channel, null>;
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

// 工厂函数：在调用时才读取 i18n 词条，避免模块加载顺序问题
function makePersonas(): Persona[] {
  const taskSchedule = {
    name: "Task Schedule",
    desc: rawT("智能日程管理与任务调度，自动规划每日待办并发送提醒"),
    icon: <Calendar className="h-5 w-5" />,
  };
  const emailAssistant = {
    name: "Email Assistant",
    desc: rawT("邮件智能撰写，分类归档与定时发送"),
    icon: <Mail className="h-5 w-5" />,
  };
  const dataPipeline = {
    name: "Data Pipeline",
    desc: rawT("ETL 数据管道自动化，多源数据聚合清洗与报表生成"),
    icon: <Database className="h-5 w-5" />,
  };
  return [
    {
      id: "jarvis",
      name: rawT("贾维斯"),
      nameEn: "Jarvis",
      desc: rawT("冷静理性的全能AI管家，高效精准地完成每一项任务"),
      icon: "🤖",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
    {
      id: "luna",
      name: rawT("露娜"),
      nameEn: "Luna",
      desc: rawT("温柔体贴的月光精灵，用温柔话语治愈你的每一天"),
      icon: "🌙",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
    {
      id: "spark",
      name: rawT("火花"),
      nameEn: "Spark",
      desc: rawT("充满激情的创意伙伴，总能带来意想不到的灵感碰撞"),
      icon: "🔥",
      skills: [taskSchedule, emailAssistant, dataPipeline],
    },
  ];
}

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 24, filter: "blur(4px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

const _staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.15, delayChildren: 0.1 } },
};
void _staggerContainer;

/* ─── Navbar ─── */

const SettingsNavbar = () => {
  const { isAuthenticated: isLoggedIn } = useSession();
  const t = useT();
  return (
    <header
      className="lw-fixed-top fixed inset-x-0 z-50 border-b border-black/5 bg-white/90 backdrop-blur-[20px]"
    >
      <div className="lw-settings-topbar-inner flex h-[60px] items-center justify-between px-6 md:px-[80px]">
        <BrandMark to="/" />
        <div className="flex items-center gap-3">
          {/* 语言切换器：仅国际站展示。
              ⚠️ settings 页内嵌 @tencent/tea-sdk-lightclaw（基于 tea-app i18n），
              而 tea-app i18n 是 init-once 设计，运行时无法热切换 lng；
              因此切换语言后必须刷新页面才能让 SDK 区域同步更新文案。 */}
          {isGlobal && <LanguageSwitcher reloadAfterSwitch />}
          <Link
            to="/"
            className="inline-flex items-center justify-center h-[36px] px-5 bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium"
          >
            {t("返回首页")}
          </Link>
          {isLoggedIn && <UserAvatarMenu />}
        </div>
      </div>
    </header>
  );
};

/* ─── 实例配置子页面类型（通道 / 模型 / 技能 / 人设 / 对话，放在单个 bot 内部切换） ─── */

type SettingsSectionId = "channel" | "model" | "skill" | "buddy" | "chat";

/* ─── Section Card Wrapper ─── */

export const _SectionCard = ({ title, icon, headerRight, children }: { title: string; icon: React.ReactNode; headerRight?: React.ReactNode; children: React.ReactNode }) => {
  if (isGlobal) return null;
  return (
    <motion.div
      variants={fadeIn}
      className="overflow-hidden rounded-2xl"
      style={{
        border: "1px solid rgba(0,0,0,0.06)",
        background: "#ffffff",
        boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
      }}
    >
      <div className="flex items-center gap-3 px-6 py-4" style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
        <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: "rgba(0,0,0,0.04)", color: "rgba(0,0,0,0.90)" }}>
          {icon}
        </div>
        <h3 className="flex-1 text-base font-semibold" style={{ color: "rgba(0,0,0,0.90)", letterSpacing: "-0.2px" }}>{title}</h3>
        {headerRight}
      </div>
      <div className="p-6">
        {children}
      </div>
    </motion.div>
  );
}

/* ─── Delete Confirm Dialog ─── */

export const _DeleteConfirmDialog = ({ botName, onConfirm, onCancel }: { botName: string; onConfirm: () => void; onCancel: () => void }) => {
  const t = useT();
  if (isGlobal) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
        style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(207,61,76,0.08)" }}>
          <AlertTriangle className="h-6 w-6" style={{ color: "#cf3d4c" }} />
        </div>
        <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("确认删除")}</h3>
        <p className="mb-6 text-center text-sm leading-relaxed text-[var(--text-secondary)]">
          {t("确定要删除龙虾 {{name}} 吗？此操作不可撤销。", { name: `"${botName}"` })}
        </p>
        <div className="flex w-full gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}
          >
            {t("取消")}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-full px-4 py-2.5 text-sm font-bold text-white transition-colors hover:opacity-90"
            style={{ background: "#cf3d4c" }}
          >
            {t("确认删除")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Limit Reached Dialog ─── */

export const _LimitReachedDialog = ({ maxBots, planName, onClose }: { maxBots: number; planName: string; onClose: () => void }) => {
  const t = useT();
  if (isGlobal) return null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
        style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(230,111,98,0.08)" }}>
          <Crown className="h-6 w-6" style={{ color: "var(--lw-accent)" }} />
        </div>
        <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("已达创建上限")}</h3>
        <p className="mb-2 text-center text-sm leading-relaxed text-[var(--text-secondary)]">
          {t("当前 {{plan}} 套餐最多可创建 {{max}} 只龙虾，你已达到上限。", { plan: planName, max: String(maxBots) })}
        </p>
        <div className="flex w-full gap-3" style={{ marginTop: 25 }}>
          <button
            onClick={onClose}
            className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}
          >
            {t("我知道了")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Channel Section ─── */

type WeixinSessionStatus = "idle" | "creating" | "starting" | "waiting_qr" | "scanned" | "success" | "failed" | "expired" | "cancelled" | "timeout";

export const ChannelSection = () => {
  const t = useT();
  const repositories = useRepositories();
  const { bots, updateBot } = useOpenClaw();
  const configurableBots = useMemo(
    () => bots.filter((bot) => bot.status !== "provisioning" && bot.status !== "deleting"),
    [bots],
  );
  const [selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [qqAccount, setQqAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);

  /* ── WeChat login session state ── */
  const [showQrModal, setShowQrModal] = useState(false);
  const [wxSessionId, setWxSessionId] = useState("");
  const [wxStatus, setWxStatus] = useState<WeixinSessionStatus>("idle");
  const [wxQrUrl, setWxQrUrl] = useState("");
  const [wxError, setWxError] = useState<string | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);

  const selectedBot = configurableBots.find((bot) => bot.id === selectedBotId) ?? null;
  const connectedChannels: ConnectedChannel[] = selectedBot?.connectedChannels ?? [];

  useEffect(() => {
    if (!configurableBots.length) {
      setSelectedBotId("");
      return;
    }

    if (!selectedBotId || !configurableBots.some((bot) => bot.id === selectedBotId)) {
      setSelectedBotId(configurableBots[0]!.id);
    }
  }, [configurableBots, selectedBotId]);

  useEffect(() => {
    setChannelNotice(null);
  }, [selectedBotId]);

  /* ── 关闭弹窗时取消 SSE 和 session ── */
  const cleanupWeixinSession = useCallback(() => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
    }
    if (wxSessionId && selectedBot && wxStatus !== "success" && wxStatus !== "cancelled" && wxStatus !== "failed") {
      void repositories.bots.cancelWeixinLoginSession(selectedBot.id, wxSessionId).catch(() => { });
    }
  }, [wxSessionId, selectedBot, wxStatus, repositories.bots]);

  const closeQrModal = useCallback(() => {
    cleanupWeixinSession();
    setShowQrModal(false);
    setWxSessionId("");
    setWxStatus("idle");
    setWxQrUrl("");
    setWxError(null);
  }, [cleanupWeixinSession]);

  /* ── 启动微信扫码流程 ── */
  const handleWechatAuth = useCallback(async () => {
    if (!selectedBot) {
      setChannelNotice(t("请先创建并选择一个 Hermes，再接入通道。"));
      return;
    }

    setShowQrModal(true);
    setWxStatus("creating");
    setWxQrUrl("");
    setWxError(null);

    try {
      const { sessionId } = await repositories.bots.createWeixinLoginSession(selectedBot.id);
      setWxSessionId(sessionId);
      setWxStatus("starting");

      /* 订阅 SSE 事件流 */
      const abortController = new AbortController();
      sseAbortRef.current = abortController;

      const events = repositories.bots.subscribeWeixinLoginSessionEvents(
        selectedBot.id,
        sessionId,
        abortController.signal,
      );

      for await (const { event, data } of events) {
        if (abortController.signal.aborted) break;

        const payload = data as {
          session_id?: string;
          status?: string;
          qr_url?: string;
          qr_ascii?: string;
          error?: string;
          error_message?: string;
          restart_status?: string;
          data?: {
            status?: string;
            qr_url?: string;
            qr_ascii?: string;
            error_message?: string;
            restart_status?: string;
          };
        };

        /* SSE 事件的 data 字段里可能嵌套了一个 data 子对象 */
        const resolved = payload.data ?? payload;
        const newStatus = (resolved.status ?? "") as WeixinSessionStatus;
        const qrUrl = resolved.qr_url ?? "";
        const errorMsg = resolved.error_message ?? payload.error ?? "";

        if (qrUrl) {
          setWxQrUrl(qrUrl);
        }

        if (newStatus) {
          setWxStatus(newStatus);
        }

        if (errorMsg && (newStatus === "failed" || event === "error")) {
          setWxError(errorMsg);
        }

        /* 成功：更新 bot 的 connectedChannels */
        if (newStatus === "success") {
          const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("wechat")
            ? selectedBot.connectedChannels
            : [...selectedBot.connectedChannels, "wechat"];
          updateBot(selectedBot.id, { connectedChannels: nextChannels });
          break;
        }

        /* 终态：停止监听 */
        if (["failed", "expired", "cancelled", "timeout"].includes(newStatus) || event === "finished" || event === "error") {
          break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setWxStatus("failed");
        setWxError(err instanceof Error ? err.message : t("微信登录会话创建失败"));
      }
    }
  }, [selectedBot, repositories.bots, updateBot]);

  /* ── 如果 SSE 没有可用，降级为轮询 ── */
  useEffect(() => {
    if (wxStatus !== "starting" || !wxSessionId || !selectedBot) return;

    /* 给 SSE 3 秒时间建立连接，如果 3s 后状态仍然是 starting 且没有 qr_url，开始轮询 */
    const fallbackTimer = setTimeout(async () => {
      if (wxStatus !== "starting" && wxStatus !== "waiting_qr") return;
      if (wxQrUrl) return;

      const pollInterval = 3000;
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        if (!showQrModal) break;
        try {
          const snapshot = await repositories.bots.getWeixinLoginSession(selectedBot.id, wxSessionId);
          const status = (snapshot.status ?? "") as WeixinSessionStatus;
          if (snapshot.qr_url) setWxQrUrl(snapshot.qr_url);
          if (status) setWxStatus(status);
          if (snapshot.error_message) setWxError(snapshot.error_message);
          if (status === "success") {
            const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("wechat")
              ? selectedBot.connectedChannels
              : [...selectedBot.connectedChannels, "wechat"];
            updateBot(selectedBot.id, { connectedChannels: nextChannels });
            break;
          }
          if (["failed", "expired", "cancelled", "timeout"].includes(status)) break;
        } catch {
          /* 轮询失败时静默忽略 */
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxStatus, wxSessionId]);

  /* ── 组件卸载时清理 ── */
  useEffect(() => {
    return () => {
      if (sseAbortRef.current) {
        sseAbortRef.current.abort();
        sseAbortRef.current = null;
      }
    };
  }, []);

  const handleQqSubmit = async () => {
    if (!selectedBot || !qqAppId.trim() || !qqAppSecret.trim()) {
      return;
    }

    setSubmitting(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(selectedBot.id, {
        appId: qqAppId,
        appSecret: qqAppSecret,
        account: qqAccount || undefined,
      });
      const nextChannels: ConnectedChannel[] = selectedBot.connectedChannels.includes("qq")
        ? selectedBot.connectedChannels
        : [...selectedBot.connectedChannels, "qq"];
      updateBot(selectedBot.id, { connectedChannels: nextChannels });
      setSelectedChannel(null);
      setQqAppId("");
      setQqAppSecret("");
      setQqAccount("");
      setChannelNotice(result.gatewayRestarted ? t("QQ channel 已配置，gateway 已重启。") : t("QQ channel 已配置，但 gateway 未确认重启。"));
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : t("QQ channel 配置失败"));
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 微信扫码状态对应的 UI 文案 ── */
  const wxStatusLabel: Record<string, { text: string; color: string }> = {
    creating: { text: t("正在创建登录会话…"), color: "#999" },
    starting: { text: t("正在启动微信登录…"), color: "#999" },
    waiting_qr: { text: t("请使用微信扫描二维码"), color: "#07C160" },
    scanned: { text: t("已扫码，正在确认登录…"), color: "#07C160" },
    success: { text: t("微信通道接入成功！"), color: "#07C160" },
    failed: { text: t("登录失败"), color: "#cf3d4c" },
    expired: { text: t("二维码已过期"), color: "#C67B1E" },
    cancelled: { text: t("已取消"), color: "#999" },
    timeout: { text: t("登录超时"), color: "#C67B1E" },
  };

  // 国内站封存组件：所有 hooks 调用完毕后再做国际站短路（遵循 React Hooks 调用顺序规则）
  if (isGlobal) return null;

  return (
    <>
      {/* WeChat QR Code Modal - 使用 Portal 渲染到 body */}
      {showQrModal && createPortal(
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
            onClick={closeQrModal}
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-[1.75rem] border p-8 shadow-2xl"
              style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(238,238,238,0.4)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={closeQrModal}
                className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--lw-bg-secondary)] text-[var(--text-tertiary)]"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.1)" }}>
                {wxStatus === "success" ? (
                  <Check className="h-6 w-6" style={{ color: "#07C160" }} />
                ) : (
                  <ScanLine className="h-6 w-6" style={{ color: "#07C160" }} />
                )}
              </div>
              <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("微信扫码接入")}</h3>

              {/* 状态提示 */}
              <p className="mb-4 text-center text-sm font-medium" style={{ color: wxStatusLabel[wxStatus]?.color ?? "#999" }}>
                {wxStatusLabel[wxStatus]?.text ?? t("准备中…")}
              </p>

              {/* 二维码区域 */}
              <div
                className="mb-5 flex h-52 w-52 items-center justify-center rounded-xl border-2 border-dashed"
                style={{ borderColor: wxQrUrl ? "rgba(7,193,96,0.3)" : "rgba(238,238,238,0.4)", background: "rgba(245,243,239,0.5)" }}
              >
                {wxQrUrl ? (
                  <img
                    src={wxQrUrl}
                    alt={t("微信登录二维码")}
                    className="h-44 w-44 rounded-lg"
                  />
                ) : wxStatus === "success" ? (
                  <div className="flex flex-col items-center gap-2">
                    <Check className="h-12 w-12" style={{ color: "#07C160" }} />
                    <span className="text-sm font-medium" style={{ color: "#07C160" }}>{t("接入成功")}</span>
                  </div>
                ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                  <div className="flex flex-col items-center gap-2">
                    <X className="h-12 w-12" style={{ color: "#cf3d4c" }} />
                    <span className="text-xs text-center leading-relaxed" style={{ color: "#cf3d4c" }}>
                      {wxError || t("请重试")}
                    </span>
                  </div>
                ) : (
                  <Loader2 className="h-8 w-8 animate-spin" style={{ color: "#07C160" }} />
                )}
              </div>

              {/* 错误信息 */}
              {wxError && wxStatus !== "failed" && wxStatus !== "expired" && wxStatus !== "timeout" && (
                <p className="mb-3 text-center text-xs font-medium" style={{ color: "#cf3d4c" }}>{wxError}</p>
              )}

              {/* 操作按钮 */}
              {wxStatus === "success" ? (
                <button onClick={closeQrModal} className="lw-btn-primary w-full">
                  <Check className="h-4 w-4" /> {t("完成")}
                </button>
              ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                <div className="flex w-full gap-3">
                  <button onClick={closeQrModal} className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                    {t("关闭")}
                  </button>
                  <button onClick={() => void handleWechatAuth()} className="lw-btn-primary flex-1">
                    {t("重试")}
                  </button>
                </div>
              ) : (
                <button onClick={closeQrModal} className="w-full rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                  {t("取消")}
                </button>
              )}
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}

      <div className="space-y-4">
        {/* Connected channels */}
        {connectedChannels.length > 0 && (
          <div className="space-y-2">
            {connectedChannels.includes("wechat") && (
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(7,193,96,0.2)", background: "rgba(7,193,96,0.04)" }}>
                <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-5 w-5 object-contain" />
                <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>微信</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(7,193,96,0.1)", color: "#07C160" }}>
                  <Check className="h-3 w-3" /> {t("已接入")}
                </span>
              </div>
            )}
            {connectedChannels.includes("qq") && (
              <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(18,183,245,0.2)", background: "rgba(18,183,245,0.04)" }}>
                <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-5 w-5 object-contain" />
                <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>QQ</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(18,183,245,0.1)", color: "#12B7F5" }}>
                  <Check className="h-3 w-3" /> 已接入
                </span>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="lw-label block">选择要配置的 Hermes</label>
          <select
            value={selectedBotId}
            onChange={(event) => setSelectedBotId(event.target.value)}
            className="lw-input"
            disabled={!configurableBots.length || submitting}
          >
            {configurableBots.length ? configurableBots.map((bot) => (
              <option key={bot.id} value={bot.id}>{bot.name}</option>
            )) : <option value="">暂无可配置 Hermes</option>}
          </select>
        </div>

        {/* Channel selection */}
        <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: 25 }}>选择一个聊天软件接入你的 Hermes</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* QQ */}
          <button
            onClick={() => setSelectedChannel(selectedChannel === "qq" ? null : "qq")}
            disabled={!selectedBot || connectedChannels.includes("qq")}
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-2.5 p-5 text-center transition-all",
              selectedChannel === "qq" && "lw-setup-card--active",
              connectedChannels.includes("qq") && "pointer-events-none opacity-50",
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(18,183,245,0.08)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-8 w-8 object-contain" />
            </div>
            <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>QQ</h4>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">通过QQ机器人与 Hermes 对话</p>
            {selectedChannel === "qq" && (
              <div className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-[var(--shadow-soft)]" style={{ background: "var(--lw-accent)" }}>
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
          </button>

          {/* WeChat */}
          <button
            onClick={() => setSelectedChannel(selectedChannel === "wechat" ? null : "wechat")}
            disabled={!selectedBot || connectedChannels.includes("wechat")}
            className={cn(
              "lw-setup-card group relative flex flex-col items-center gap-2.5 p-5 text-center transition-all",
              selectedChannel === "wechat" && "lw-setup-card--active",
              connectedChannels.includes("wechat") && "pointer-events-none opacity-50",
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.08)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-8 w-8 object-contain" />
            </div>
            <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>微信</h4>
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">扫码登录微信个人号接入</p>
            {selectedChannel === "wechat" && (
              <div className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full shadow-[var(--shadow-soft)]" style={{ background: "#07C160" }}>
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
          </button>
        </div>

        {/* WeChat action */}
        <AnimatePresence mode="wait">
          {selectedChannel === "wechat" && (
            <motion.div
              key="wechat-action"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden text-center"
            >
              <button
                onClick={() => void handleWechatAuth()}
                disabled={submitting || !selectedBot}
                className="lw-btn-primary disabled:opacity-60"
                style={{ background: "#07C160", borderColor: "#07C160" }}
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> 授权中...</>
                ) : (
                  <><ScanLine className="h-4 w-4" /> 扫码接入微信</>
                )}
              </button>
            </motion.div>
          )}

          {selectedChannel === "qq" && (
            <motion.div
              key="qq-action"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-3 overflow-hidden"
            >
              <div>
                <label className="lw-label mb-1.5 block">QQ机器人的App ID</label>
                <input
                  type="text"
                  value={qqAppId}
                  onChange={(e) => setQqAppId(e.target.value)}
                  placeholder="请输入 App ID"
                  className="lw-input"
                />
              </div>
              <div>
                <label className="lw-label mb-1.5 block">QQ机器人的App Secret</label>
                <input
                  type="password"
                  value={qqAppSecret}
                  onChange={(e) => setQqAppSecret(e.target.value)}
                  placeholder="请输入 App Secret"
                  className="lw-input"
                />
              </div>
              <button
                onClick={() => void handleQqSubmit()}
                disabled={submitting || !selectedBot || !qqAppId.trim() || !qqAppSecret.trim()}
                className="lw-btn-primary w-full disabled:opacity-60"
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> 配置中...</>
                ) : (
                  <>保存并应用 <ArrowRight className="h-4 w-4" /></>
                )}
              </button>
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

        {channelNotice ? (
          <p className="text-sm text-[var(--text-secondary)]">{channelNotice}</p>
        ) : null}
      </div>
    </>
  );
};

/* ─── Skill Section ─── */

const SkillSection = () => {
  const t = useT();
  const personas = useMemo(() => makePersonas(), []);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [installed, setInstalled] = useState(false);

  const handleInstall = useCallback(() => {
    setInstalling(true);
    setProgress(0);
  }, []);

  useEffect(() => {
    if (!installing) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = prev + Math.random() * 3 + 1;
        if (next >= 100) {
          clearInterval(interval);
          setInstalling(false);
          setInstalled(true);
          return 100;
        }
        return next;
      });
    }, 120);

    return () => clearInterval(interval);
  }, [installing]);

  return (
    <div className="space-y-4">
      {installed && selectedPersona ? (
        /* Installed state */
        <div>
          <div className="mb-4 flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(230,111,98,0.2)", background: "rgba(230,111,98,0.04)" }}>
            <span className="text-xl">{selectedPersona.icon}</span>
            <div className="flex-1">
              <span className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{selectedPersona.name} {selectedPersona.nameEn}</span>
              <p className="text-xs text-[var(--text-secondary)]">{selectedPersona.desc}</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(230,111,98,0.08)", color: "var(--lw-accent)" }}>
              <Check className="h-3 w-3" /> {t("已安装")}
            </span>
          </div>
          <div className="space-y-2">
            {selectedPersona.skills.map((skill, idx) => (
              <div key={idx} className="flex items-start gap-3 rounded-xl px-4 py-3" style={{ background: "rgba(245,243,239,0.5)" }}>
                <div className="lw-setup-icon-container flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg">
                  {skill.icon}
                </div>
                <div>
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{skill.name}</h4>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{skill.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setInstalled(false); setSelectedPersona(null); setProgress(0); }}
            className="lw-back-link mt-3"
          >
            {t("重新选择技能专家")}
          </button>
        </div>
      ) : installing && selectedPersona ? (
        /* Installing state */
        <div className="text-center">
          <div className="mx-auto mb-4 text-3xl">{selectedPersona.icon}</div>
          <p className="mb-4 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>
            {t("正在安装 {{name}} {{nameEn}}...", { name: selectedPersona.name, nameEn: selectedPersona.nameEn })}
          </p>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold" style={{ color: "var(--lw-fg)" }}>{t("安装进度")}</span>
            <span className="text-xs font-bold" style={{ color: "var(--lw-accent)" }}>{Math.round(progress)}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "#eee" }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: "linear-gradient(90deg, var(--lw-accent), #f0a878)" }}
              initial={{ width: "0%" }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3, ease: "linear" }}
            />
          </div>
        </div>
      ) : (
        /* Selection state */
        <>
          <p className="text-sm text-[var(--text-secondary)]">{t("选择一个技能专家，让你的龙虾技能增强")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {personas.map((persona) => (
              <button
                key={persona.id}
                onClick={() => setSelectedPersona(persona)}
                className={cn(
                  "lw-setup-card group flex flex-col items-center gap-2.5 p-5 text-center",
                  selectedPersona?.id === persona.id && "lw-setup-card--active",
                )}
              >
                <div className="lw-setup-icon-container flex h-12 w-12 items-center justify-center rounded-xl text-xl">
                  {persona.icon}
                </div>
                <div>
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>
                    {persona.name} <span className="font-normal text-[var(--text-tertiary)]">{persona.nameEn}</span>
                  </h4>
                </div>
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{persona.desc}</p>
              </button>
            ))}
          </div>

          {/* Selected persona skills preview + install */}
          <AnimatePresence mode="wait">
            {selectedPersona && (
              <motion.div
                key={selectedPersona.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="space-y-2 rounded-xl p-4" style={{ background: "rgba(245,243,239,0.5)" }}>
                  <p className="mb-3 text-xs font-bold text-[var(--text-tertiary)]">{t("预装 Agent Skills")}</p>
                  {selectedPersona.skills.map((skill, idx) => (
                    <div key={idx} className="flex items-start gap-3">
                      <div className="lw-setup-icon-container flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg">
                        {skill.icon}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{skill.name}</h4>
                        <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{skill.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 text-center">
                  <button onClick={handleInstall} className="lw-btn-primary">
                    {t("开始安装")} <Sparkles className="h-4 w-4" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
};

void SkillSection;

/* ─── Terminal Utilities ─── */

type ConnectionState = "loading" | "bootstrapping" | "authenticating" | "connected" | "closed" | "error";

const mapPtyState = (state: TencentPtyConnectionState): ConnectionState => {
  switch (state) {
    case "idle":
    case "connecting":
      return "bootstrapping";
    case "authenticating":
    case "starting":
      return "authenticating";
    case "ready":
      return "connected";
    case "closed":
      return "closed";
    case "error":
      return "error";
  }
};

/* ─── Terminal Modal ─── */

const TerminalModal = ({ botId, botName, onClose }: { botId: string; botName: string; onClose: () => void }) => {
  const t = useT();
  const repositories = useRepositories();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyClientRef = useRef<TencentPtyClient | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>("loading");
  const [error, setError] = useState<string | null>(null);

  /* Initialize xterm */
  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.2,
      allowProposedApi: true,
      theme: {
        background: "#16110d",
        foreground: "#f8e6d8",
        cursor: "#ffd7a8",
        black: "#221914",
        red: "#ff7f50",
        green: "#9ad76d",
        yellow: "#f2cd65",
        blue: "#72b6ff",
        magenta: "#f6a5c0",
        cyan: "#7be0d4",
        white: "#f8e6d8",
        brightBlack: "#786454",
        brightRed: "#ff9770",
        brightGreen: "#b7ef83",
        brightYellow: "#ffe288",
        brightBlue: "#8ac5ff",
        brightMagenta: "#ffc0d5",
        brightCyan: "#8ef0e0",
        brightWhite: "#fff4ea",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);
    /* 延迟 fit，确保字体已加载并渲染完毕，避免字符间距异常 */
    requestAnimationFrame(() => {
      fitAddon.fit();
    });
    terminal.writeln("LightVela TAT Terminal");
    terminal.writeln("");

    terminal.onData((data) => {
      ptyClientRef.current?.sendInput(data);
    });

    const handleResize = () => {
      fitAddon.fit();
      ptyClientRef.current?.resize(terminal.cols, terminal.rows);
    };

    window.addEventListener("resize", handleResize);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", handleResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  /* Connect to TAT WebSocket */
  useEffect(() => {
    let cancelled = false;

    const closeSocket = () => {
      ptyClientRef.current?.close();
      ptyClientRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        const bootstrap = await repositories.bots.getTerminalSession(botId);
        if (cancelled) {
          return;
        }

        terminalRef.current?.reset();
        terminalRef.current?.writeln(`Connecting ${botName} (${botId})...`);
        fitAddonRef.current?.fit();

        const { TencentPtyClient } = await import("@/lib/tencent-pty-client");
        if (cancelled) {
          return;
        }
        const ptyClient = new TencentPtyClient(bootstrap, {
          getDimensions: () => ({
            cols: terminalRef.current?.cols ?? bootstrap.cols,
            rows: terminalRef.current?.rows ?? bootstrap.rows,
          }),
          onStateChange: (state) => {
            if (!cancelled) {
              setConnectionState(mapPtyState(state));
            }
          },
          onReady: () => {
            terminalRef.current?.focus();
          },
          onOutput: (output) => {
            terminalRef.current?.write(output);
          },
          onError: (message) => {
            if (!cancelled) {
              setError(message);
              terminalRef.current?.writeln(`\r\n[error] ${message}`);
            }
          },
          onDecodeError: (decodeError) => {
            terminalRef.current?.writeln(`\r\n[decode-error] ${String(decodeError)}`);
          },
          onClose: (event) => {
            if (!cancelled) {
              terminalRef.current?.writeln(`\r\n[closed] code=${event.code}`);
            }
          },
        });
        ptyClientRef.current = ptyClient;
        ptyClient.connect();
      } catch (connectError) {
        if (cancelled) {
          return;
        }
        setConnectionState("error");
        setError(connectError instanceof Error ? connectError.message : t("终端连接失败"));
      }
    };

    void connect();

    return () => {
      cancelled = true;
      closeSocket();
    };
  }, [botId, botName, repositories.bots]);

  const stateLabel: Record<ConnectionState, string> = {
    loading: t("初始化..."),
    bootstrapping: t("获取会话..."),
    authenticating: t("认证中..."),
    connected: t("已连接"),
    closed: t("已断开"),
    error: t("连接失败"),
  };

  const stateColor: Record<ConnectionState, string> = {
    loading: "#999",
    bootstrapping: "#C67B1E",
    authenticating: "#C67B1E",
    connected: "#147A56",
    closed: "#999",
    error: "#cf3d4c",
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 30, scale: 0.95 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="relative mx-4 flex w-full flex-col overflow-hidden rounded-[1.75rem] border shadow-2xl"
        style={{ maxWidth: 900, maxHeight: "85vh", background: "#0f0b09", borderColor: "rgba(255,255,255,0.1)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}
        >
          <div className="flex items-center gap-3">
            <TerminalSquare className="h-4 w-4" style={{ color: "#f8e6d8" }} />
            <span className="text-sm font-semibold" style={{ color: "#f8e6d8" }}>
              {botName}
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{ background: `${stateColor[connectionState]}18`, color: stateColor[connectionState] }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor[connectionState] }} />
              {stateLabel[connectionState]}
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(255,255,255,0.1)] text-[var(--text-tertiary)]"
            title={t("关闭终端")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Terminal */}
        <div className="flex-1 overflow-hidden p-3">
          {error && connectionState === "error" && (
            <p className="mb-2 rounded-full px-3 py-1.5 text-xs font-medium" style={{ background: "rgba(207,61,76,0.15)", color: "#ff7f50" }}>
              {error}
            </p>
          )}
          <div
            ref={terminalContainerRef}
            className="rounded-xl border p-2"
            style={{ borderColor: "rgba(255,255,255,0.08)", background: "#16110d", minHeight: "28rem" }}
          />
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Bot Card for multi-bot display ─── */

// 实例名称展示最多 20 个 Unicode 码点，超出截断并拼接省略号，由调用方配合 title 属性展示全名
const BOT_NAME_DISPLAY_MAX = 20;
const truncateBotName = (name: string) => {
  const chars = Array.from(name);
  return chars.length > BOT_NAME_DISPLAY_MAX ? chars.slice(0, BOT_NAME_DISPLAY_MAX).join("") + "…" : name;
};

// 随机头像列表
const LIGHTCLAW_AVATARS = [assetUrl('/hermes_logo.png')];

// 根据 bot id 获取固定的随机头像（保证同一个 bot 每次显示同一张图）
const getAvatarForBot = (botId: string) => {
  let hash = 0;
  for (let i = 0; i < botId.length; i++) {
    hash = ((hash << 5) - hash) + botId.charCodeAt(i);
    hash |= 0;
  }
  return LIGHTCLAW_AVATARS[Math.abs(hash) % LIGHTCLAW_AVATARS.length];
};

// 出生证明弹窗组件 - 使用 Portal 渲染到 body
const BirthCertificateModal = ({
  bot,
  onClose
}: {
  bot: { id: string; name: string; createdAt: string };
  onClose: () => void;
}) => {
  const t = useT();
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
        const message = error instanceof Error ? error.message : t("出生证明加载失败");
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

  // 解析创建日期
  const createdDate = new Date(bornCardCreatedAt);
  const year = createdDate.getFullYear();
  const month = createdDate.getMonth() + 1;
  const day = createdDate.getDate();

  // 获取龙虾头像的绝对 URL
  const avatarPath = getAvatarForBot(bot.id) ?? assetUrl('/hermes_logo.png');
  const avatarUrl = avatarImageUrl(avatarPath);

  // 下载图片功能
  const handleDownload = async () => {
    if (!certificateRef.current || downloading) return;

    setDownloading(true);
    try {
      // 动态导入 html2canvas
      const html2canvas = (await import("html2canvas")).default;

      const canvas = await html2canvas(certificateRef.current, {
        backgroundColor: "#FFD4A8",
        scale: 2, // 高清导出
        useCORS: true,
        allowTaint: true,
        logging: false,
        imageTimeout: 15000,
        onclone: (clonedDoc: Document) => {
          // 确保克隆的文档中图片能正确加载
          const clonedElement = clonedDoc.querySelector('[data-certificate]');
          if (clonedElement) {
            (clonedElement as HTMLElement).style.transform = 'none';
          }
        }
      });

      // 创建下载链接
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
          {/* 证书主体 - 可导出部分 */}
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
            {/* 装饰波浪线 - 使用内联 SVG 确保渲染 */}
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

            <div style={{ padding: "32px 40px 28px" }}>
              {/* 标题 - 带装饰引号 */}
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
                  {/* 左侧龙虾图片 */}
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
                        style={{
                          width: 128,
                          height: 128,
                          objectFit: "contain"
                        }}
                      />
                    </div>
                  </div>

                  {/* 右侧信息 */}
                  <div style={{ flex: 1, paddingTop: 8 }}>
                    {/* 龙虾姓名 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        龙虾姓名
                      </span>
                      <div
                        style={{
                          flex: 1,
                          borderBottom: "2px solid rgba(92,64,51,0.25)",
                          paddingBottom: 4,
                          minWidth: 0
                        }}
                      >
                        <span
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            display: "block",
                            color: "#3D2B1F",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap"
                          }}
                        >
                          {bot.name}
                        </span>
                      </div>
                    </div>

                    {/* 家庭住址 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        家庭住址：
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: "#5C4033"
                        }}
                      >
                        LightVela
                      </span>
                    </div>

                    {/* 出生日期 */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          color: "#5C4033"
                        }}
                      >
                        出生日期：
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 600,
                          color: "#5C4033"
                        }}
                      >
                        {year}年{month}月{day}日
                      </span>
                    </div>
                  </div>
                </div>

                {/* 底部印章徽章 */}
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
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: "#E66F62"
                        }}
                      >
                        今天出生的第
                      </span>
                      <span
                        style={{
                          fontSize: 30,
                          fontWeight: 900,
                          marginLeft: 4,
                          marginRight: 4,
                          color: "#E66F62",
                          textShadow: "1px 1px 0 rgba(230,111,98,0.2)"
                        }}
                      >
                        {bornCardOrder}
                      </span>
                      <span
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          color: "#E66F62"
                        }}
                      >
                        个Hermes宝宝
                      </span>
                      <span style={{ fontSize: 14, marginLeft: 4, color: "#E66F62" }}>✦</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 操作按钮区域 - 证书外部 */}
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

/* ─── Channel Modal (per bot) ─── */

const ChannelModal = ({ bot, onClose }: { bot: { id: string; name: string; connectedChannels: string[] }; onClose: () => void }) => {
  const repositories = useRepositories();
  const { updateBot } = useOpenClaw();
  const [selectedChannel, setSelectedChannel] = useState<Channel>(null);
  const [qqAppId, setQqAppId] = useState("");
  const [qqAppSecret, setQqAppSecret] = useState("");
  const [qqAccount, setQqAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [channelNotice, setChannelNotice] = useState<string | null>(null);

  /* ── WeChat login session state ── */
  const [showQrModal, setShowQrModal] = useState(false);
  const [wxSessionId, setWxSessionId] = useState("");
  const [wxStatus, setWxStatus] = useState<WeixinSessionStatus>("idle");
  const [wxQrUrl, setWxQrUrl] = useState("");
  const [wxError, setWxError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const connectedChannels: ConnectedChannel[] = (bot.connectedChannels ?? []) as ConnectedChannel[];

  /* ── 关闭弹窗 → 停止一切 ── */
  const closeQrModal = useCallback(() => {
    cancelledRef.current = true;
    const sid = wxSessionId;
    if (sid && wxStatus !== "success" && wxStatus !== "cancelled" && wxStatus !== "failed") {
      void repositories.bots.cancelWeixinLoginSession(bot.id, sid).catch(() => { });
    }
    setShowQrModal(false);
    setWxSessionId("");
    setWxStatus("idle");
    setWxQrUrl("");
    setWxError(null);
  }, [wxSessionId, wxStatus, repositories.bots, bot.id]);

  useEffect(() => () => { cancelledRef.current = true; }, []);

  /* ── 轮询获取 session 状态（SSE 降级 & 实例未就绪等待） ── */
  const pollSession = useCallback(async (botId: string, sessionId: string): Promise<void> => {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      if (cancelledRef.current) return;
      try {
        const snapshot = await repositories.bots.getWeixinLoginSession(botId, sessionId);
        console.log(`[WX-DEBUG] 轮询 #${i}:`, JSON.stringify(snapshot));
        if (cancelledRef.current) return;
        const status = (snapshot.status ?? "") as WeixinSessionStatus;
        if (snapshot.qr_url) setWxQrUrl(snapshot.qr_url);
        if (status) setWxStatus(status);
        if (snapshot.error_message) setWxError(snapshot.error_message);
        if (status === "success") {
          const next: ConnectedChannel[] = connectedChannels.includes("wechat") ? connectedChannels : [...connectedChannels, "wechat"];
          updateBot(botId, { connectedChannels: next });
          return;
        }
        if (["failed", "expired", "cancelled", "timeout"].includes(status)) return;
      } catch {
        /* 轮询失败时静默重试 */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }, [repositories.bots, connectedChannels, updateBot]);

  /* ── 启动微信扫码流程 ── */
  const handleWechatAuth = useCallback(async () => {
    cancelledRef.current = false;
    setShowQrModal(true);
    setWxStatus("creating");
    setWxQrUrl("");
    setWxError(null);
    setWxSessionId("");

    /* 步骤 1: 创建 weixin login session（如果实例未就绪，轮询重试） */
    let sessionId = "";
    const maxCreateRetries = 40;
    for (let attempt = 0; attempt < maxCreateRetries; attempt++) {
      if (cancelledRef.current) return;
      try {
        const result = await repositories.bots.createWeixinLoginSession(bot.id);
        sessionId = result.sessionId;
        break;
      } catch (err) {
        if (cancelledRef.current) return;
        const status = (err as { status?: number }).status;
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : "";

        /* 已有活跃 session → 提取 sessionId，取消后重试 */
        if (code === "CHANNEL_LOGIN_CONFLICT" || (status === 409 && msg.includes("active session already exists"))) {
          console.log("[WX-DEBUG] 检测到已有活跃 session，尝试取消...", msg);
          const existingId = msg.match(/active session already exists:\s*([\w-]+)/)?.[1] ?? "";
          if (existingId) {
            try {
              await repositories.bots.cancelWeixinLoginSession(bot.id, existingId);
              console.log("[WX-DEBUG] 已取消旧 session:", existingId);
            } catch (cancelErr) {
              console.warn("[WX-DEBUG] 取消旧 session 失败:", cancelErr);
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        /* 实例未就绪（如 DEBUG_NOT_SUPPORTED）→ 等待重试 */
        if (status === 409 || code === "DEBUG_NOT_SUPPORTED") {
          setWxStatus("creating");
          setWxError(null);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        setWxStatus("failed");
        setWxError(msg || "微信登录会话创建失败");
        return;
      }
    }

    if (!sessionId || cancelledRef.current) return;
    console.log("[WX-DEBUG] sessionId 创建成功:", sessionId);
    setWxSessionId(sessionId);
    setWxStatus("starting");

    /* 步骤 2: 尝试 SSE 订阅 */
    const abortController = new AbortController();
    const onCancelCleanup = () => { abortController.abort(); };
    /* 当 cancelledRef 变 true 时 abort SSE（通过 closeQrModal） */

    let sseWorked = false;
    try {
      console.log("[WX-DEBUG] 开始 SSE 订阅...");
      const events = repositories.bots.subscribeWeixinLoginSessionEvents(bot.id, sessionId, abortController.signal);
      for await (const { event, data } of events) {
        if (cancelledRef.current) { onCancelCleanup(); return; }
        sseWorked = true;
        console.log("[WX-DEBUG] SSE 收到事件:", event, JSON.stringify(data));

        const payload = data as {
          status?: string; qr_url?: string; error_message?: string; error?: string;
          data?: { status?: string; qr_url?: string; error_message?: string };
        };
        const resolved = payload.data ?? payload;
        const newStatus = (resolved.status ?? "") as WeixinSessionStatus;
        const qrUrl = resolved.qr_url ?? "";
        const errorMsg = resolved.error_message ?? payload.error ?? "";

        if (qrUrl) setWxQrUrl(qrUrl);
        if (newStatus) setWxStatus(newStatus);
        if (errorMsg && (newStatus === "failed" || event === "error")) setWxError(errorMsg);

        if (newStatus === "success") {
          const next: ConnectedChannel[] = connectedChannels.includes("wechat") ? connectedChannels : [...connectedChannels, "wechat"];
          updateBot(bot.id, { connectedChannels: next });
          return;
        }
        if (["failed", "expired", "cancelled", "timeout"].includes(newStatus) || event === "finished" || event === "error") return;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.warn("[WX-DEBUG] SSE 连接失败，降级轮询:", err);
      /* SSE 连接失败 → 降级轮询 */
    }

    /* 步骤 3: 如果 SSE 没有工作或过早断开，降级到轮询 */
    console.log("[WX-DEBUG] SSE 结束, sseWorked:", sseWorked, "cancelled:", cancelledRef.current);
    if (!sseWorked && !cancelledRef.current) {
      console.log("[WX-DEBUG] 降级到轮询模式...");
      await pollSession(bot.id, sessionId);
    }
  }, [bot.id, connectedChannels, repositories.bots, updateBot, pollSession]);

  const handleQqSubmit = async () => {
    if (!qqAppId.trim() || !qqAppSecret.trim()) return;
    setSubmitting(true);
    setChannelNotice(null);
    try {
      const result = await repositories.bots.configureQQChannel(bot.id, {
        appId: qqAppId,
        appSecret: qqAppSecret,
        account: qqAccount || undefined,
      });
      const nextChannels: ConnectedChannel[] = connectedChannels.includes("qq")
        ? connectedChannels
        : [...connectedChannels, "qq"];
      updateBot(bot.id, { connectedChannels: nextChannels });
      setSelectedChannel(null);
      setQqAppId("");
      setQqAppSecret("");
      setQqAccount("");
      setChannelNotice(result.gatewayRestarted ? "QQ channel 已配置，gateway 已重启。" : "QQ channel 已配置，但 gateway 未确认重启。");
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : "QQ channel 配置失败");
    } finally {
      setSubmitting(false);
    }
  };

  const wxStatusLabel: Record<string, { text: string; color: string }> = {
    creating: { text: "正在准备实例，请稍候…", color: "#999" },
    starting: { text: "正在启动微信登录…", color: "#999" },
    waiting_qr: { text: "请使用微信扫描二维码", color: "#07C160" },
    scanned: { text: "已扫码，正在确认登录…", color: "#07C160" },
    success: { text: "微信通道接入成功！", color: "#07C160" },
    failed: { text: "登录失败", color: "#cf3d4c" },
    expired: { text: "二维码已过期", color: "#C67B1E" },
    cancelled: { text: "已取消", color: "#999" },
    timeout: { text: "登录超时", color: "#C67B1E" },
  };

  return createPortal(
    <AnimatePresence>
      {/* WeChat QR sub-modal */}
      {showQrModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
          onClick={closeQrModal}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="relative mx-4 flex w-full max-w-sm flex-col items-center rounded-2xl border p-8 shadow-2xl"
            style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={closeQrModal} className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--lw-bg-secondary)] text-[var(--text-tertiary)]">
              <X className="h-4 w-4" />
            </button>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: "rgba(7,193,96,0.1)" }}>
              {wxStatus === "success" ? <Check className="h-6 w-6" style={{ color: "#07C160" }} /> : <ScanLine className="h-6 w-6" style={{ color: "#07C160" }} />}
            </div>
            <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>微信扫码接入</h3>
            <p className="mb-4 text-center text-sm font-medium" style={{ color: wxStatusLabel[wxStatus]?.color ?? "#999" }}>
              {wxStatusLabel[wxStatus]?.text ?? "准备中…"}
            </p>
            {/* QR 区域 */}
            <div className="mb-5 flex h-52 w-52 items-center justify-center rounded-xl" style={{ background: wxQrUrl ? "#fff" : "rgba(245,243,239,0.5)", border: wxQrUrl ? "none" : "2px dashed rgba(238,238,238,0.4)" }}>
              {wxQrUrl ? (
                <QRCodeSVG value={wxQrUrl} size={192} level="M" includeMargin={false} />
              ) : wxStatus === "success" ? (
                <div className="flex flex-col items-center gap-2">
                  <Check className="h-12 w-12" style={{ color: "#07C160" }} />
                  <span className="text-sm font-medium" style={{ color: "#07C160" }}>接入成功</span>
                </div>
              ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                <div className="flex flex-col items-center gap-2 px-4">
                  <X className="h-12 w-12" style={{ color: "#cf3d4c" }} />
                  <span className="text-xs text-center leading-relaxed" style={{ color: "#cf3d4c" }}>{wxError || "请重试"}</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin" style={{ color: "#07C160" }} />
                  {wxStatus === "creating" && (
                    <span className="text-xs" style={{ color: "#999" }}>等待实例就绪…</span>
                  )}
                </div>
              )}
            </div>
            {/* 错误信息 */}
            {wxError && !["failed", "expired", "timeout"].includes(wxStatus) && (
              <p className="mb-3 text-center text-xs font-medium" style={{ color: "#cf3d4c" }}>{wxError}</p>
            )}
            {/* 操作按钮 */}
            {wxStatus === "success" ? (
              <button onClick={closeQrModal} className="w-full rounded-lg py-2.5 text-sm font-bold text-white" style={{ background: "#07C160", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                <Check className="h-4 w-4" /> 完成
              </button>
            ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
              <div className="flex w-full gap-3">
                <button onClick={closeQrModal} className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>关闭</button>
                <button onClick={() => void handleWechatAuth()} className="flex-1 rounded-lg py-2.5 text-sm font-bold text-white" style={{ background: "#07C160" }}>重试</button>
              </div>
            ) : (
              <button onClick={closeQrModal} className="w-full rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>取消</button>
            )}
          </motion.div>
        </motion.div>
      )}

      {/* Main Channel Modal */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        style={{ backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="relative mx-4 flex w-full max-w-lg flex-col rounded-2xl border shadow-2xl"
          style={{ background: "rgba(255,255,255,0.98)", borderColor: "rgba(0,0,0,0.06)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header — 无分割线 */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4">
            <div className="flex items-center gap-2.5">
              <MessageCircle className="h-4 w-4" style={{ color: "var(--lw-accent)" }} />
              <h3 className="text-base font-bold" style={{ color: "var(--lw-fg)" }}>接入通道 · {bot.name}</h3>
            </div>
            <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-muted)] text-[var(--text-tertiary)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="space-y-4 p-6">
            {/* Connected channels */}
            {connectedChannels.length > 0 && (
              <div className="space-y-2">
                {connectedChannels.includes("wechat") && (
                  <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(7,193,96,0.2)", background: "rgba(7,193,96,0.04)" }}>
                    <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-5 w-5 object-contain" />
                    <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>微信</span>
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(7,193,96,0.1)", color: "#07C160" }}>
                      <Check className="h-3 w-3" /> 已接入
                    </span>
                  </div>
                )}
                {connectedChannels.includes("qq") && (
                  <div className="flex items-center gap-3 rounded-xl border px-4 py-3" style={{ borderColor: "rgba(18,183,245,0.2)", background: "rgba(18,183,245,0.04)" }}>
                    <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-5 w-5 object-contain" />
                    <span className="flex-1 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>QQ</span>
                    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold" style={{ background: "rgba(18,183,245,0.1)", color: "#12B7F5" }}>
                      <Check className="h-3 w-3" /> 已接入
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Channel selection */}
            <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: "20px" }}>选择一个聊天软件接入你的 Hermes</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              {/* QQ */}
              <button
                onClick={() => setSelectedChannel(selectedChannel === "qq" ? null : "qq")}
                disabled={connectedChannels.includes("qq")}
                className={cn(
                  "lw-setup-card group relative flex flex-col items-center justify-center gap-2.5 px-4 text-center transition-all overflow-visible",
                  selectedChannel === "qq" && "lw-setup-card--active",
                  connectedChannels.includes("qq") && "pointer-events-none opacity-50",
                )}
                style={{ height: "120px" }}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(18,183,245,0.08)" }}>
                  <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/43adbcec-a954-4809-9310-1237e3981f99.png" alt="QQ" className="h-7 w-7 object-contain" />
                </div>
                <div className="text-center">
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>QQ</h4>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">通过 QQ 机器人对话</p>
                </div>
                {selectedChannel === "qq" && (
                  <div className="absolute flex items-center justify-center rounded-full" style={{ top: "8px", right: "8px", width: "20px", height: "20px", background: "var(--lw-accent)" }}>
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>

              {/* WeChat — 扫码接入 */}
              <button
                onClick={() => setSelectedChannel(selectedChannel === "wechat" ? null : "wechat")}
                disabled={connectedChannels.includes("wechat")}
                className={cn(
                  "lw-setup-card group relative flex flex-col items-center justify-center gap-2.5 px-4 text-center transition-all overflow-visible",
                  selectedChannel === "wechat" && "lw-setup-card--active",
                  connectedChannels.includes("wechat") && "pointer-events-none opacity-50",
                )}
                style={{ height: "120px" }}
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(7,193,96,0.08)" }}>
                  <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/aef7d749-cabe-48dc-938b-11f1f50980c8.png" alt="微信" className="h-7 w-7 object-contain" />
                </div>
                <div className="text-center">
                  <h4 className="text-sm font-bold" style={{ color: "var(--lw-fg)" }}>微信</h4>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-secondary)]">扫码登录微信个人号</p>
                </div>
                {selectedChannel === "wechat" && (
                  <div className="absolute flex items-center justify-center rounded-full" style={{ top: "8px", right: "8px", width: "20px", height: "20px", background: "#07C160" }}>
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>
            </div>

            {/* Channel action panels */}
            <AnimatePresence mode="wait">
              {selectedChannel === "wechat" && (
                <motion.div key="wechat-action" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden text-center">
                  <button
                    onClick={() => void handleWechatAuth()}
                    disabled={submitting}
                    className="w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                    style={{ background: "#07C160", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> 授权中...</>) : (<><ScanLine className="h-4 w-4" /> 扫码接入微信</>)}
                  </button>
                </motion.div>
              )}
              {selectedChannel === "qq" && (
                <motion.div key="qq-action" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-3" style={{ overflow: "visible" }}>
                  <div className="px-0.5">
                    <label className="lw-label mb-1.5 block">QQ 机器人 App ID</label>
                    <input type="text" value={qqAppId} onChange={(e) => setQqAppId(e.target.value)} placeholder="请输入 App ID" className="lw-input" />
                  </div>
                  <div className="px-0.5">
                    <label className="lw-label mb-1.5 block">QQ 机器人 App Secret</label>
                    <input type="password" value={qqAppSecret} onChange={(e) => setQqAppSecret(e.target.value)} placeholder="请输入 App Secret" className="lw-input" />
                  </div>
                  <button onClick={() => void handleQqSubmit()} disabled={submitting || !qqAppId.trim() || !qqAppSecret.trim()} className="w-full rounded-lg py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50" style={{ background: "#E8503A", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                    {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> 配置中...</>) : (<>保存并应用 <ArrowRight className="h-4 w-4" /></>)}
                  </button>
                  <div className="pt-1 text-center">
                    <a href="https://q.qq.com/qqbot/openclaw/login.html" target="_blank" rel="noopener noreferrer" className="lw-back-link">
                      查看详情 <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {channelNotice && <p className="text-sm text-[var(--text-secondary)]">{channelNotice}</p>}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
};

export const _BotInfoCard = ({ bot, index, onDelete, onTerminal }: { bot: { id: string; name: string; personality: string; personalityEmoji: string; intro: string; status: string; connectedChannels: string[]; installedSkills: string[]; createdAt: string }; index: number; onDelete: (id: string) => void; onTerminal: (id: string) => void }) => {
  void onDelete;
  void onTerminal;
  const [showBirthCert, setShowBirthCert] = useState(false);
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const { deleteBot } = useOpenClaw();
  const t = useT();

  // 国内站封存组件：所有 hooks 调用完毕后再做国际站短路（遵循 React Hooks 调用顺序规则）
  if (isGlobal) return null;

  // 获取该 bot 的固定头像
  const avatarUrl = getAvatarForBot(bot.id);
  const connectedChannels = bot.connectedChannels ?? [];

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
        transition={{ delay: index * 0.08 }}
        className="overflow-hidden"
        style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}
      >
        {/* 平铺列表行：avatar + info + actions */}
        <div className="flex items-center gap-4 py-4 px-1">
          {/* Avatar */}
          <div
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl"
            style={{ background: "rgba(0,0,0,0.03)" }}
          >
            <img src={avatarUrl} alt="" className="h-9 w-9 object-contain" />
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h4 className="truncate text-sm font-bold" style={{ color: "var(--lw-fg)" }}>{bot.name}</h4>
              <button
                onClick={() => setShowBirthCert(true)}
                className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium transition-all hover:opacity-70"
                style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)", cursor: "pointer", border: "none" }}
              >
                📜 出生证明
              </button>
              {/* Tags: connected channels + skills */}
              {connectedChannels.map((ch) => (
                <span key={ch} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: ch === "wechat" ? "rgba(7,193,96,0.08)" : "rgba(18,183,245,0.08)", color: ch === "wechat" ? "#07C160" : "#12B7F5" }}>
                  <Check className="h-3 w-3" /> {ch === "wechat" ? "微信" : "QQ"}
                </span>
              ))}
              {bot.installedSkills.length > 0 && bot.installedSkills.map((sk) => (
                <span key={sk} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)" }}>
                  <Sparkles className="h-3 w-3" /> {sk}
                </span>
              ))}
            </div>

            {/* 简介（为空时不展示） */}
            {bot.intro && (
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "#999" }}>
                {bot.intro}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              onClick={() => setShowChannelModal(true)}
              className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition-all hover:opacity-80"
              style={{ background: "rgba(230,111,98,0.08)", color: "var(--lw-accent)" }}
            >
              <MessageCircle className="h-3 w-3" />
              {connectedChannels.length > 0 ? `${connectedChannels.length} 通道` : "接入通道"}
            </button>
            <button
              onClick={() => { setDeleteInput(""); setShowDeleteConfirm(true); }}
              className="flex h-7 w-7 items-center justify-center rounded-lg transition-all hover:bg-[rgba(220,38,38,0.08)]"
              style={{ color: "#ccc" }}
              title="删除"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </motion.div>

      {/* 出生证明弹窗 */}
      {showBirthCert && (
        <BirthCertificateModal bot={bot} onClose={() => setShowBirthCert(false)} />
      )}

      {/* 接入通道弹窗 */}
      {showChannelModal && (
        <ChannelModal bot={bot} onClose={() => setShowChannelModal(false)} />
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl" style={{ borderColor: "rgba(238,238,238,0.4)" }} onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("确认删除")}</h3>
            </div>
            {/* 风险说明 */}
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "12px" }}>
              {t("删除后会话将立即断开，数据将无法恢复。")}
            </p>
            {/* 操作引导 */}
            <p style={{ color: "var(--lw-fg)", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              {t("如确认删除，请输入名称 {{name}}：", { name: bot.name })}
            </p>
            <input type="text" placeholder={t("请输入 {{name}}", { name: bot.name })} value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]" style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }} />
            {deleteErr && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteErr}</p>}
            {/* 按钮组：上下排列 */}
            <div className="flex flex-col gap-2">
              <button onClick={async () => { setDeleting(true); setDeleteErr(null); try { await deleteBot(bot.id); setShowDeleteConfirm(false); } catch (e) { setDeleteErr(e instanceof Error ? e.message : t("删除失败")); } finally { setDeleting(false); } }} disabled={deleteInput !== bot.name || deleting} className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all" style={{ backgroundColor: deleteInput === bot.name && !deleting ? "#DC2626" : "#E5E7EB", cursor: deleteInput === bot.name && !deleting ? "pointer" : "not-allowed" }}>
                {deleting ? t("删除中...") : t("确认删除")}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="py-2 text-sm transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer" }}>
                {t("取消")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

/* ─── Creating Loading Animation ─── */

const CREATING_POLL_INTERVAL_MS = 3000;
const CREATING_MAX_WAIT_MS = 15 * 60 * 1000;

const CreatingLoadingView = ({ errorMessage }: { errorMessage?: string | null }) => {
  const t = useT();
  /* 动态 "..." 计数：0 -> 1 -> 2 -> 3 -> 0 ... 每 450ms 切换 */
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 450);
    return () => clearInterval(interval);
  }, []);

  const dots = ".".repeat(dotCount);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center justify-center py-20"
    >
      {/* Hermes 咖啡杯 —— 对应 Figma 231:4742 中心图（从 2x2 sprite 中裁剪左上角） */}
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="mb-2"
      >
        <div
          className="h-[78px] w-[78px] overflow-hidden"
          style={{
            backgroundImage: `url(${assetUrl("/hermes-loading.png")})`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "0 0",
            backgroundSize: "156px 156px",
          }}
        />
      </motion.div>

      {/* 文案：单行 + 动态省略号 */}
      <p
        className="text-center"
        style={{
          fontFamily: "PingFang SC, -apple-system, BlinkMacSystemFont, sans-serif",
          fontWeight: 500,
          fontSize: 14,
          lineHeight: "2em",
          color: "rgba(0,0,0,0.9)",
        }}
      >
        {errorMessage ? (
          errorMessage
        ) : (
          <>
            {t("正在给 Hermes Agent 喂咖啡，唤醒大脑中")}
            <span className="inline-block" style={{ width: "1.5em", textAlign: "left" }}>
              {dots}
            </span>
          </>
        )}
      </p>
    </motion.div>
  );
};

const getBotStatusColor = (status: OpenClawBot["status"]) => {
  if (status === "running") return "#34C759";
  if (status === "paused") return "#FF9500";
  if (status === "failed") return "#DC2626";
  return "#999";
};

const getBotStatusLabel = (status: OpenClawBot["status"]) => {
  if (status === "running") return rawT("运行中");
  if (status === "paused") return rawT("已暂停");
  if (status === "failed") return rawT("创建失败");
  if (status === "deleting") return rawT("删除中");
  if (status === "provisioning") return rawT("创建中");
  return rawT("草稿");
};

/* ─── Main Settings Page ─── */

const hermesScripts = createLightClawScripts({ regionShortName: "gz", agentType: "hermes" }).hermes;
const hermesGatewayCommands = hermesScripts.gateway;
const hermesModelCommands = hermesScripts.model;

export const OpenClawSettingsPage = () => {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const creatingParam = searchParams.get("creating")?.trim() ?? "";
  const requestedCreatingBotId = creatingParam && creatingParam !== "true" ? creatingParam : "";
  const { bots, botsLoading, deleteBot, user, refreshBots, isSubscribed, addBot } = useOpenClaw();
  const repositories = useRepositories();
  // 账号 id：来自 /auth/profile 下发的 session.user.id，用于 LightVelaPanel.userId 等场景
  const { session } = useSession();
  const accountId = session.user?.id ?? "";

  useEffect(() => {
    document.documentElement.classList.add("lw-settings-scrollbar-stable");
    return () => {
      document.documentElement.classList.remove("lw-settings-scrollbar-stable");
    };
  }, []);

  /* 创建 loading 状态 */
  const [isCreating, setIsCreating] = useState(Boolean(creatingParam));
  const [creationError, setCreationError] = useState<string | null>(null);
  /* 已订阅用户直接创建 Agent 的确认弹窗 */
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [directCreating, setDirectCreating] = useState(false);
  const [directCreateError, setDirectCreateError] = useState<string | null>(null);
  const visibleBots = useMemo(
    () => bots.filter((bot) => bot.status !== "provisioning" && bot.status !== "deleting"),
    [bots],
  );
  const createLimitMessage = useMemo(
    () => getOpenClawCreateLimitMessage(bots, user.plan.maxBots),
    [bots, user.plan.maxBots],
  );
  const canCreateBot = createLimitMessage === null;
  const provisioningBot = useMemo(() => {
    if (requestedCreatingBotId) {
      return bots.find((bot) => bot.id === requestedCreatingBotId && bot.status === "provisioning") ?? null;
    }
    return bots.find((bot) => bot.status === "provisioning") ?? null;
  }, [bots, requestedCreatingBotId]);
  const completedCreatingBot = useMemo(
    () => findCompletedCreatingBot(visibleBots, requestedCreatingBotId),
    [visibleBots, requestedCreatingBotId],
  );


  /* 实例内部的子页面切换：通道 / 模型 / 技能 / 人设 / 对话（通道置顶，作为默认进入项） */
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("channel");

  /* Tab 切换 */
  const [activeTabId, setActiveTabId] = useState((visibleBots[0]?.id ?? requestedCreatingBotId) || "creating");
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  // bots 异步加载完成后，若当前 tab 无效则自动切换到第一个可展示 bot
  useEffect(() => {
    if (isCreating) return;
    if (visibleBots.length > 0 && !visibleBots.some((b) => b.id === activeTabId)) {
      setActiveTabId(visibleBots[0]!.id);
    }
  }, [visibleBots, activeTabId, isCreating]);
  const activeBot = visibleBots.find((b) => b.id === activeTabId) ?? visibleBots[0];

  /**
   * AgentChat（LightVela）启动 token：
   * - 接口：`POST /v1/instances/:instanceId/agentchat/launch-token`，需带 LightClaw Bearer 登录态
   * - TTL：300 秒；过期前 60 秒自动续期
   * - 仅在用户进入 chat tab 且 activeBot 存在时拉取，避免无意义请求
   * - 401 / 网络错误：状态置为 error，由 chat tab UI 提示并提供重试
   */
  const [launchToken, setLaunchToken] = useState<string | null>(null);
  const [launchTokenStatus, setLaunchTokenStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [launchTokenError, setLaunchTokenError] = useState<string | null>(null);
  const [launchTokenRefreshTick, setLaunchTokenRefreshTick] = useState(0);

  const activeBotId = activeBot?.id;

  useEffect(() => {
    // 仅在 chat tab 激活、activeBot 已就位、用户已登录（拿到账号 id）时拉取
    if (activeSection !== "chat" || !activeBotId) {
      return;
    }
    if (!accountId) {
      setLaunchTokenStatus("error");
      setLaunchTokenError("未登录，无法获取账号 id");
      return;
    }

    const baseUrl = resolveConfiguredAuthApiBaseUrl();
    if (!baseUrl) {
      setLaunchTokenStatus("error");
      setLaunchTokenError("未配置后端地址（VITE_AUTH_API_BASE_URL）");
      return;
    }

    const authToken = readStoredAuthToken();
    if (!authToken) {
      setLaunchTokenStatus("error");
      setLaunchTokenError("未登录，无法获取 AgentChat 启动 token");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchLaunchToken = async () => {
      setLaunchTokenStatus("loading");
      setLaunchTokenError(null);
      try {
        const url = `${baseUrl.replace(/\/$/, "")}/v1/instances/${encodeURIComponent(activeBotId)}/agentchat/launch-token`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: "{}",
          signal: controller.signal,
        });

        if (!response.ok) {
          if (cancelled) return;
          let detail = `HTTP ${response.status}`;
          try {
            const body = await response.json() as { code?: string; message?: string };
            if (body?.message) detail = `${body.code ?? response.status}: ${body.message}`;
          } catch {
            // 忽略响应体解析错误
          }
          setLaunchTokenStatus("error");
          setLaunchTokenError(detail);
          return;
        }

        const json = await response.json() as {
          code?: string;
          data?: { launch_token?: string; expires_at?: number };
          message?: string;
        };
        if (cancelled) return;

        const token = json?.data?.launch_token;
        const expiresAt = json?.data?.expires_at;
        if (!token) {
          setLaunchTokenStatus("error");
          setLaunchTokenError(json?.message || "返回数据缺少 launch_token");
          return;
        }

        setLaunchToken(token);
        setLaunchTokenStatus("ready");

        // 过期前 60s 触发续期；若返回的 expires_at 不可信则按 4 分钟兜底
        const now = Math.floor(Date.now() / 1000);
        const ttlSeconds = typeof expiresAt === "number" && expiresAt > now
          ? expiresAt - now
          : 300;
        const refreshAfterMs = Math.max(30, ttlSeconds - 60) * 1000;
        refreshTimer = setTimeout(() => {
          if (!cancelled) {
            setLaunchTokenRefreshTick((tick) => tick + 1);
          }
        }, refreshAfterMs);
      } catch (e) {
        if (cancelled || (e as Error)?.name === "AbortError") return;
        setLaunchTokenStatus("error");
        setLaunchTokenError((e as Error)?.message || "请求失败");
      }
    };

    fetchLaunchToken();

    return () => {
      cancelled = true;
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [activeSection, activeBotId, accountId, launchTokenRefreshTick]);

  // 切到非 chat tab 或换 bot 时，清空已缓存的 token，避免泄露给下个 bot
  useEffect(() => {
    if (activeSection !== "chat") {
      setLaunchToken(null);
      setLaunchTokenStatus("idle");
      setLaunchTokenError(null);
    }
  }, [activeSection, activeBotId]);

  const retryLaunchToken = useCallback(() => {
    setLaunchTokenRefreshTick((tick) => tick + 1);
  }, []);


  /**
   * tea-sdk-lightclaw 的 ModelCard / ChannelCard / SkillCard 内部通过
   * 自定义 `runCommand` + `getInvocationTask` 把命令下发到 mono 后端。
   *
   * 和存量业务（channel 配置、onboard、debug 排错等）保持一致，走通用
   * 入口 `POST /v1/instances/:botId/debug/exec`（envd process stream），
   * 不再使用腾讯云 TAT。
   *
   * 业务约定：把 `activeBot.id` 作为 SDK `IInstanceInfo.InstanceId` 传入，
   * SDK 内部 `InstanceIds: [instance.InstanceId]` 原样透传给适配器，
   * 适配器从 `InstanceIds[0]` 拿到的就是 botId，无需额外映射或查询
   * sandbox_id。
   */
  const commandAdapter = useMemo(
    () =>
      createMonoDebugExecAdapter({
        baseUrl: resolveConfiguredAuthApiBaseUrl() ?? "",
        getAuthHeader: () => {
          const token = readStoredAuthToken();
          return token ? `Bearer ${token}` : undefined;
        },
      }),
    [],
  );

  /**
   * LightVelaPanel 用的 commandExecutor。
   *
   * 与上方 `commandAdapter`（给 `@tencent/tea-sdk-lightclaw` SDK 走 TAT 协议
   * 的适配器）不同，LightVelaPanel 接受的是 ClawPanel 公共层定义的更直接的
   * `CommandExecutor` 契约（`(options) => Promise<{ taskStatus, exitCode, output, ... }>`）。
   *
   * 两者底层都走 mono debug/exec，但接口形状不同：
   *   - commandAdapter：runCommand → getInvocationTask 两步式（兼容 SDK 的 TAT 模型）
   *   - lightvelaCommandExecutor：单步同步返回（贴近 LightVelaPanel 期望）
   *
   * 仅在 activeBot 存在时构造；切换到无 bot 状态会传 undefined，让 panel
   * 内部 fallback 到默认 TAT 通道（实际 lightvela 场景不会走到）。
   */
  const lightvelaCommandExecutor = useMemo(
    () => activeBotId
      ? createLightVelaCommandExecutor(repositories, activeBotId)
      : undefined,
    [repositories, activeBotId],
  );

  /* 删除相关 */
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!activeBot || deleteInput !== activeBot.name) return;
    setDeleteError(null);
    try {
      await deleteBot(activeBot.id);
      setShowDeleteConfirm(false);
      setDeleteInput("");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("删除失败，请稍后重试。"));
    }
  };

  /*
   * 重置配置（轮换 API Key）相关
   * ──────────────────────────────────────────────────────────────
   * 服务端 reset 成功后旧 key 立即作废；前端必须把本次返回的新运行时
   * config 立刻下发到实例。若后续 acli 命令失败，用户再次重置会重新
   * rotate key，因此明文 apiKey 只保存在本次 try 块内，不进入 React state。
   */
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [viewedChannelBotIds, setViewedChannelBotIds] = useState<Set<string>>(new Set());

  const handleResetConfig = async () => {
    const hasViewedChannel = activeBot ? viewedChannelBotIds.has(activeBot.id) : false;
    if (getResetBlockReason(activeBot, resetting, hasViewedChannel)) return;
    const targetBotId = activeBot?.id;
    if (!targetBotId) return;

    setResetting(true);
    setResetError(null);
    try {
      const result = await repositories.bots.resetInstanceConfig(targetBotId);

      const resetBackendResult = await repositories.bots.execDebugCommand(
        targetBotId,
        "acli backend reset-config",
      );
      if (!isExecCommandSucceeded(resetBackendResult)) {
        throw new Error(
          t("初始化配置文件失败：{{detail}}", {
            detail: truncateExecOutput(resetBackendResult.output, resetBackendResult.status),
          }),
        );
      }

      const providerSaveCmd = hermesModelCommands.getProviderSaveCommand({
        name: result.config.providerName,
        baseUrl: result.config.baseUrl,
        api: result.config.api,
        apiKey: result.config.apiKey,
        models: [{ id: result.config.modelId, name: hermesModelName(result.config.modelId) }],
      });
      const providerSaveResult = await repositories.bots.execDebugCommand(targetBotId, providerSaveCmd);
      if (!isExecCommandSucceeded(providerSaveResult)) {
        const sanitizedOutput = result.config.apiKey
          ? providerSaveResult.output.replace(
              new RegExp(result.config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
              "sk-***",
            )
          : providerSaveResult.output;
        throw new Error(
          t("默认模型保存失败：{{detail}}", {
            detail: truncateExecOutput(sanitizedOutput, providerSaveResult.status),
          }),
        );
      }

      const switchModelCmd = hermesModelCommands.getModelSwitchCommand(
        hermesSwitchModelFullId(result.config.providerName, result.config.modelId),
      );
      const switchModelResult = await repositories.bots.execDebugCommand(targetBotId, switchModelCmd);
      if (!isExecCommandSucceeded(switchModelResult)) {
        const sanitizedSwitchOutput = result.config.apiKey
          ? switchModelResult.output.replace(
              new RegExp(result.config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
              "sk-***",
            )
          : switchModelResult.output;
        throw new Error(
          t("默认模型切换失败：{{detail}}", {
            detail: truncateExecOutput(sanitizedSwitchOutput, switchModelResult.status),
          }),
        );
      }

      setShowResetConfirm(false);
      toast.success(t("重置成功"));
    } catch (err) {
      setResetError(err instanceof Error ? err.message : t("重置失败，请重试"));
      toast.error(t("重置失败，请重试"));
    } finally {
      setResetting(false);
    }
  };

  const CHANNEL_TAB_BOOTSTRAP_GRACE_MS = 3000;
  useEffect(() => {
    if (activeSection !== "channel" || !activeBot) return;
    const botId = activeBot.id;
    const timer = window.setTimeout(() => {
      setViewedChannelBotIds((prev) => {
        if (prev.has(botId)) return prev;
        const next = new Set(prev);
        next.add(botId);
        return next;
      });
    }, CHANNEL_TAB_BOOTSTRAP_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [activeSection, activeBot?.id]);

  /* 通道弹窗 */
  const [showChannelModal, setShowChannelModal] = useState(false);

  /* 出生证明 */
  const [showBirthCert, setShowBirthCert] = useState(false);

  /* Terminal 弹窗 */
  const [showTerminal, setShowTerminal] = useState(false);

  /* ── 重启 Gateway ── */
  // restartingBotIds: 正在重启的 bot ID 集合，支持多 bot 并行重启
  const [restartingBotIds, setRestartingBotIds] = useState<Set<string>>(new Set());
  // 错误按 bot 维度存储，多 bot 并行失败时各自保留错误信息
  const [restartErrors, setRestartErrors] = useState<RestartErrors>(new Map());

  // execDebugCommand 是同步等待命令执行完成的接口。
  // 当返回 SUCCESS 时 `harness gateway restart` 已经执行完毕，
  // gateway 进程重启不会改变实例的 running 状态，因此不需要轮询。
  // 保留短暂视觉反馈（1.5s）让用户感知到操作已执行。
  const RESTART_FEEDBACK_MS = 1500;

  const handleRestartGateway = async () => {
    if (getRestartBlockReason(activeBot, restartingBotIds)) return;
    const targetBotId = activeBot!.id;
    setRestartingBotIds((prev) => new Set(prev).add(targetBotId));
    setRestartErrors((prev) => clearErrorForBot(prev, targetBotId));
    try {
      const result = await repositories.bots.execDebugCommand(targetBotId, hermesGatewayCommands.getRestartCommand());
      const errorMsg = buildRestartErrorMessage(result);
      if (errorMsg) {
        setRestartErrors((prev) => setErrorForBot(prev, targetBotId, errorMsg));
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
        return;
      }
      // 命令已成功执行完毕，短暂保持视觉反馈后恢复
      setTimeout(() => {
        setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
      }, RESTART_FEEDBACK_MS);
    } catch (err) {
      setRestartErrors((prev) => setErrorForBot(prev, targetBotId, err instanceof Error ? err.message : t("重启失败")));
      setRestartingBotIds((prev) => { const next = new Set(prev); next.delete(targetBotId); return next; });
    }
  };

  // 当前 tab 的 bot 是否正在重启
  const isActiveBotRestarting = computeIsActiveBotRestarting(activeBot, restartingBotIds);
  // 当前 tab 是否展示错误
  const activeBotRestartError = getActiveBotRestartError(activeBot, restartErrors);

  useEffect(() => {
    return installOpenClawConsoleHelpers({
      host: window as Window & { help?: unknown; terminal?: unknown; console: Console },
      getTerminalPath: () => (activeBot ? `/bots/${activeBot.id}/terminal` : null),
    });
  }, [activeBot]);

  useEffect(() => {
    if (!creatingParam) return;
    if (completedCreatingBot) {
      setIsCreating(false);
      setCreationError(null);
      setActiveTabId(completedCreatingBot.id);
      navigate("/dashboard/settings", { replace: true });
      return;
    }
    if (creatingParam === "true" && !requestedCreatingBotId && !provisioningBot && !botsLoading) {
      setIsCreating(false);
      setCreationError(null);
      navigate("/dashboard/settings", { replace: true });
      return;
    }
    setIsCreating(true);
    setCreationError(null);
    if (requestedCreatingBotId) {
      setActiveTabId(requestedCreatingBotId);
      return;
    }
    if (provisioningBot) {
      setActiveTabId(provisioningBot.id);
    }
  }, [creatingParam, requestedCreatingBotId, provisioningBot, completedCreatingBot, botsLoading, navigate]);

  /*
   * 刷新恢复：URL 丢 creating 参数但后端仍有 provisioning bot 时，把用户带回等待页。
   *
   * 与下方「兜底退出」存在 race：polling 退出后 URL 被清，期间「兜底退出」会主动
   * setIsCreating(false)；本 effect 若同帧把它翻回 true，下一帧「兜底退出」再翻
   * 回 false，最终收敛到非 loading 态。短暂闪烁可接受。
   */
  useEffect(() => {
    if (creatingParam || isCreating || botsLoading || !provisioningBot) return;
    setIsCreating(true);
    setCreationError(null);
    setActiveTabId(provisioningBot.id);
    navigate(`/dashboard/settings?creating=${encodeURIComponent(provisioningBot.id)}`, { replace: true });
  }, [creatingParam, isCreating, botsLoading, provisioningBot, navigate]);

  /*
   * 兜底退出 loading：只看 bots 列表证据主动 setIsCreating(false)，收敛 polling
   * cleanup race（polling effect 在 await refreshBots 期间被自身 cleanup 抛弃，
   * setIsCreating(false) 永远没执行）。
   *
   *   模式 A：URL 携带 botId —— 只看该 botId，天然支持多 bot 并发，不误伤其他 provisioning。
   *   模式 B：URL 不指定 botId —— 无 provisioning bot 且有可见 bot 时退出。
   *
   * 不放 botsLoading 在 deps 里 —— refreshBots 期间必须能继续兜底，否则错过时机。
   */
  useEffect(() => {
    if (!isCreating || creationError) return;
    if (requestedCreatingBotId) {
      const targetBot = bots.find((b) => b.id === requestedCreatingBotId);
      if (targetBot && targetBot.status !== "provisioning" && targetBot.status !== "deleting") {
        setIsCreating(false);
        setCreationError(null);
        setActiveTabId(targetBot.id);
        navigate("/dashboard/settings", { replace: true });
      }
      return;
    }
    if (!provisioningBot && bots.some((b) => b.status !== "provisioning" && b.status !== "deleting")) {
      setIsCreating(false);
      setCreationError(null);
      navigate("/dashboard/settings", { replace: true });
    }
  }, [isCreating, creationError, requestedCreatingBotId, bots, provisioningBot, navigate]);

  /* 创建态只以后端真实状态为准：Running 才进入设置页，Failed/Deleting 停在错误态。 */
  useEffect(() => {
    if (!isCreating || creationError) return;

    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const pollCreationStatus = async () => {
      const targetBotId = requestedCreatingBotId || provisioningBot?.id;
      if (!targetBotId) {
        if (!cancelled && !botsLoading) {
          timer = window.setTimeout(pollCreationStatus, CREATING_POLL_INTERVAL_MS);
        }
        return;
      }

      try {
        const targetBot = await (async () => {
          try {
            const snapshot = await repositories.bots.getSettingsSnapshot(targetBotId);
            return snapshot.bot;
          } catch (detailError) {
            const dashboard = await repositories.bots.getDashboardSnapshot("live");
            const listedBot = dashboard.bots.find((bot) => bot.id === targetBotId);
            if (listedBot) return listedBot;
            throw detailError;
          }
        })();
        if (cancelled) return;

        if (targetBot.status === "active") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate("/dashboard/settings", { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status === "failed") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate("/dashboard/settings", { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status === "deleting") {
          setIsCreating(false);
          setCreationError(null);
          navigate("/dashboard/settings", { replace: true });
          await refreshBots();
          return;
        }

        if (targetBot.status !== "provisioning") {
          setIsCreating(false);
          setCreationError(null);
          setActiveTabId(targetBotId);
          navigate("/dashboard/settings", { replace: true });
          await refreshBots();
          return;
        }
      } catch (err) {
        console.error("poll bot creation status failed:", err);
      }

      if (cancelled) return;

      if (Date.now() - startedAt >= CREATING_MAX_WAIT_MS) {
        setCreationError(t("Hermes 仍在创建中，请稍后刷新页面查看状态。"));
        return;
      }

      if (!cancelled) {
        timer = window.setTimeout(pollCreationStatus, CREATING_POLL_INTERVAL_MS);
      }
    };

    void pollCreationStatus();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    isCreating,
    creationError,
    requestedCreatingBotId,
    provisioningBot?.id,
    repositories.bots,
    refreshBots,
    navigate,
  ]);

  const handleCreateNew = () => {
    if (createLimitMessage) {
      setDirectCreateError(createLimitMessage);
      return;
    }
    if (isSubscribed) {
      // 已订阅：弹确认框，直接创建，不跳套餐页
      setDirectCreateError(null);
      setShowCreateConfirm(true);
    } else {
      // 未订阅：跳转套餐订阅页
      navigate("/subscribe");
    }
  };

  const handleConfirmCreate = async () => {
    setDirectCreating(true);
    setDirectCreateError(null);
    try {
      const newBot = await addBot({
        name: t("我的Hermes"),
        personality: t("默认设定"),
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
      });
      setShowCreateConfirm(false);
      // 进入页面内 loading 状态，带上新 bot id 供轮询定位
      setIsCreating(true);
      navigate(`/dashboard/settings?creating=${encodeURIComponent(newBot.id)}`, { replace: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      // 将后端错误映射为用户友好文案
      let friendlyMsg: string;
      if (/quota|limit|exceed/i.test(raw)) {
        friendlyMsg = t("当前套餐的 Agent 配额已满，请升级套餐或删除现有 Agent 后重试。");
      } else if (/resource|sandbox|pool|exhaust/i.test(raw)) {
        friendlyMsg = t("云端资源暂时紧张，请稍后再试。");
      } else if (/timeout|timed?\s*out/i.test(raw)) {
        friendlyMsg = t("创建超时，请稍后重试。");
      } else if (/network|fetch|connect/i.test(raw)) {
        friendlyMsg = t("网络异常，请检查网络后重试。");
      } else {
        friendlyMsg = raw || t("创建失败，请稍后重试。");
      }
      setDirectCreateError(friendlyMsg);
    } finally {
      setDirectCreating(false);
    }
  };

  const avatarUrl = activeBot ? getAvatarForBot(activeBot.id) : "";

  return (
    <div className="flex min-h-screen flex-col bg-white" style={{ color: "rgba(0,0,0,0.90)" }}>
      <SettingsNavbar />

      {/* Delete Confirm Dialog */}
      {showDeleteConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(220,38,38,0.08)" }}>
                <AlertTriangle className="h-5 w-5" style={{ color: "#DC2626" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("确认删除")}</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "12px" }}>
              {t("删除后会话将立即断开，数据将无法恢复。")}
            </p>
            <p style={{ color: "var(--lw-fg)", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              {t("如确认删除，请输入名称 {{name}}：", { name: activeBot.name })}
            </p>
            <input
              type="text"
              placeholder={t("请输入 {{name}}", { name: activeBot.name })}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]"
              style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }}
            />
            {deleteError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{deleteError}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleDelete()}
                disabled={deleteInput !== activeBot.name}
                className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all"
                style={{
                  backgroundColor: deleteInput === activeBot.name ? "#DC2626" : "#E5E7EB",
                  cursor: deleteInput === activeBot.name ? "pointer" : "not-allowed",
                }}
              >
                {t("确认删除")}
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="py-2 text-sm transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer" }}>
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Reset Config Confirm Dialog */}
      {showResetConfirm && activeBot && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!resetting) setShowResetConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "var(--tea-color-border-default-alpha4, rgba(238,238,238,0.4))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "var(--tea-color-warning-default-alpha10, rgba(245,158,11,0.10))" }}>
                <Wrench className="h-5 w-5" style={{ color: "var(--tea-color-warning-default, #F59E0B)" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("恢复初始设置")}</h3>
            </div>
            <p style={{ color: "var(--tea-color-text-secondary, #666)", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("将保留当前工作空间、记忆和定时任务，并初始化配置文件，模型相关配置不会保留。")}
            </p>
            {resetError && (
              <pre
                className="whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-xs"
                style={{
                  color: "var(--tea-color-text-error-default, #DC2626)",
                  backgroundColor: "var(--tea-color-text-error-default-alpha4, rgba(220,38,38,0.04))",
                  borderColor: "var(--tea-color-text-error-default-alpha18, rgba(220,38,38,0.18))",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                  maxHeight: "180px",
                  overflowY: "auto",
                  marginBottom: "12px",
                }}
              >
                {resetError}
              </pre>
            )}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleResetConfig()}
                disabled={resetting}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all"
                style={{
                  backgroundColor: resetting ? "var(--tea-color-bg-disabled, #E5E7EB)" : "var(--tea-color-warning-default, #F59E0B)",
                  cursor: resetting ? "not-allowed" : "pointer",
                }}
              >
                {resetting && <Loader2 className="h-4 w-4 animate-spin" />}
                {resetting ? t("恢复中...") : t("确认恢复")}
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
                className="py-2 text-sm transition-colors hover:opacity-70"
                style={{ color: "var(--tea-color-text-secondary, #999)", background: "none", border: "none", cursor: resetting ? "not-allowed" : "pointer" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Create Confirm Dialog */}
      {showCreateConfirm && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => { if (!directCreating) setShowCreateConfirm(false); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="mx-4 w-full max-w-sm rounded-2xl border bg-white p-6 shadow-2xl"
            style={{ borderColor: "rgba(238,238,238,0.4)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3" style={{ marginBottom: "20px" }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(7,193,96,0.08)" }}>
                <Sparkles className="h-5 w-5" style={{ color: "#07C160" }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>{t("创建新智能体")}</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "20px" }}>
              {t("即刻创建全新的 Hermes Agent")}
            </p>
            {directCreateError && <p className="text-xs" style={{ color: "#DC2626", marginBottom: "12px" }}>{directCreateError}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => void handleConfirmCreate()}
                disabled={directCreating}
                className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all"
                style={{
                  backgroundColor: directCreating ? "#9CA3AF" : "var(--lw-fg)",
                  cursor: directCreating ? "not-allowed" : "pointer",
                }}
              >
                {directCreating && <Loader2 className="h-4 w-4 animate-spin" />}
                {directCreating ? t("创建中...") : directCreateError ? t("重试") : t("确认创建")}
              </button>
              <button
                onClick={() => setShowCreateConfirm(false)}
                disabled={directCreating}
                className="py-2 text-sm transition-colors hover:opacity-70"
                style={{ color: "#999", background: "none", border: "none", cursor: directCreating ? "not-allowed" : "pointer" }}
              >
                {t("取消")}
              </button>
            </div>
          </motion.div>
        </div>,
        document.body,
      )}

      {/* Channel Modal */}
      {showChannelModal && activeBot && (
        <ChannelModal bot={activeBot} onClose={() => setShowChannelModal(false)} />
      )}

      {/* Birth Certificate */}
      {showBirthCert && activeBot && (
        <BirthCertificateModal bot={activeBot} onClose={() => setShowBirthCert(false)} />
      )}

      {/* Terminal Modal */}
      <AnimatePresence>
        {showTerminal && activeBot && (
          <TerminalModal
            key={activeBot.id}
            botId={activeBot.id}
            botName={activeBot.name}
            onClose={() => setShowTerminal(false)}
          />
        )}
      </AnimatePresence>

      <main className="lw-app-top-pad flex-grow bg-[#F7F8FA] px-6 pb-12 md:px-[80px]">
        <section className="mx-auto" style={{ maxWidth: 1440 }}>
          {/* ── Loading 状态 ── */}
          {botsLoading && !isCreating && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin" style={{ color: "rgba(55,53,47,0.2)" }} />
              <span className="ml-3 text-sm" style={{ color: "rgba(0,0,0,0.40)" }}>{t("加载中...")}</span>
            </div>
          )}

          {/* ── 创建 Loading 动画 ── */}
          {isCreating && (
            <CreatingLoadingView errorMessage={creationError} />
          )}

          {/* ── 设置区域 ── */}
          {!isCreating && !botsLoading && activeBot && (
            (() => {
              const sdkInstance: IInstanceInfo = {
                InstanceId: activeBot.id,
                RegionId: 1,
              };
              const sdkRegionShortName = "gz";
              const sdkFeatureFlags: IFeatureFlags = {
                gateway: true,
                channel: true,
                wecomChannel: true,
                adpChannel: false,
                wecomLongConn: true,
                yuanbaoChannel: false,
                weixinChannel: true,
                qrConfig: true,
                skills: true,
                webUI: false,
                memoryManagement: false,
                memoryV2: false,
                qqbotplugin: false,
              };
              const sdkProductConfig: IProductConfig = {
                ...createLighthouseConfig({
                  agentType: "hermes",
                  supportsTencentCloudApi: false,
                  isI18n: isGlobal,
                }),
                runCommand: commandAdapter.runCommand,
                getInvocationTask: commandAdapter.getInvocationTask,
              };
              const settingsSections: { id: SettingsSectionId; label: string; icon: React.ReactNode; badge?: string }[] = [
                { id: "channel", label: t("通道"), icon: <MessageCircle className="h-4 w-4" /> },
                { id: "model", label: t("模型"), icon: <BrainCircuit className="h-4 w-4" /> },
                { id: "skill", label: t("技能"), icon: <Wand2 className="h-4 w-4" /> },
                ...(!isGlobal
                  ? [{ id: "buddy" as const, label: t("人设"), icon: <UserRound className="h-4 w-4" />, badge: "NEW" }]
                  : []),
                { id: "chat", label: t("对话"), icon: <MessageSquare className="h-4 w-4" /> },
              ];
              const isRestartDisabled = isActiveBotRestarting || activeBot.status !== "running";
              const hasViewedChannel = viewedChannelBotIds.has(activeBot.id);
              const resetBlockReason = getResetBlockReason(activeBot, resetting, hasViewedChannel);
              const resetDisabled = resetting || resetBlockReason !== null;
              const resetTooltip =
                resetBlockReason === RESET_BLOCK_REASON.NOT_RUNNING || resetBlockReason === RESET_BLOCK_REASON.CHANNEL_NOT_VIEWED
                  ? t("请稍后")
                  : t("重置配置");

              return (
                <div className="grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <aside className="lg:sticky lg:top-[84px]">
                    <div className="rounded-lg border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
                      <div className="px-1 pb-2 text-xs font-medium text-black/35">
                        {t("选择 Agent")}
                      </div>
                      <div
                        role={visibleBots.length > 1 ? "button" : undefined}
                        tabIndex={visibleBots.length > 1 ? 0 : undefined}
                        onClick={() => {
                          if (visibleBots.length > 1) setIsAgentMenuOpen((open) => !open);
                        }}
                        onKeyDown={(event) => {
                          if (visibleBots.length <= 1) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setIsAgentMenuOpen((open) => !open);
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors",
                          visibleBots.length > 1 ? "hover:bg-black/[0.035]" : "cursor-default",
                        )}
                        aria-expanded={visibleBots.length > 1 ? isAgentMenuOpen : undefined}
                      >
                        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-black/[0.06] bg-black/[0.03]">
                          <img src={avatarUrl} alt="" className="h-8 w-8 object-contain" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-black/90" title={activeBot.name}>
                            {truncateBotName(activeBot.name)}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5 text-xs text-black/45">
                            {isActiveBotRestarting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ background: getBotStatusColor(activeBot.status) }}
                              />
                            )}
                            {isActiveBotRestarting ? t("重启中...") : getBotStatusLabel(activeBot.status)}
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!isRestartDisabled) void handleRestartGateway();
                              }}
                              aria-disabled={isRestartDisabled}
                              aria-label={t("重启")}
                              className={cn(
                                "ml-1 inline-flex h-5 items-center rounded px-1.5 text-xs font-medium transition-colors",
                                isRestartDisabled
                                  ? "cursor-not-allowed text-black/25"
                                  : "text-black/45 hover:bg-black/[0.06] hover:text-black/80",
                              )}
                              title={isActiveBotRestarting ? t("正在重启中") : t("重启 Hermes Agent 网关")}
                            >
                              {t("重启")}
                            </button>
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (resetDisabled) return;
                            setResetError(null);
                            setShowResetConfirm(true);
                          }}
                          aria-disabled={resetDisabled}
                          aria-label={resetTooltip}
                          className={cn(
                            "inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors",
                            resetDisabled
                              ? "cursor-not-allowed text-black/20"
                              : "text-black/35 hover:bg-amber-500/10 hover:text-amber-600",
                          )}
                          title={resetTooltip}
                        >
                          {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteInput("");
                            setShowDeleteConfirm(true);
                          }}
                          aria-label={t("删除")}
                          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-500/10"
                          title={t("删除此 Hermes")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        {visibleBots.length > 1 && (
                          <ChevronDown
                            className={cn("h-4 w-4 flex-shrink-0 text-black/35 transition-transform", isAgentMenuOpen && "rotate-180")}
                          />
                        )}
                      </div>

                      {visibleBots.length > 1 && isAgentMenuOpen && (
                        <div className="mt-1 rounded-md bg-black/[0.025] p-1">
                          {visibleBots.map((bot) => {
                            const isActive = bot.id === activeTabId;
                            return (
                              <button
                                key={bot.id}
                                type="button"
                                onClick={() => {
                                  setActiveTabId(bot.id);
                                  setIsAgentMenuOpen(false);
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors",
                                  isActive ? "bg-white text-black/90 shadow-sm" : "text-black/55 hover:bg-white/70 hover:text-black/80",
                                )}
                              >
                                <img src={getAvatarForBot(bot.id)} alt="" className="h-5 w-5 flex-shrink-0 rounded object-contain" />
                                <span className="min-w-0 flex-1 truncate" title={bot.name}>
                                  {truncateBotName(bot.name)}
                                </span>
                                {isActive && <Check className="h-3.5 w-3.5 text-black/55" />}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {activeBotRestartError && (
                        <p className="mt-2 px-1 text-xs leading-relaxed text-red-500">{activeBotRestartError}</p>
                      )}

                      {canCreateBot && (
                        <button
                          type="button"
                          onClick={handleCreateNew}
                          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black/70 transition-colors hover:bg-black/[0.035] hover:text-black/90"
                        >
                          <Plus className="h-4 w-4" />
                          {t("立即创建")}
                        </button>
                      )}
                    </div>

                    <nav
                      aria-label={t("实例配置导航")}
                      className="mt-4 rounded-lg border border-black/[0.06] bg-white p-2 shadow-[0_8px_28px_rgba(15,23,42,0.04)]"
                    >
                      {settingsSections.map((section) => {
                        const isActive = section.id === activeSection;
                        return (
                          <button
                            key={section.id}
                            type="button"
                            onClick={() => setActiveSection(section.id)}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "lw-settings-nav-item flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 font-medium transition-colors",
                              isActive
                                ? "bg-black/[0.06] text-black/90"
                                : "text-black/55 hover:bg-black/[0.035] hover:text-black/85",
                            )}
                          >
                            <span className="flex h-5 w-5 items-center justify-center">{section.icon}</span>
                            <span className="flex-1 text-left text-[15px]">{section.label}</span>
                            {section.badge && (
                              <span className="rounded-full bg-black/90 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">
                                {section.badge}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </nav>
                  </aside>

                  <section className="min-w-0">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={`${activeBot.id}-${activeSection}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.22 }}
                        className="_lh-claw-bot-panel"
                      >
                        <div className="_lh-claw-bot-panel__cards min-w-0">
                          {activeSection === "channel" && (
                            <ChannelPanel
                              instance={sdkInstance}
                              regionShortName={sdkRegionShortName}
                              featureFlags={sdkFeatureFlags}
                              productConfig={sdkProductConfig}
                            />
                          )}
                          {activeSection === "model" && (
                            <ModelPanel
                              instance={sdkInstance}
                              regionShortName={sdkRegionShortName}
                              featureFlags={sdkFeatureFlags}
                              productConfig={sdkProductConfig}
                            />
                          )}
                          {activeSection === "skill" && (
                            <SkillPanel
                              instance={sdkInstance}
                              regionShortName={sdkRegionShortName}
                              featureFlags={sdkFeatureFlags}
                              productConfig={sdkProductConfig}
                            />
                          )}
                          {activeSection === "buddy" && !isGlobal && (
                            <BuddyPanel botId={activeBot.id} />
                          )}
                          {activeSection === "chat" && (
                            <div className="h-[clamp(516px,calc(100vh-220px),960px)] overflow-hidden rounded-lg border border-black/[0.08] bg-white [&>*]:h-full">
                              {(launchTokenStatus === "idle" || launchTokenStatus === "loading") && (
                                <div className="flex h-full items-center justify-center p-6 text-sm text-black/60">
                                  {t("正在获取 AgentChat 启动 token…")}
                                </div>
                              )}
                              {launchTokenStatus === "error" && (
                                <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm">
                                  <p className="text-red-500">
                                    {t("获取 AgentChat 启动 token 失败：{{message}}", { message: launchTokenError || t("未知错误") })}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={retryLaunchToken}
                                    className="mt-3 inline-flex items-center rounded-md border border-black/[0.12] bg-white px-3 py-1.5 text-xs font-medium text-black/80 hover:bg-black/[0.04]"
                                  >
                                    {t("重试")}
                                  </button>
                                </div>
                              )}
                              {launchTokenStatus === "ready" && launchToken && accountId && (
                                <LightVelaPanel
                                  isHermesBlueprint={true}
                                  instanceIds={[sdkInstance.InstanceId]}
                                  instanceId={sdkInstance.InstanceId}
                                  region="ap-guangzhou"
                                  userId={accountId}
                                  product="lightvela"
                                  lightvelaApiParams={{
                                    businessCode: "lightvela",
                                    token: launchToken,
                                  }}
                                  commandExecutor={lightvelaCommandExecutor}
                                  features={{
                                    autoActivate: true,
                                    nativeWsGray: true,
                                  }}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    </AnimatePresence>
                  </section>
                </div>
              );
            })()
          )}

          {/* 空状态 */}
          {
            !isCreating && !botsLoading && visibleBots.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-sm" style={{ color: "rgba(0,0,0,0.40)" }}>{t("即刻创建你的第一个云端智能体伙伴")}</p>
                {createLimitMessage && (
                  <p className="mt-3 max-w-sm text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.48)" }}>
                    {createLimitMessage}
                  </p>
                )}
                <button
                  onClick={handleCreateNew}
                  disabled={!canCreateBot}
                  className={cn(
                    "mt-6 inline-flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold text-white transition-all",
                    canCreateBot
                      ? "bg-black/90 hover:opacity-90"
                      : "cursor-not-allowed bg-black/30",
                  )}
                >
                  {canCreateBot ? t("立即创建") : t("暂不可创建")}
                </button>
              </div>
            )
          }

        </section>
      </main>

      <LegalFooter />
    </div>
  );
};

import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
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
  Plus,
  AlertTriangle,
  TerminalSquare,
  Download,
  Pencil,
  ChevronDown,
  Key,
  Trash2,
  Search,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { deserialize } from "bson";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { useRepositories } from "@/contexts/repository-context";
import type { BotTerminalSession } from "@/domain/types";
import { avatarImageUrl } from "@/lib/avatar-image";

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

/* ─── Navbar ─── */

const SettingsNavbar = () => {
  return (
    <header
      className="fixed inset-x-0 top-0 z-50 border-b border-black/5 bg-white/90 backdrop-blur-[20px]"
    >
      <div className="mx-auto flex h-[60px] items-center justify-between max-w-[1440px] px-6 md:px-[80px]">
        <Link to="/" className="flex shrink-0 items-center">
          <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5affb0c4-cfed-4614-aa34-6868d88f1717.svg" alt="LightClaw" className="object-contain h-[32px]" />
        </Link>
        <Link
          to="/"
          className="inline-flex items-center justify-center h-[36px] px-5 bg-[#F5F5F5] text-black/90 rounded-[100px] border border-[#E6E9EF] shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:bg-black/5 transition-colors font-heading text-sm font-medium"
        >
          返回首页
        </Link>
      </div>
    </header>
  );
};

/* ─── Channel Section ─── */

type WeixinSessionStatus = "idle" | "creating" | "starting" | "waiting_qr" | "scanned" | "success" | "failed" | "expired" | "cancelled" | "timeout";

export const ChannelSection = () => {
  const repositories = useRepositories();
  // 游客模式 mock
  const bots = [{ id: "demo-lightclaw-001", name: "我的龙虾", connectedChannels: [] as ConnectedChannel[] }];
  const updateBot = async (_id: string, _data: Record<string, unknown>) => {};
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

  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null;
  const connectedChannels: ConnectedChannel[] = selectedBot?.connectedChannels ?? [];

  useEffect(() => {
    if (!bots.length) {
      setSelectedBotId("");
      return;
    }

    if (!selectedBotId || !bots.some((bot) => bot.id === selectedBotId)) {
      setSelectedBotId(bots[0]!.id);
    }
  }, [bots, selectedBotId]);

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
      void repositories.bots.cancelWeixinLoginSession(selectedBot.id, wxSessionId).catch(() => {});
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
      setChannelNotice("请先创建并选择一个 LightClaw，再接入通道。");
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
        setWxError(err instanceof Error ? err.message : "微信登录会话创建失败");
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
      setChannelNotice(result.gatewayRestarted ? "QQ channel 已配置，gateway 已重启。" : "QQ channel 已配置，但 gateway 未确认重启。");
    } catch (error) {
      setChannelNotice(error instanceof Error ? error.message : "QQ channel 配置失败");
    } finally {
      setSubmitting(false);
    }
  };

  /* ── 微信扫码状态对应的 UI 文案 ── */
  const wxStatusLabel: Record<string, { text: string; color: string }> = {
    creating: { text: "正在创建登录会话…", color: "#999" },
    starting: { text: "正在启动微信登录…", color: "#999" },
    waiting_qr: { text: "请使用微信扫描二维码", color: "#07C160" },
    scanned: { text: "已扫码，正在确认登录…", color: "#07C160" },
    success: { text: "微信通道接入成功！", color: "#07C160" },
    failed: { text: "登录失败", color: "#cf3d4c" },
    expired: { text: "二维码已过期", color: "#C67B1E" },
    cancelled: { text: "已取消", color: "#999" },
    timeout: { text: "登录超时", color: "#C67B1E" },
  };

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
              <h3 className="mb-1.5 text-lg font-bold" style={{ color: "var(--lw-fg)" }}>微信扫码接入</h3>

              {/* 状态提示 */}
              <p className="mb-4 text-center text-sm font-medium" style={{ color: wxStatusLabel[wxStatus]?.color ?? "#999" }}>
                {wxStatusLabel[wxStatus]?.text ?? "准备中…"}
              </p>

              {/* 二维码区域 */}
              <div
                className="mb-5 flex h-52 w-52 items-center justify-center rounded-xl border-2 border-dashed"
                style={{ borderColor: wxQrUrl ? "rgba(7,193,96,0.3)" : "rgba(238,238,238,0.4)", background: "rgba(245,243,239,0.5)" }}
              >
                {wxQrUrl ? (
                  <img
                    src={wxQrUrl}
                    alt="微信登录二维码"
                    className="h-44 w-44 rounded-lg"
                  />
                ) : wxStatus === "success" ? (
                  <div className="flex flex-col items-center gap-2">
                    <Check className="h-12 w-12" style={{ color: "#07C160" }} />
                    <span className="text-sm font-medium" style={{ color: "#07C160" }}>接入成功</span>
                  </div>
                ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                  <div className="flex flex-col items-center gap-2">
                    <X className="h-12 w-12" style={{ color: "#cf3d4c" }} />
                    <span className="text-xs text-center leading-relaxed" style={{ color: "#cf3d4c" }}>
                      {wxError || "请重试"}
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
                  <Check className="h-4 w-4" /> 完成
                </button>
              ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
                <div className="flex w-full gap-3">
                  <button onClick={closeQrModal} className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                    关闭
                  </button>
                  <button onClick={() => void handleWechatAuth()} className="lw-btn-primary flex-1">
                    重试
                  </button>
                </div>
              ) : (
                <button onClick={closeQrModal} className="w-full rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>
                  取消
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

        <div className="space-y-2">
          <label className="lw-label block">选择要配置的 LightClaw</label>
          <select
            value={selectedBotId}
            onChange={(event) => setSelectedBotId(event.target.value)}
            className="lw-input"
            disabled={!bots.length || submitting}
          >
            {bots.length ? bots.map((bot) => (
              <option key={bot.id} value={bot.id}>{bot.name}</option>
            )) : <option value="">暂无可配置 LightClaw</option>}
          </select>
        </div>

        {/* Channel selection */}
        <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: 25 }}>选择一个聊天软件接入你的 LightClaw</p>
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
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">通过QQ机器人与 LightClaw 对话</p>
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
              <Check className="h-3 w-3" /> 已安装
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
            重新选择技能专家
          </button>
        </div>
      ) : installing && selectedPersona ? (
        /* Installing state */
        <div className="text-center">
          <div className="mx-auto mb-4 text-3xl">{selectedPersona.icon}</div>
          <p className="mb-4 text-sm font-semibold" style={{ color: "var(--lw-fg)" }}>
            正在安装 {selectedPersona.name} {selectedPersona.nameEn}...
          </p>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold" style={{ color: "var(--lw-fg)" }}>安装进度</span>
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
          <p className="text-sm text-[var(--text-secondary)]">选择一个技能专家，让你的龙虾技能增强</p>
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
                  <p className="mb-3 text-xs font-bold text-[var(--text-tertiary)]">预装 Agent Skills</p>
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
                    开始安装 <Sparkles className="h-4 w-4" />
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

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const encodeBase64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const decodeFrame = async (frame: string | Blob | ArrayBuffer) => {
  if (typeof frame === "string") {
    return JSON.parse(frame);
  }
  if (frame instanceof Blob) {
    return decodeFrame(await frame.arrayBuffer());
  }
  const bytes = new Uint8Array(frame);
  try {
    return deserialize(bytes);
  } catch {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
};

const extractTerminalOutput = (message: any): string => {
  const payload = message?.Data;
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = [payload.Output, payload.Data, payload?.Data?.Output, payload?.Data?.Data];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      try {
        return decodeBase64(candidate);
      } catch {
        return candidate;
      }
    }
    if (candidate instanceof Uint8Array) {
      return new TextDecoder().decode(candidate);
    }
    if (candidate instanceof ArrayBuffer) {
      return new TextDecoder().decode(candidate);
    }
  }
  return "";
};

type ConnectionState = "loading" | "bootstrapping" | "authenticating" | "connected" | "closed" | "error";

/* ─── Terminal Modal ─── */

const TerminalModal = ({ botId, botName, onClose }: { botId: string; botName: string; onClose: () => void }) => {
  const repositories = useRepositories();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const authTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<BotTerminalSession | null>(null);

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
    terminal.writeln("LightClaw TAT Terminal");
    terminal.writeln("");

    terminal.onData((data) => {
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyInput",
        Data: { SessionId: activeSession.sessionId, Input: encodeBase64(data) },
      }));
    });

    const handleResize = () => {
      fitAddon.fit();
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (!activeSession || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        Type: "PtyResize",
        Data: { SessionId: activeSession.sessionId, Cols: terminal.cols, Rows: terminal.rows },
      }));
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
      const activeSession = sessionRef.current;
      const socket = socketRef.current;
      if (authTimerRef.current !== null) {
        window.clearTimeout(authTimerRef.current);
        authTimerRef.current = null;
      }
      if (activeSession && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ Type: "PtyStop", Data: { SessionId: activeSession.sessionId } }));
      }
      socket?.close();
      socketRef.current = null;
    };

    const connect = async () => {
      try {
        setConnectionState("bootstrapping");
        setError(null);
        const bootstrap = await repositories.bots.getTerminalSession(botId);
        if (cancelled) {
          return;
        }
        sessionRef.current = bootstrap;

        terminalRef.current?.reset();
        terminalRef.current?.writeln(`Connecting ${botName} (${botId})...`);
        fitAddonRef.current?.fit();

        const socket = new WebSocket(bootstrap.wsUrl);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          setConnectionState("authenticating");
          socket.send(JSON.stringify({
            Type: "SessionAuth",
            Data: {
              Uin: bootstrap.ownerUin,
              AppId: bootstrap.appId,
              InstanceId: bootstrap.instanceId,
              SessionId: bootstrap.sessionId,
            },
          }));
          authTimerRef.current = window.setTimeout(() => {
            socket.send(JSON.stringify({
              Type: "PtyStart",
              Data: {
                SessionId: bootstrap.sessionId,
                Cols: terminalRef.current?.cols ?? bootstrap.cols,
                Rows: terminalRef.current?.rows ?? bootstrap.rows,
              },
            }));
          }, 1000);
        };

        socket.onmessage = async (event) => {
          try {
            const message = await decodeFrame(event.data);
            switch (message?.Type) {
              case "PtyReady":
                setConnectionState("connected");
                terminalRef.current?.focus();
                return;
              case "PtyOutput": {
                const output = extractTerminalOutput(message);
                if (output) {
                  terminalRef.current?.write(output);
                }
                return;
              }
              case "PtyError":
              case "Error": {
                const messageText = message?.Data?.Message || "terminal error";
                setConnectionState("error");
                setError(messageText);
                terminalRef.current?.writeln(`\r\n[error] ${messageText}`);
                return;
              }
              default: {
                const output = extractTerminalOutput(message);
                if (output) {
                  terminalRef.current?.write(output);
                }
              }
            }
          } catch (decodeError) {
            terminalRef.current?.writeln(`\r\n[decode-error] ${String(decodeError)}`);
          }
        };

        socket.onerror = () => {
          setConnectionState("error");
          setError("websocket error");
          terminalRef.current?.writeln("\r\n[error] websocket error");
        };

        socket.onclose = (event) => {
          if (cancelled) {
            return;
          }
          setConnectionState("closed");
          terminalRef.current?.writeln(`\r\n[closed] code=${event.code}`);
        };
      } catch (connectError) {
        if (cancelled) {
          return;
        }
        setConnectionState("error");
        setError(connectError instanceof Error ? connectError.message : "终端连接失败");
      }
    };

    void connect();

    return () => {
      cancelled = true;
      closeSocket();
      sessionRef.current = null;
    };
  }, [botId, botName, repositories.bots]);

  const stateLabel: Record<ConnectionState, string> = {
    loading: "初始化...",
    bootstrapping: "获取会话...",
    authenticating: "认证中...",
    connected: "已连接",
    closed: "已断开",
    error: "连接失败",
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
            className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[rgba(255,255,255,0.1)] text-[var(--text-tertiary)]"
            title="关闭终端"
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

// 随机头像列表
const LIGHTCLAW_AVATARS = ["https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png", "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/46aee2ef-76f6-4f2d-922d-5d79c66d8ce8.png", "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/64d561c8-8c6b-40f7-acdf-29884bd1c187.png"];

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

  // 解析创建日期
  const createdDate = new Date(bornCardCreatedAt);
  const year = createdDate.getFullYear();
  const month = createdDate.getMonth() + 1;
  const day = createdDate.getDate();

  // 获取龙虾头像的绝对 URL
  const avatarPath = getAvatarForBot(bot.id) ?? "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png";
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
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2"/>
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5"/>
              </svg>
            </div>
            
            <div style={{ position: "absolute", top: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,15 Q15,5 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="2"/>
                <path d="M0,22 Q15,12 30,22 T60,22" fill="none" stroke="#E66F62" strokeWidth="1.5"/>
              </svg>
            </div>
            
            <div style={{ position: "absolute", bottom: 20, left: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2"/>
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5"/>
              </svg>
            </div>
            
            <div style={{ position: "absolute", bottom: 20, right: 20, width: 80, height: 40, opacity: 0.4 }}>
              <svg viewBox="0 0 60 30" style={{ width: "100%", height: "100%" }}>
                <path d="M0,8 Q15,18 30,8 T60,8" fill="none" stroke="#E66F62" strokeWidth="2"/>
                <path d="M0,15 Q15,25 30,15 T60,15" fill="none" stroke="#E66F62" strokeWidth="1.5"/>
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
                        alt="龙虾宝宝" 
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
                        LightClaw
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
                        个龙虾宝宝
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
              className="flex items-center gap-2 px-5 py-2.5 rounded-full font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60"
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
              className="flex items-center gap-2 px-5 py-2.5 rounded-full font-semibold transition-all hover:bg-[rgba(255,255,255,0.15)]"
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
  // 游客模式 mock
  const updateBot = async (_id: string, _data: Record<string, unknown>) => {};
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
      void repositories.bots.cancelWeixinLoginSession(bot.id, sid).catch(() => {});
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
        const isInstanceNotReady = status === 409 || code === "DEBUG_NOT_SUPPORTED" || code === "CHANNEL_LOGIN_CONFLICT";
        if (isInstanceNotReady) {
          setWxStatus("creating");
          setWxError(null);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        setWxStatus("failed");
        setWxError(err instanceof Error ? err.message : "微信登录会话创建失败");
        return;
      }
    }

    if (!sessionId || cancelledRef.current) return;
    setWxSessionId(sessionId);
    setWxStatus("starting");

    /* 步骤 2: 尝试 SSE 订阅 */
    const abortController = new AbortController();
    const onCancelCleanup = () => { abortController.abort(); };
    /* 当 cancelledRef 变 true 时 abort SSE（通过 closeQrModal） */

    let sseWorked = false;
    try {
      const events = repositories.bots.subscribeWeixinLoginSessionEvents(bot.id, sessionId, abortController.signal);
      for await (const { event, data } of events) {
        if (cancelledRef.current) { onCancelCleanup(); return; }
        sseWorked = true;

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
      /* SSE 连接失败 → 降级轮询 */
    }

    /* 步骤 3: 如果 SSE 没有工作或过早断开，降级到轮询 */
    if (!sseWorked && !cancelledRef.current) {
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
              <button onClick={closeQrModal} className="w-full rounded-full py-2.5 text-sm font-bold text-white" style={{ background: "#07C160", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                <Check className="h-4 w-4" /> 完成
              </button>
            ) : ["failed", "expired", "timeout"].includes(wxStatus) ? (
              <div className="flex w-full gap-3">
                <button onClick={closeQrModal} className="flex-1 rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>关闭</button>
                <button onClick={() => void handleWechatAuth()} className="flex-1 rounded-full py-2.5 text-sm font-bold text-white" style={{ background: "#07C160" }}>重试</button>
              </div>
            ) : (
              <button onClick={closeQrModal} className="w-full rounded-full border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--surface-muted)]" style={{ borderColor: "rgba(0,0,0,0.08)", color: "#666" }}>取消</button>
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
            <p className="text-sm text-[var(--text-secondary)]" style={{ marginBottom: "20px" }}>选择一个聊天软件接入你的 LightClaw</p>
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
                    className="w-full rounded-full py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
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
                  <button onClick={() => void handleQqSubmit()} disabled={submitting || !qqAppId.trim() || !qqAppSecret.trim()} className="w-full rounded-full py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50" style={{ background: "#E8503A", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
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

/* ─── Model Config Section ─── */

interface ConfiguredModel {
  id: string;
  provider: string;
  model: string;
  apiKeyMasked: string;
  isDefault: boolean;
}

const MODEL_PROVIDERS = [
  { label: "MiniMax Token Plan（国内）", value: "minimax" },
  { label: "OpenAI", value: "openai" },
  { label: "Anthropic (Claude)", value: "anthropic" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "Kimi（Moonshot）", value: "kimi" },
];

const MODEL_VERSIONS: Record<string, { label: string; value: string }[]> = {
  minimax: [
    { label: "MiniMax M2.7", value: "minimax-m2.7" },
    { label: "MiniMax M1", value: "minimax-m1" },
  ],
  openai: [
    { label: "GPT-4o", value: "gpt-4o" },
    { label: "GPT-4o Mini", value: "gpt-4o-mini" },
  ],
  anthropic: [
    { label: "Claude 3.5 Sonnet", value: "claude-3.5-sonnet" },
    { label: "Claude 3 Haiku", value: "claude-3-haiku" },
  ],
  deepseek: [
    { label: "DeepSeek V3", value: "deepseek-v3" },
    { label: "DeepSeek R1", value: "deepseek-r1" },
  ],
  kimi: [
    { label: "Kimi Coding Plan", value: "kimi-coding" },
    { label: "Kimi Chat", value: "kimi-chat" },
  ],
};

const ModelConfigSection = () => {
  const [provider, setProvider] = useState("minimax");
  const [modelVersion, setModelVersion] = useState("minimax-m2.7");
  const [authTab, setAuthTab] = useState<"oauth" | "apikey">("oauth");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const [configuredModels, setConfiguredModels] = useState<ConfiguredModel[]>([
    {
      id: "kimi-coding-1",
      provider: "Kimi Coding Plan",
      model: "kimi-coding",
      apiKeyMasked: "sk-****************",
      isDefault: true,
    },
  ]);

  const currentProviderLabel = MODEL_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
  const currentVersions = MODEL_VERSIONS[provider] ?? [];
  const currentVersionLabel = currentVersions.find((v) => v.value === modelVersion)?.label ?? modelVersion;

  const handleProviderChange = (value: string) => {
    setProvider(value);
    const versions = MODEL_VERSIONS[value] ?? [];
    const [firstVersion] = versions;
    if (firstVersion) {
      setModelVersion(firstVersion.value);
    }
    setProviderDropdownOpen(false);
  };

  const handleAddModel = () => {
    if (authTab === "apikey" && !apiKeyInput.trim()) return;
    const newModel: ConfiguredModel = {
      id: `${modelVersion}-${Date.now()}`,
      provider: currentProviderLabel,
      model: modelVersion,
      apiKeyMasked: authTab === "apikey" ? `sk-${"*".repeat(16)}` : "OAuth 授权",
      isDefault: configuredModels.length === 0,
    };
    setConfiguredModels((prev) => [...prev, newModel]);
    setApiKeyInput("");
  };

  const handleDeleteModel = (id: string) => {
    setConfiguredModels((prev) => {
      const next = prev.filter((m) => m.id !== id);
      const [firstModel] = next;
      if (firstModel && !next.some((m) => m.isDefault)) {
        firstModel.isDefault = true;
      }
      return next;
    });
  };

  const handleSetDefault = (id: string) => {
    setConfiguredModels((prev) =>
      prev.map((m) => ({ ...m, isDefault: m.id === id })),
    );
  };

  return (
    <div>
      <div className="mb-4 flex items-baseline gap-2">
        <span className="text-xl font-bold italic" style={{ color: "#4285F4" }}>1.</span>
        <h3 className="text-base font-bold" style={{ color: "rgba(0,0,0,0.90)" }}>模型 (Models)</h3>
      </div>
      <p className="mb-5 text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.50)" }}>
        添加至少 1 个模型，Agent 才能正常工作
      </p>

      <div className="space-y-4">
        {/* 模型提供商下拉 */}
        <div className="relative">
          <button
            onClick={() => { setProviderDropdownOpen(!providerDropdownOpen); setModelDropdownOpen(false); }}
            className="flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-sm font-medium transition-all hover:border-black/20"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.90)", background: "#fff", cursor: "pointer" }}
          >
            <span>{currentProviderLabel}</span>
            <ChevronDown className="h-4 w-4" style={{ color: "#999", transform: providerDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </button>
          <AnimatePresence>
            {providerDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border bg-white shadow-lg"
                style={{ borderColor: "rgba(0,0,0,0.06)" }}
              >
                {MODEL_PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => handleProviderChange(p.value)}
                    className="flex w-full items-center px-4 py-2.5 text-left text-sm transition-colors hover:bg-black/[0.03]"
                    style={{ color: p.value === provider ? "var(--lw-accent, #e66f62)" : "rgba(0,0,0,0.90)", fontWeight: p.value === provider ? 600 : 400, border: "none", background: "transparent", cursor: "pointer" }}
                  >
                    {p.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 模型版本下拉 */}
        <div className="relative">
          <button
            onClick={() => { setModelDropdownOpen(!modelDropdownOpen); setProviderDropdownOpen(false); }}
            className="flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-sm font-medium transition-all hover:border-black/20"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.90)", background: "#fff", cursor: "pointer" }}
          >
            <span>{currentVersionLabel}</span>
            <ChevronDown className="h-4 w-4" style={{ color: "#999", transform: modelDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </button>
          <AnimatePresence>
            {modelDropdownOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border bg-white shadow-lg"
                style={{ borderColor: "rgba(0,0,0,0.06)" }}
              >
                {currentVersions.map((v) => (
                  <button
                    key={v.value}
                    onClick={() => { setModelVersion(v.value); setModelDropdownOpen(false); }}
                    className="flex w-full items-center px-4 py-2.5 text-left text-sm transition-colors hover:bg-black/[0.03]"
                    style={{ color: v.value === modelVersion ? "var(--lw-accent, #e66f62)" : "rgba(0,0,0,0.90)", fontWeight: v.value === modelVersion ? 600 : 400, border: "none", background: "transparent", cursor: "pointer" }}
                  >
                    {v.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* OAuth / API Key 切换 Tab */}
        <div className="flex overflow-hidden rounded-xl border" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
          <button
            onClick={() => setAuthTab("oauth")}
            className="flex-1 px-4 py-2.5 text-sm font-medium transition-all"
            style={{
              background: authTab === "oauth" ? "#fff" : "rgba(0,0,0,0.02)",
              color: authTab === "oauth" ? "var(--lw-accent, #e66f62)" : "#999",
              borderRight: "1px solid rgba(0,0,0,0.1)",
              borderBottom: authTab === "oauth" ? "2px solid var(--lw-accent, #e66f62)" : "2px solid transparent",
              cursor: "pointer",
              border: "none",
              borderBottomWidth: 2,
              borderBottomStyle: "solid",
              borderBottomColor: authTab === "oauth" ? "var(--lw-accent, #e66f62)" : "transparent",
            }}
          >
            OAuth 授权
          </button>
          <button
            onClick={() => setAuthTab("apikey")}
            className="flex-1 px-4 py-2.5 text-sm font-medium transition-all"
            style={{
              background: authTab === "apikey" ? "#fff" : "rgba(0,0,0,0.02)",
              color: authTab === "apikey" ? "var(--lw-accent, #e66f62)" : "#999",
              cursor: "pointer",
              border: "none",
              borderBottomWidth: 2,
              borderBottomStyle: "solid",
              borderBottomColor: authTab === "apikey" ? "var(--lw-accent, #e66f62)" : "transparent",
            }}
          >
            API Key
          </button>
        </div>

        {/* 授权内容区 */}
        <AnimatePresence mode="wait">
          {authTab === "oauth" ? (
            <motion.div
              key="oauth"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <button
                onClick={handleAddModel}
                className="w-full rounded-xl border-2 border-dashed px-4 py-3 text-sm font-medium transition-all hover:border-[var(--lw-accent,#e66f62)] hover:text-[var(--lw-accent,#e66f62)]"
                style={{ borderColor: "rgba(0,0,0,0.10)", color: "#999", background: "transparent", cursor: "pointer" }}
              >
                OAuth 授权
              </button>
              <p className="mt-3 text-xs leading-relaxed" style={{ color: "#999" }}>
                {currentProviderLabel.split("（")[0]} 是国内领先的通用大模型公司，提供文本、语音、视觉等多模态AI能力，擅长长文本和复杂任务处理。
                <a
                  href="https://platform.minimaxi.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-0.5 font-medium"
                  style={{ color: "var(--lw-accent, #e66f62)" }}
                >
                  点击获取 API KEY <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="apikey"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-3 overflow-hidden"
            >
              <div className="relative">
                <Key className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "#bbb" }} />
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="输入 API Key (sk-...)"
                  className="w-full rounded-xl border py-2.5 pl-10 pr-4 text-sm outline-none transition-all focus:border-[var(--lw-accent,#e66f62)]"
                  style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.90)" }}
                />
              </div>
              <button
                onClick={handleAddModel}
                disabled={!apiKeyInput.trim()}
                className="w-full rounded-full py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-40"
                style={{ background: "var(--lw-accent, #e66f62)", cursor: apiKeyInput.trim() ? "pointer" : "not-allowed", border: "none" }}
              >
                保存并应用
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 切换模型 - 已配置模型列表 */}
        {configuredModels.length > 0 && (
          <div className="mt-2">
            <p className="mb-3 text-xs font-medium" style={{ color: "rgba(0,0,0,0.50)" }}>切换模型</p>
            <div className="space-y-2">
              {configuredModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-3 rounded-xl px-4 py-3 transition-all"
                  style={{
                    background: model.isDefault ? "rgba(230,111,98,0.03)" : "rgba(0,0,0,0.015)",
                    border: `1px solid ${model.isDefault ? "rgba(230,111,98,0.15)" : "rgba(0,0,0,0.06)"}`,
                  }}
                >
                  <button
                    onClick={() => handleSetDefault(model.id)}
                    className="flex items-center gap-2 text-left"
                    style={{ background: "none", border: "none", cursor: "pointer", flex: 1, minWidth: 0 }}
                  >
                    <span className="text-sm" style={{ color: "rgba(0,0,0,0.90)" }}>▸</span>
                    <span className="truncate text-sm font-semibold" style={{ color: "rgba(0,0,0,0.90)" }}>
                      {model.provider}
                    </span>
                    {model.isDefault && (
                      <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: "rgba(52,199,89,0.1)", color: "#34C759" }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#34C759" }} />
                        当前默认
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteModel(model.id)}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all hover:bg-[rgba(220,38,38,0.08)]"
                    style={{ color: "#ccc", border: "none", background: "transparent", cursor: "pointer" }}
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {configuredModels.length > 0 && (
                <p className="text-xs" style={{ color: "#bbb" }}>
                  API Key: {configuredModels.find((m) => m.isDefault)?.apiKeyMasked ?? "—"}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── Channel Settings Card (inline) ─── */

const ChannelSettingsCard = ({ bot, onOpenChannelModal }: { bot: { id: string; name: string; connectedChannels: string[] }; onOpenChannelModal: () => void }) => {
  const connectedChannels = (bot.connectedChannels ?? []) as ConnectedChannel[];

  return (
    <div>
      <div className="mb-4 flex items-baseline gap-2">
        <span className="text-xl font-bold italic" style={{ color: "#4285F4" }}>2.</span>
        <h3 className="text-base font-bold" style={{ color: "rgba(0,0,0,0.90)" }}>通道 (Channels)</h3>
      </div>
      <p className="mb-5 text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.50)" }}>
        配置通道后，即可在聊天软件中与 Agent 对话
      </p>

      <div className="space-y-3">
        {/* Channel selector dropdown placeholder */}
        <div className="relative">
          <select
            className="w-full appearance-none rounded-xl border bg-white px-4 py-2.5 text-sm font-medium outline-none transition-all hover:border-black/20"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.90)", cursor: "pointer" }}
            defaultValue="wechat"
          >
            <option value="wechat">微信</option>
            <option value="qq">QQ</option>
            <option value="feishu">飞书</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "#999" }} />
        </div>

        {/* Auth button */}
        <button
          onClick={onOpenChannelModal}
          className="w-full rounded-xl border px-4 py-2.5 text-sm font-medium transition-all hover:bg-black/[0.02]"
          style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.60)", background: "#fff", cursor: "pointer" }}
        >
          授权接入
        </button>

        {/* Description */}
        <p className="text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.40)" }}>
          微信是一款跨平台的通讯工具。
          <a href="https://weixin.qq.com" target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 font-medium" style={{ color: "#4285F4" }}>
            查看详情 <ExternalLink className="h-3 w-3" />
          </a>
        </p>

        {/* Connected channels */}
        {connectedChannels.length > 0 && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium" style={{ color: "rgba(0,0,0,0.50)" }}>已接入通道</p>
            <div className="space-y-2">
              {connectedChannels.map((ch) => (
                <div key={ch} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: "rgba(0,0,0,0.02)" }}>
                  <span className="text-sm" style={{ color: "rgba(0,0,0,0.90)" }}>▸</span>
                  <span className="flex-1 text-sm font-medium" style={{ color: "rgba(0,0,0,0.90)" }}>
                    {ch === "wechat" ? "微信" : ch === "qq" ? "QQ" : "飞书"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: "#34C759" }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#34C759" }} />
                    已接入
                  </span>
                  <button className="flex h-6 w-6 items-center justify-center rounded-full text-[#ccc] transition-all hover:bg-[rgba(220,38,38,0.08)]" style={{ border: "none", background: "transparent", cursor: "pointer" }}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── Skill Settings Card (inline) ─── */

interface InstalledSkill {
  name: string;
  version: string;
}

const SkillSettingsCard = () => {
  const [skillSearch, setSkillSearch] = useState("");
  const [installedSkills] = useState<InstalledSkill[]>([
    { name: "tavily-search", version: "1.0.0" },
    { name: "summarize", version: "1.0.0" },
    { name: "agent-browser", version: "0.2.0" },
    { name: "find-skills", version: "0.1.0" },
    { name: "github", version: "1.0.0" },
  ]);

  return (
    <div>
      <div className="mb-4 flex items-baseline gap-2">
        <span className="text-xl font-bold italic" style={{ color: "#4285F4" }}>3.</span>
        <h3 className="text-base font-bold" style={{ color: "rgba(0,0,0,0.90)" }}>技能 (Skills)</h3>
      </div>
      <p className="mb-1 text-xs leading-relaxed" style={{ color: "rgba(0,0,0,0.50)" }}>
        技能可拓展 Agent 能力，可按需添加
      </p>
      <p className="mb-5 text-xs leading-relaxed" style={{ color: "#FF9500" }}>
        ⚠ 谨慎安装未知来源技能
      </p>

      <div className="space-y-3">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "#bbb" }} />
          <input
            type="text"
            value={skillSearch}
            onChange={(e) => setSkillSearch(e.target.value)}
            placeholder="输入 SkillHub 中上架的 Skill 名称搜索"
            className="w-full rounded-xl border py-2.5 pl-10 pr-4 text-sm outline-none transition-all focus:border-black/20"
            style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.90)" }}
          />
        </div>

        {/* Install button */}
        <button
          className="w-full rounded-xl border px-4 py-2.5 text-sm font-medium transition-all hover:bg-black/[0.02]"
          style={{ borderColor: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.60)", background: "#fff", cursor: "pointer" }}
        >
          安装技能
        </button>

        {/* SkillHub link */}
        <a
          href="https://skillhub.lightclaw.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium"
          style={{ color: "#4285F4" }}
        >
          前往 SkillHub <ExternalLink className="h-3 w-3" />
        </a>

        {/* Installed skills */}
        {installedSkills.length > 0 && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium" style={{ color: "rgba(0,0,0,0.50)" }}>已安装技能</p>
            <div className="space-y-1.5">
              {installedSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="rounded-xl px-3 py-2.5 text-sm font-medium"
                  style={{ background: "rgba(0,0,0,0.02)", color: "rgba(0,0,0,0.90)" }}
                >
                  {skill.name} {skill.version}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ─── Creating Loading Animation ─── */

const CREATING_STEPS = [
  { text: "正在给 Hermes 喂咖啡，唤醒大脑中", emoji: "☕" },
  { text: "正在整理知识图谱，别急，他正在记笔记呢", emoji: "📝" },
  { text: "正在打扫云端办公室，为 Hermes 准备专座", emoji: "🏢" },
  { text: "Hermes 已经系好鞋带了，马上出发", emoji: "👟" },
];

const CreatingLoadingView = ({ onComplete }: { onComplete: () => void }) => {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (stepIndex < CREATING_STEPS.length - 1) {
      const timer = setTimeout(() => {
        setStepIndex((prev) => prev + 1);
      }, 2200);
      return () => clearTimeout(timer);
    } else {
      // 最后一步完成后等1.5s再触发完成
      const timer = setTimeout(() => {
        onComplete();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [stepIndex, onComplete]);

  const step = CREATING_STEPS[stepIndex] ?? CREATING_STEPS[CREATING_STEPS.length - 1] ?? { emoji: "🦞", text: "正在创建你的 LightClaw..." };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center justify-center py-20"
    >
      {/* Step Text */}
      <AnimatePresence mode="wait">
        <motion.div
          key={stepIndex}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center gap-3 text-center"
        >
          <span className="text-2xl">{step.emoji}</span>
          <p className="text-base font-medium" style={{ color: "rgba(55,53,47,0.65)", maxWidth: 400 }}>
            {step.text}
          </p>
        </motion.div>
      </AnimatePresence>

      {/* Progress dots */}
      <div className="mt-8 flex items-center gap-2">
        {CREATING_STEPS.map((_, idx) => (
          <div
            key={idx}
            className="h-1.5 rounded-full transition-all duration-500"
            style={{
              width: idx === stepIndex ? 24 : 8,
              background: idx <= stepIndex ? "rgba(55,53,47,0.3)" : "rgba(55,53,47,0.08)",
            }}
          />
        ))}
      </div>
    </motion.div>
  );
};

/* ─── Main Settings Page ─── */

export const OpenClawSettingsPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isCreatingFromSubscribe = searchParams.get("creating") === "true";

  // 创建 loading 状态
  const [isCreating, setIsCreating] = useState(isCreatingFromSubscribe);

  // 游客模式：根据是否从订阅页来决定初始数据
  const [bots, setBots] = useState(() => {
    if (isCreatingFromSubscribe) {
      // 从订阅页来，初始为空，只显示一个正在创建中的 tab
      return [] as Array<{
        id: string;
        name: string;
        status: "running" | "paused" | "draft";
        personality: string;
        personalityEmoji: string;
        intro: string;
        createdAt: string;
        connectedChannels: ConnectedChannel[];
        installedSkills: string[];
      }>;
    }
    return [
      {
        id: "demo-lightclaw-001",
        name: "我的龙虾",
        status: "running" as const,
        personality: "活泼好动",
        personalityEmoji: "🦞",
        intro: "一只快乐的小龙虾，喜欢在代码海洋里遨游",
        createdAt: "2026-03-20T10:30:00.000Z",
        connectedChannels: ["wechat"] as ConnectedChannel[],
        installedSkills: [] as string[],
      },
      {
        id: "demo-lightclaw-002",
        name: "小蓝鲸",
        status: "running" as const,
        personality: "温柔治愈",
        personalityEmoji: "🐋",
        intro: "温柔的蓝鲸宝宝，用治愈的话语陪伴你每一天",
        createdAt: "2026-04-05T14:20:00.000Z",
        connectedChannels: [] as ConnectedChannel[],
        installedSkills: [] as string[],
      },
    ];
  });

  const maxBots = 3;

  // 创建完成后的回调
  const handleCreatingComplete = useCallback(() => {
    const newBot = {
      id: `lightclaw-${Date.now()}`,
      name: "LightHermes",
      status: "running" as const,
      personality: "",
      personalityEmoji: "⚡",
      intro: "Hermes —— 你的专属 AI Agent，随时待命",
      createdAt: new Date().toISOString(),
      connectedChannels: [] as ConnectedChannel[],
      installedSkills: [] as string[],
    };
    setBots((prev) => [...prev, newBot]);
    setActiveTabId(newBot.id);
    setIsCreating(false);
    // 清除 URL 参数
    navigate("/openclaw/settings", { replace: true });
  }, [navigate]);

  const [activeTabId, setActiveTabId] = useState(bots[0]?.id ?? "creating");
  const activeBot = bots.find((b) => b.id === activeTabId) ?? bots[0];

  // 改名相关
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleStartRename = () => {
    if (!activeBot) return;
    setEditName(activeBot.name);
    setIsEditing(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const handleSaveRename = () => {
    if (!activeBot) return;
    const trimmed = editName.trim();
    if (trimmed && trimmed !== activeBot.name) {
      setBots((prev) => prev.map((b) => (b.id === activeBot.id ? { ...b, name: trimmed } : b)));
    }
    setIsEditing(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSaveRename();
    if (e.key === "Escape") setIsEditing(false);
  };

  // 删除相关
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");

  const handleDelete = () => {
    if (!activeBot) return;
    setBots((prev) => {
      const next = prev.filter((b) => b.id !== activeBot.id);
      const [firstBot] = next;
      if (firstBot && activeTabId === activeBot.id) {
        setActiveTabId(firstBot.id);
      }
      return next;
    });
    setShowDeleteConfirm(false);
    setDeleteInput("");
  };

  // 通道弹窗
  const [showChannelModal, setShowChannelModal] = useState(false);

  // 出生证明
  const [showBirthCert, setShowBirthCert] = useState(false);

  // Terminal 弹窗
  const [showTerminal, setShowTerminal] = useState(false);

  const avatarUrl = activeBot ? getAvatarForBot(activeBot.id) : "";

  const canCreateMore = bots.length < maxBots;
  const handleCreateNew = () => {
    if (canCreateMore) {
      setIsCreating(true);
    }
  };

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
              <h3 className="text-lg font-bold" style={{ color: "var(--lw-fg)" }}>确认删除</h3>
            </div>
            <p style={{ color: "#666", fontSize: "14px", lineHeight: 1.6, marginBottom: "12px" }}>
              删除后会话将立即断开，数据将无法恢复。
            </p>
            <p style={{ color: "var(--lw-fg)", fontSize: "14px", lineHeight: 1.6, marginBottom: "10px" }}>
              如确认删除，请输入名称 <strong>{activeBot.name}</strong>：
            </p>
            <input
              type="text"
              placeholder={`请输入 ${activeBot.name}`}
              value={deleteInput}
              onChange={(e) => setDeleteInput(e.target.value)}
              className="w-full rounded-xl border px-4 py-2.5 text-sm outline-none transition-all focus:border-[#DC2626]"
              style={{ borderColor: "var(--lw-border)", color: "var(--lw-fg)", marginBottom: "20px" }}
            />
            <div className="flex flex-col gap-2">
              <button
                onClick={handleDelete}
                disabled={deleteInput !== activeBot.name}
                className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all"
                style={{
                  backgroundColor: deleteInput === activeBot.name ? "#DC2626" : "#E5E7EB",
                  cursor: deleteInput === activeBot.name ? "pointer" : "not-allowed",
                }}
              >
                确认删除
              </button>
              <button onClick={() => setShowDeleteConfirm(false)} className="py-2 text-sm transition-colors hover:opacity-70" style={{ color: "#999", background: "none", border: "none", cursor: "pointer" }}>
                取消
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

      <main className="flex-grow px-6 pb-16 pt-24 md:px-8">
        <section className="mx-auto" style={{ maxWidth: 1200 }}>
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-6"
          >
            <h1
              className="font-heading font-semibold"
              style={{
                fontSize: "clamp(1.5rem, 3vw, 2rem)",
                letterSpacing: "-0.5px",
                lineHeight: 1.2,
                color: "rgba(0,0,0,0.90)",
              }}
            >
              我的 LightClaw
            </h1>
            <p className="mt-2 text-sm" style={{ color: "rgba(0,0,0,0.50)", lineHeight: 1.5 }}>
              管理你的 AI 龙虾、查看通道接入状态。
            </p>
          </motion.div>

          {/* ── Tab Bar: 切换不同 LightClaw ── */}
          <div
            className="mb-8 flex items-center gap-0.5"
            style={{ borderBottom: "1px solid rgba(0,0,0,0.05)" }}
          >
            {/* 正在创建中的 LightHermes tab */}
            {isCreating && (
              <button
                className="relative flex items-center gap-2 px-4 py-3 text-sm font-medium"
                style={{
                  color: "var(--lw-accent, #e66f62)",
                  background: "transparent",
                  border: "none",
                  cursor: "default",
                }}
              >
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--lw-accent, #e66f62)" }} />
                <span>LightHermes</span>
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                  style={{ background: "var(--lw-accent, #e66f62)" }}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              </button>
            )}
            {bots.map((bot) => {
              const isActive = bot.id === activeTabId && !isCreating;
              const tabAvatar = getAvatarForBot(bot.id);
              return (
                <button
                  key={bot.id}
                  onClick={() => {
                    if (!isCreating) {
                      setActiveTabId(bot.id);
                      setIsEditing(false);
                    }
                  }}
                  className="relative flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all"
                  style={{
                    color: isActive ? "var(--lw-accent, #e66f62)" : "#999",
                    background: "transparent",
                    border: "none",
                    cursor: isCreating ? "default" : "pointer",
                    opacity: isCreating ? 0.5 : 1,
                  }}
                >
                  <img src={tabAvatar} alt="" className="h-5 w-5 rounded-full object-contain" />
                  <span>{bot.name}</span>
                  {/* Active indicator */}
                  {isActive && (
                    <motion.div
                      layoutId="tab-indicator"
                      className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                      style={{ background: "var(--lw-accent, #e66f62)" }}
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </button>
              );
            })}
            {/* 新建 Tab */}
            {!isCreating && canCreateMore && (
              <button
                onClick={handleCreateNew}
                className="flex items-center gap-1 px-3 py-3 text-sm transition-all hover:bg-black/5 rounded-full"
                style={{ color: "rgba(0,0,0,0.35)", background: "transparent", border: "none", cursor: "pointer" }}
              >
                <Plus className="h-4 w-4" />
                <span>新建</span>
              </button>
            )}
          </div>

          {/* ── 创建 Loading 动画 ── */}
          {isCreating && (
            <CreatingLoadingView onComplete={handleCreatingComplete} />
          )}

          {/* ── 设置区域 ── */}
          {!isCreating && activeBot && (
          <AnimatePresence mode="wait">
            <motion.div
              key={activeBot.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="space-y-8"
            >
              {/* ─ 基本信息 ─ */}
              <div>
                <h2 className="mb-5 text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(0,0,0,0.50)" }}>
                  基本信息
                </h2>
                <div className="flex items-center gap-4">
                  {/* 头像 */}
                  <div
                    className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl"
                    style={{ background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.06)" }}
                  >
                    <img src={avatarUrl} alt="" className="h-11 w-11 object-contain" />
                  </div>
                  {/* 名称 + 元信息 */}
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <input
                          ref={nameInputRef}
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          onBlur={handleSaveRename}
                          className="rounded-full border px-3 py-1.5 text-base font-bold outline-none transition-all focus:border-black/30"
                          style={{ color: "rgba(0,0,0,0.90)", borderColor: "rgba(0,0,0,0.10)", maxWidth: 240 }}
                        />
                        <span className="text-xs" style={{ color: "rgba(0,0,0,0.35)" }}>按 Enter 保存</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold" style={{ color: "rgba(0,0,0,0.90)" }}>{activeBot.name}</h3>
                        <button
                          onClick={handleStartRename}
                          className="flex h-7 w-7 items-center justify-center rounded-full transition-all hover:bg-black/5"
                          style={{ color: "#bbb", border: "none", background: "transparent", cursor: "pointer" }}
                          title="重命名"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    {/* 状态 / 创建时间 / ID — 行内 */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: activeBot.status === "running" ? "#34C759" : activeBot.status === "paused" ? "#FF9500" : "#ccc" }}
                        />
                        <span className="text-xs font-medium" style={{ color: "rgba(0,0,0,0.60)" }}>
                          {activeBot.status === "running" ? "运行中" : activeBot.status === "paused" ? "已暂停" : "草稿"}
                        </span>
                      </div>
                      <span className="text-xs" style={{ color: "rgba(0,0,0,0.40)" }}>
                        创建于 {new Date(activeBot.createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
                      </span>
                      <span className="font-mono text-xs" style={{ color: "rgba(0,0,0,0.30)" }}>
                        {activeBot.id}
                      </span>
                    </div>
                  </div>
                  {/* 删除按钮 */}
                  <button
                    onClick={() => { setDeleteInput(""); setShowDeleteConfirm(true); }}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-all hover:bg-[rgba(220,38,38,0.08)]"
                    style={{ color: "#ccc", border: "none", background: "transparent", cursor: "pointer" }}
                    title="删除此 LightClaw"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* 分割线 */}
              <div style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }} />

              {/* ─ 使用设置：三列卡片 ─ */}
              <div>
                <h2 className="mb-6 text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(0,0,0,0.50)" }}>
                  使用设置
                </h2>
                <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                  {/* 卡片 1: 模型 */}
                  <div
                    className="rounded-2xl p-5"
                    style={{
                      border: "1px solid rgba(0,0,0,0.06)",
                      background: "#fff",
                      boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <ModelConfigSection />
                  </div>

                  {/* 卡片 2: 通道 */}
                  <div
                    className="rounded-2xl p-5"
                    style={{
                      border: "1px solid rgba(0,0,0,0.06)",
                      background: "#fff",
                      boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <ChannelSettingsCard bot={activeBot} onOpenChannelModal={() => setShowChannelModal(true)} />
                  </div>

                  {/* 卡片 3: 技能 */}
                  <div
                    className="rounded-2xl p-5"
                    style={{
                      border: "1px solid rgba(0,0,0,0.06)",
                      background: "#fff",
                      boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
                    }}
                  >
                    <SkillSettingsCard />
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
          )}

        </section>
      </main>

      <LegalFooter />
    </div>
  );
};

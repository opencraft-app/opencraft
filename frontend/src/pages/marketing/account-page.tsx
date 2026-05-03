import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  Check,
  ChevronRight,
  Copy,
  CreditCard,
  Loader2,
  Pencil,
  Shield,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useState, useRef, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { RepositoryError } from "@/repositories/http-repositories";
import { BrandMark } from "@/components/site/brand-mark";
import { LoginModal } from "@/components/site/login-modal";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { avatarImageUrl } from "@/lib/avatar-image";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

/* ─── Navbar ─── */

const AccountNavbar = () => {
  const { isAuthenticated: isLoggedIn } = useSession();
  const t = useT();

  return (
    <header className="lw-setup-navbar">
      <div className="mx-auto flex items-center justify-between px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>
        <BrandMark to="/" />
        <div className="flex items-center gap-3">
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

/* ─── Info Row ─── */

const InfoRow = ({
  label,
  children,
  borderBottom = true,
}: {
  label: string;
  children: React.ReactNode;
  borderBottom?: boolean;
}) => (
  <div
    className="flex items-center justify-between py-3.5"
    style={{ borderBottom: borderBottom ? `1px solid rgba(0,0,0,0.04)` : "none" }}
  >
    <span className="flex-shrink-0 text-sm" style={{ color: "#999" }}>{label}</span>
    <div className="text-right text-sm font-medium" style={{ color: "#333" }}>{children}</div>
  </div>
);

/* ─── Verify Identity Modal ─── */

const VerifyIdentityModal = ({
  onClose,
  onSuccess,
  verified,
}: {
  onClose: () => void;
  /** 调用方负责刷新 session 并关闭弹窗 */
  onSuccess: () => void;
  verified: boolean;
}) => {
  const { auth } = useRepositories();
  const { refreshProfile } = useSession();
  const t = useT();
  const [realName, setRealName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 身份证简单正则：17 位数字 + 末位数字或 X/x
  const ID_CARD_REGEX = /^\d{17}[\dXx]$/;
  const canSubmit =
    realName.trim().length >= 2 && ID_CARD_REGEX.test(idNumber.trim());

  const mapErrorMessage = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "invalid_realname":
          return "真实姓名格式不正确，请检查后重试。";
        case "invalid_id_card":
          return "身份证号格式不正确，请检查后重试。";
        case "realname_mismatch":
          return "姓名与身份证号不一致，请重新输入。";
        case "realname_verify_failed":
          return "实名核验失败，请稍后重试。";
        case "realname_unavailable":
          return "实名认证服务暂未开放，请稍后再试。";
        default:
          break;
      }
      if (err.status === 502 || err.status === 503) {
        return "认证服务繁忙或暂未开放，请稍后再试。";
      }
      return err.message || "实名认证失败，请稍后重试。";
    }
    return "网络异常，请稍后再试。";
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await auth.verifyRealname({
        name: realName.trim(),
        idCard: idNumber.trim().toUpperCase(),
      });
      // 成功后刷新 session，让 user.realnameVerified 立即变为 true
      try {
        await refreshProfile();
      } catch (refreshErr) {
        // 刷新失败不阻塞主流程：下次页面重进依然会拉到最新状态
        console.warn("Failed to refresh profile after realname verify", refreshErr);
      }
      onSuccess();
    } catch (err) {
      setError(mapErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="relative mx-4 w-full max-w-[622px] overflow-hidden bg-white"
        style={{
          borderRadius: 12,
          border: "1px solid #E6E9EF",
          boxShadow: "0px 24px 48px -12px rgba(0, 0, 0, 0.15)",
        }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {/* ── Header ── */}
        <div className="flex flex-col gap-4" style={{ padding: "32px 32px 24px" }}>
          <div className="flex items-center gap-4">
            <div className="flex flex-1 flex-col justify-center gap-2">
              <h3
                className="m-0"
                style={{
                  fontFamily: "PingFang SC",
                  fontWeight: 500,
                  fontSize: 20,
                  lineHeight: "1.6em",
                  color: "rgba(0,0,0,0.9)",
                }}
              >
                {verified ? t("修改实名认证") : t("实名认证")}
              </h3>
              <p
                className="m-0"
                style={{
                  fontFamily: "PingFang SC",
                  fontWeight: 400,
                  fontSize: 14,
                  lineHeight: "22px",
                  color: "rgba(0,0,0,0.9)",
                }}
              >
                {verified
                  ? t("重新提交真实姓名和身份证号，通过核验后将更新当前实名信息。")
                  : t("完成实名认证后可以发布技能和参与更多社区活动")}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[rgba(0,0,0,0.04)]"
              style={{ color: "rgba(0,0,0,0.5)" }}
              aria-label="关闭"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Warning banner —— 当前未认证提示 */}
          <div
            className="flex items-center gap-1"
            style={{
              background: verified ? "rgba(7, 193, 96, 0.1)" : "rgba(255, 161, 0, 0.1)",
              borderRadius: 8,
              padding: "4px 12px",
            }}
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center">
              {verified ? (
                <ShieldCheck className="h-[18px] w-[18px]" style={{ color: "var(--color-success)" }} />
              ) : (
                <Shield className="h-[18px] w-[18px]" style={{ color: "#FFA100" }} />
              )}
            </div>
            <span
              style={{
                fontFamily: "PingFang SC",
                fontWeight: 400,
                fontSize: 14,
                lineHeight: "22px",
                color: "rgba(0,0,0,0.9)",
              }}
            >
              {verified
                ? t("当前账号已完成实名。修改后会覆盖当前实名信息，后台保留变更记录。")
                : t("当前未认证，请完善信息并提交认证。")}
            </span>
          </div>
        </div>

        {/* divider */}
        <div style={{ height: 1, background: "#E9ECF1" }} />

        {/* ── Form ── */}
        <div className="flex flex-col" style={{ gap: 24, padding: "24px 32px" }}>
          {/* 证件类型（禁用态，目前仅支持身份证） */}
          <div className="flex flex-col" style={{ gap: 8 }}>
            <label
              style={{
                fontFamily: "PingFang SC",
                fontWeight: 500,
                fontSize: 14,
                lineHeight: "22px",
                color: "rgba(0,0,0,0.9)",
              }}
            >
              证件类型
            </label>
            <div
              className="flex items-center justify-between"
              style={{
                background: "#F2F4F8",
                border: "1px solid #E9ECF1",
                borderRadius: 8,
                padding: "6px 16px",
                cursor: "not-allowed",
              }}
            >
              <span
                style={{
                  fontFamily: "PingFang SC",
                  fontWeight: 400,
                  fontSize: 14,
                  lineHeight: "24px",
                  color: "rgba(0,0,0,0.3)",
                }}
              >
                身份证
              </span>
              <ChevronRight className="h-4 w-4" style={{ color: "rgba(0,0,0,0.3)", transform: "rotate(90deg)" }} />
            </div>
          </div>

          {/* 真实姓名 */}
          <div className="flex flex-col" style={{ gap: 8 }}>
            <label
              style={{
                fontFamily: "PingFang SC",
                fontWeight: 500,
                fontSize: 14,
                lineHeight: "22px",
                color: "rgba(0,0,0,0.9)",
              }}
            >
              真实姓名 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder="请输入真实姓名"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              maxLength={20}
              className="w-full focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.9)",
                border: "1px solid #E9ECF1",
                borderRadius: 8,
                padding: "6px 16px",
                fontFamily: "PingFang SC",
                fontWeight: 400,
                fontSize: 14,
                lineHeight: "24px",
                color: "rgba(0,0,0,0.9)",
              }}
            />
          </div>

          {/* 身份证号 */}
          <div className="flex flex-col" style={{ gap: 8 }}>
            <label
              style={{
                fontFamily: "PingFang SC",
                fontWeight: 500,
                fontSize: 14,
                lineHeight: "22px",
                color: "rgba(0,0,0,0.9)",
              }}
            >
              身份证号 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder="请输入身份证号码"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value.replace(/[^0-9Xx]/g, "").slice(0, 18))}
              maxLength={18}
              className="w-full focus:outline-none"
              style={{
                background: "rgba(255,255,255,0.9)",
                border: "1px solid #E9ECF1",
                borderRadius: 8,
                padding: "6px 16px",
                fontFamily: "PingFang SC",
                fontWeight: 400,
                fontSize: 14,
                lineHeight: "24px",
                color: "rgba(0,0,0,0.9)",
              }}
            />
          </div>

          {error && (
            <p className="m-0 text-[13px]" style={{ color: "#cf3d4c" }}>
              {error}
            </p>
          )}
        </div>

        {/* divider */}
        <div style={{ height: 1, background: "#E9ECF1" }} />

        {/* ── Action ── */}
        <div className="flex flex-col" style={{ gap: 8, padding: "24px 32px 32px" }}>
          <button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submitting}
            className="flex w-full items-center justify-center gap-2 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "#202020",
              color: "#FFFFFF",
              borderRadius: 28,
              padding: "15px 24px",
              fontFamily: "PingFang SC",
              fontWeight: 500,
              fontSize: 14,
              lineHeight: "24px",
            }}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {verified ? t("更新中...") : t("提交中...")}
              </>
            ) : (
              verified ? t("更新认证") : t("提交认证")
            )}
          </button>
          <p
            className="m-0 text-center"
            style={{
              fontFamily: "PingFang SC",
              fontWeight: 400,
              fontSize: 12,
              lineHeight: "24px",
              color: "rgba(0,0,0,0.3)",
            }}
          >
            你的姓名和身份证号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Delete Account Confirm Modal ─── */

const DeleteAccountModal = ({
  onCancel,
  onConfirm,
  submitting,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) => (
  <motion.div
    className="fixed inset-0 z-[100] flex items-center justify-center"
    style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
    onClick={onCancel}
  >
    <motion.div
      className="relative mx-4 w-full max-w-[420px] overflow-hidden rounded-2xl bg-white"
      style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
      initial={{ opacity: 0, scale: 0.96, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 10 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-7 pb-6 pt-7">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{ background: "rgba(207,61,76,0.08)" }}
          >
            <Trash2 className="h-[18px] w-[18px]" style={{ color: "#cf3d4c" }} />
          </div>
          <h3 className="m-0 text-[16px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
            注销账号
          </h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ margin: '12px 0 32px 0', color: "#666" }}>
          注销后，账号内的订阅、订单、Agent 数据将被永久清除且不可恢复。确定要注销账号吗？
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
            style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: "#cf3d4c" }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? "处理中..." : "确认注销"}
          </button>
        </div>
      </div>
    </motion.div>
  </motion.div>
);

/* ─── Subscription Section ─── */

const SubscriptionSection = ({
  subscription,
  pass,
}: {
  subscription: { code?: string; status?: string; currentPeriodStart?: string; currentPeriodEnd?: string } | null | undefined;
  pass: import("@/domain/types").Pass | null;
}) => {
  const { user } = useOpenClaw();
  const plan = user.plan;
  const t = useT();

  /**
   * 活跃权益的认定：
   * 1. 优先用 /v1/passes 返回的 activePass
   * 2. 回落到旧的 subscription
   */
  const hasActive = Boolean(pass) || Boolean(subscription);

  /**
   * 所有 Hook 必须在任何 early return 之前调用，以保证每次渲染 Hook 数量恒定。
   * 这里把有效期计算无条件执行，未订阅分支直接忽略其返回值即可。
   */
  const validityInfo = useMemo(() => {
    const now = new Date();
    if (pass) {
      const start = new Date(pass.created_time);
      const end = new Date(pass.expired_time);
      const remainDays = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      return {
        startDate: start.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
        endDate: end.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
        remainDays,
        expired: remainDays <= 0,
      };
    }
    if (subscription?.currentPeriodStart && subscription.currentPeriodEnd) {
      const start = new Date(subscription.currentPeriodStart);
      const end = new Date(subscription.currentPeriodEnd);
      const remainDays = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      return {
        startDate: start.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
        endDate: end.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
        remainDays,
        expired: remainDays <= 0,
      };
    }
    // 有订阅但无日期，基于试用天数模拟
    const end = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000);
    return {
      startDate: now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
      endDate: end.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
      remainDays: plan.trialDays,
      expired: false,
    };
  }, [pass, subscription, plan.trialDays]);

  // 积分：统一从 activePass 取（credit_total / credit_available），没有 pass 时为 0
  const creditsTotal = pass ? pass.credit_total : 0;
  const creditsUsed = pass ? Math.max(0, pass.credit_total - pass.credit_available) : 0;
  const usedPercent = creditsTotal > 0 ? Math.min(100, Math.round((creditsUsed / creditsTotal) * 100)) : 0;

  // 展示用的套餐名称
  const displayName = pass?.bundle_name ?? subscription?.code ?? plan.name;

  /* ── 未订阅：缺省引导状态 ── */
  if (!hasActive) {
    return (
      <motion.div
        variants={fadeIn}
        className="overflow-hidden bg-white"
        style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
      >
        <div className="px-5 py-5 md:px-8 md:py-8" style={{ borderBottom: "1px solid #E6E9EF" }}>
          <h3 className="text-[18px] md:text-[20px]" style={{ fontWeight: 500, color: "rgba(0,0,0,0.9)", lineHeight: 1.6 }}>
            订阅套餐
          </h3>
        </div>
        <div className="flex flex-col items-center gap-5 px-5 py-8 text-center md:px-8 md:py-10">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl">
            <CreditCard className="h-7 w-7" style={{ color: "rgba(0,0,0,0.9)" }} />
          </div>
          <div>
            <p className="text-base font-bold" style={{ color: "#333" }}>还没有订阅套餐</p>
            <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "#999" }}>
              即刻创建你的专属云端 Hermes
            </p>
          </div>
          <Link
            to="/subscribe"
            className="inline-flex items-center justify-center gap-2 bg-black/90 px-6 py-3 rounded-full font-semibold text-sm cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] transition-all"
            style={{ color: "#fff" }}
          >
            <Zap className="h-4 w-4" style={{ color: "#fff" }} />
            <span style={{ color: "#fff" }}>立即创建</span>
          </Link>
        </div>
      </motion.div>
    );
  }

  /* ── 已订阅：展示详情 ── */

  return (
    <motion.div
      variants={fadeIn}
      className="overflow-hidden bg-white"
      style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
    >
      <div className="px-5 py-5 md:px-8 md:py-8" style={{ borderBottom: "1px solid #E6E9EF" }}>
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-[18px] md:text-[20px]" style={{ fontWeight: 500, color: "rgba(0,0,0,0.9)", lineHeight: 1.6 }}>
            订阅套餐
          </h3>
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ background: "rgba(20,122,86,0.08)", color: "#147A56" }}
          >
            内测期免费体验
          </span>
        </div>
      </div>
      <div className="space-y-5 px-5 py-6 md:px-8 md:py-8">
        {/* Current plan */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: "rgba(0,0,0,0.03)" }}>
              <img src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png" alt="" className="h-7 w-7 rounded-lg object-cover" />
            </div> */}
            <div>
              <p className="text-sm font-bold" style={{ color: "#333" }}>{displayName}</p>
              <p className="text-xs" style={{ color: "#999" }}>当前生效</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold" style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)", borderRadius: "6px" }}>
            {t("当前套餐")}
          </span>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

        {/* Validity period */}
        <div>
          <div className="mb-2">
            <span className="text-sm font-semibold" style={{ color: "#333" }}>订阅有效期</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" style={{ color: "#666" }}>
              {validityInfo.startDate} — {validityInfo.endDate}
            </p>
            <span
              className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-bold"
              style={{
                background: validityInfo.expired ? "rgba(207,61,76,0.08)" : validityInfo.remainDays <= 2 ? "rgba(198,123,30,0.08)" : "rgba(20,122,86,0.08)",
                color: validityInfo.expired ? "#cf3d4c" : validityInfo.remainDays <= 2 ? "#C67B1E" : "#147A56",
                borderRadius: "6px",
              }}
            >
              {validityInfo.expired ? "已过期" : `剩余 ${validityInfo.remainDays} 天`}
            </span>
          </div>
        </div>

        {/* Credits progress（仅当有积分额度时展示） */}
        {creditsTotal > 0 && (
          <>
            {/* Divider */}
            <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />

            <div>
              <div className="mb-2">
                <span className="text-sm font-semibold" style={{ color: "#333" }}>已使用积分</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-bold" style={{ color: "var(--lw-accent)" }}>
                  {creditsUsed.toLocaleString()} <span className="font-normal" style={{ color: "#999" }}>/ {creditsTotal.toLocaleString()}</span>
                </p>
                <span className="text-xs font-semibold" style={{ color: usedPercent >= 80 ? "#cf3d4c" : "#666" }}>
                  {usedPercent}%
                </span>
              </div>
              {/* Progress bar */}
              <div className="relative h-2.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.05)" }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${usedPercent}%`,
                    background: usedPercent >= 80 ? "#cf3d4c" : usedPercent >= 50 ? "#C67B1E" : "var(--lw-accent)",
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
};

/* ─── Main Account Page ─── */

export const AccountPage = () => {
  const navigate = useNavigate();
  const {
    session,
    isAuthenticated,
    authReady,
    signInAsGuest,
    updateProfile,
    uploadAvatar,
    signOut,
    deleteAccount,
  } = useSession();
  const user = session.user;
  const subscription = session.currentSubscription;
  const { activePass } = useOpenClaw();
  const t = useT();

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadError, setAvatarUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Unauthenticated view state
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);

  // Verification —— 实名认证：直接以 session 里的 realnameVerified 为准
  const verified = Boolean(user?.realnameVerified);
  const showRealnameSection = !isGlobal;
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  // 账号 ID 一键复制：copiedUserId 控制「已复制」瞬态提示；ref 挂 setTimeout 以便重复点击时清理旧 timer
  const [copiedUserId, setCopiedUserId] = useState(false);
  const copyResetTimer = useRef<number | null>(null);
  const handleCopyUserId = async () => {
    if (!user?.id) return;
    try {
      await navigator.clipboard.writeText(user.id);
      setCopiedUserId(true);
      if (copyResetTimer.current) {
        window.clearTimeout(copyResetTimer.current);
      }
      copyResetTimer.current = window.setTimeout(() => setCopiedUserId(false), 1500);
    } catch {
      /* 浏览器不支持 clipboard API 或拒绝授权，用户可手选文本复制，此处静默 */
    }
  };

  // Delete account
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const avatarSrc = avatarImageUrl(user?.avatarUrl ?? null);
  // 暂时隐藏「登录账号」信息展示，待能区分多渠道登录方式后恢复
  // const loginMethod = (user?.phone ?? "").length > 0 ? "phone" : "wechat";

  const handleSaveName = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await updateProfile({ name: editName.trim() });
      setIsEditingName(false);
    } catch (e) {
      console.error("Failed to update name", e);
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploadError(null);
    setAvatarUploading(true);
    try {
      await uploadAvatar(file);
    } catch (err) {
      console.error("Failed to upload avatar", err);
      setAvatarUploadError(err instanceof Error ? err.message : "头像上传失败，请稍后重试。");
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  };

  // 实名认证成功后关闭弹窗；认证状态由 Modal 内部 refreshProfile 刷新 session 驱动
  const handleVerifySuccess = () => {
    setShowVerifyModal(false);
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate("/");
    } catch (err) {
      console.error("Failed to sign out", err);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await deleteAccount();
      setShowDeleteModal(false);
      navigate("/");
    } catch (err) {
      console.error("Failed to delete account", err);
    } finally {
      setDeleting(false);
    }
  };

  /* ── Unauthenticated view ── */
  if (authReady && !isAuthenticated) {
    return (
      <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
        <AccountNavbar />

        <main className="relative z-10 flex flex-grow items-center justify-center px-6 pb-16 pt-24 md:px-8">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="max-w-[360px] text-center"
          >
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border"
              style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.04)" }}
            >
              <img
                src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png"
                alt="LightVela"
                className="h-12 w-12 object-contain"
                style={{ pointerEvents: "none" }}
              />
            </div>
            <h2 className="m-0 text-xl font-bold tracking-[-0.3px]" style={{ color: "#333" }}>
              登录以查看账号信息
            </h2>
            <p className="mb-8 mt-2 text-sm leading-relaxed" style={{ color: "#999" }}>
              登录后可查看和管理你的个人信息、订阅套餐和订单记录。
            </p>

            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => setShowLoginModal(true)}
                className="lw-btn-primary w-full"
              >
                登录 / 注册
              </button>
              <button
                onClick={() => {
                  setGuestLoading(true);
                  setGuestError(null);
                  signInAsGuest()
                    .catch(() => setGuestError("游客登录失败，请稍后重试。"))
                    .finally(() => setGuestLoading(false));
                }}
                disabled={guestLoading}
                className="w-full rounded-lg border px-4 py-3 text-[15px] font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ borderColor: "rgba(0,0,0,0.1)", color: "#999" }}
              >
                {guestLoading ? "进入中..." : "游客体验"}
              </button>
            </div>

            {guestError && (
              <p className="mt-3 text-[13px]" style={{ color: "#cf3d4c" }}>{guestError}</p>
            )}

            <Link
              to="/"
              className="mt-6 inline-block text-[13px] transition-colors hover:text-[#666]"
              style={{ color: "#bbb" }}
            >
              ← 返回首页
            </Link>
          </motion.div>

          <LoginModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
        </main>

        <LegalFooter />
      </div>
    );
  }

  /* ── Loading auth ── */
  if (!authReady) {
    return (
      <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
        <AccountNavbar />
        <main className="relative z-10 flex flex-grow items-center justify-center">
          <p className="text-sm" style={{ color: "#bbb" }}>正在恢复会话...</p>
        </main>
        <LegalFooter />
      </div>
    );
  }

  /* ── Authenticated view ── */
  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <AccountNavbar />

      <main className="relative z-10 flex-grow pb-8 pt-20 md:pt-24">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-6 md:mb-8"
          >
            <h2 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", fontWeight: 600, color: "rgba(0,0,0,0.9)", lineHeight: 1.5 }}>{t("账号管理")}</h2>
          </motion.div>

          {/* Sections */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="space-y-6"
          >
            {/* ── Section 1: Profile ── */}
            <motion.div
              variants={fadeIn}
              className="overflow-hidden bg-white"
              style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
            >
              {/* Top row: avatar + nickname + actions */}
              <div
                className="flex flex-col gap-5 px-5 py-6 md:flex-row md:items-center md:justify-between md:gap-4 md:px-8 md:py-8"
                style={{ borderBottom: "1px solid #E6E9EF" }}
              >
                <div className="flex items-center gap-4 md:gap-[22px]">
                  {/* Avatar */}
                  <div className="relative flex-shrink-0">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => void handleAvatarUpload(e)}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={avatarUploading}
                      className="group relative block"
                      title={avatarUploadError ?? (avatarUploading ? "头像上传中..." : "点击更换头像")}
                    >
                      <img
                        src={avatarSrc}
                        alt="avatar"
                        className="h-14 w-14 object-cover"
                        style={{ border: "1px solid #E6E9EF", borderRadius: "9999px", background: "#F9F8F7" }}
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-100" style={{ borderRadius: "9999px" }}>
                        {avatarUploading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-white" />
                        ) : (
                          <Camera className="h-4 w-4 text-white" />
                        )}
                      </div>
                    </button>
                  </div>

                  {/* Nickname */}
                  <div className="min-w-0">
                    {isEditingName ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="lw-input w-full flex-1 md:w-auto"
                          maxLength={20}
                          autoFocus
                        />
                        <div className="flex w-full items-center gap-2 md:w-auto">
                          <button
                            onClick={() => void handleSaveName()}
                            disabled={saving || !editName.trim()}
                            className="lw-btn-primary !px-4 !py-2.5 !text-sm !rounded-lg disabled:opacity-60"
                          >
                            {saving ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() => { setIsEditingName(false); setEditName(user?.name ?? ""); }}
                            className="rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[rgba(0,0,0,0.03)]"
                            style={{ color: "#aaa" }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <p
                          className="truncate"
                          style={{ fontSize: 20, fontWeight: 500, color: "rgba(0,0,0,0.9)", lineHeight: 1.6 }}
                        >
                          {user?.name || "未设置"}
                        </p>
                        <button
                          onClick={() => { setEditName(user?.name ?? ""); setIsEditingName(true); }}
                          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                          style={{ color: "#aaa" }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    {avatarUploadError && (
                      <p className="mt-1 text-xs" style={{ color: "#cf3d4c" }}>{avatarUploadError}</p>
                    )}
                  </div>
                </div>

                {/* Right: logout / delete */}
                <div className="flex w-full items-center gap-2 md:w-auto md:gap-1">
                  <button
                    onClick={() => void handleSignOut()}
                    className="inline-flex flex-1 items-center justify-center rounded-full bg-white px-4 py-2 transition-colors hover:bg-[rgba(0,0,0,0.03)] md:flex-initial md:py-[4px]"
                    style={{
                      border: "1px solid #E6E9EF",
                      fontSize: 14,
                      lineHeight: "22px",
                      color: "rgba(0,0,0,0.9)",
                      boxShadow: "0px 2px 0px 0px rgba(187, 187, 187, 0.05)",
                    }}
                  >
                    退出
                  </button>
                  {/* <button
                    onClick={() => setShowDeleteModal(true)}
                    className="inline-flex flex-1 items-center justify-center rounded-full bg-white px-4 py-2 transition-colors hover:bg-[rgba(207,61,76,0.04)] md:flex-initial md:py-[4px]"
                    style={{
                      border: "1px solid #E6E9EF",
                      fontSize: 14,
                      lineHeight: "22px",
                      color: "rgba(0,0,0,0.9)",
                      boxShadow: "0px 2px 0px 0px rgba(187, 187, 187, 0.05)",
                    }}
                  >
                    注销
                  </button> */}
                </div>
              </div>

              {user?.id && (
                /* 账号 ID 行 —— 国内国际站都展示，独立于实名认证区 */
                <div className="flex flex-col gap-12 px-8 pt-8">
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>{t("账号 ID")}</span>
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="truncate text-sm"
                        style={{ color: "rgba(0,0,0,0.9)", fontFamily: "JetBrains Mono, monospace", maxWidth: 260 }}
                        title={user.id}
                      >
                        {user.id}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyUserId()}
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                        aria-label={t("复制")}
                        title={copiedUserId ? t("已复制") : t("复制")}
                        style={{ color: copiedUserId ? "var(--color-success)" : "var(--text-tertiary)" }}
                      >
                        {copiedUserId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {showRealnameSection && (
                /* Bottom: info rows —— 暂只放出「实名认证」行，「登录账号」行待能区分多渠道登录方式后再恢复 */
                <div className="flex flex-col gap-12 px-8 py-8">
                  {/*
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>
                    登录账号
                  </span>
                  <div className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-5 w-5 flex-shrink-0">
                      <circle cx="12" cy="12" r="12" fill="#07C160" />
                      <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
                      <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-.6 1.6-1.5 1.6-2.5z" fill="#fff" />
                    </svg>
                    <span className="text-sm" style={{ color: "rgba(0,0,0,0.9)" }}>微信登录</span>
                  </div>
                </div>
                */}

                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>实名认证</span>
                    {verified ? (
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-5 w-5 flex-shrink-0" style={{ color: "var(--color-success)" }} />
                          <span className="text-sm" style={{ color: "rgba(0,0,0,0.9)" }}>
                            {t("已认证")}
                          </span>
                        </div>
                        <button
                          onClick={() => setShowVerifyModal(true)}
                          className="flex items-center gap-1 text-sm transition-colors hover:opacity-80"
                          style={{ color: "var(--lw-accent)" }}
                        >
                          {t("修改")}
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowVerifyModal(true)}
                        className="flex items-center gap-1 text-sm transition-colors hover:opacity-80"
                        style={{ color: "var(--lw-accent)" }}
                      >
                        {t("去认证")}
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </motion.div>

            {/* ── Section 2: Subscription ── */}
            <SubscriptionSection subscription={subscription} pass={activePass} />
          </motion.div>
        </section>
      </main>

      <LegalFooter />

      {/* Modals */}
      <AnimatePresence>
        {showRealnameSection && showVerifyModal && (
          <VerifyIdentityModal
            key="verify"
            onClose={() => setShowVerifyModal(false)}
            onSuccess={handleVerifySuccess}
            verified={verified}
          />
        )}
        {showDeleteModal && (
          <DeleteAccountModal
            key="delete"
            onCancel={() => setShowDeleteModal(false)}
            onConfirm={() => void handleDeleteAccount()}
            submitting={deleting}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

// InfoRow 组件保留定义以便后续功能上线时恢复使用。
// 通过 void 引用避免 TS 未使用告警（code: 6133）。
void InfoRow;

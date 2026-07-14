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
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState, useRef, useMemo, type ReactNode } from "react";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { usePaidBillingEnabled, useRealnamePhoneVerificationEnabled } from "@/contexts/runtime-config-context";
import { RepositoryError } from "@/repositories/http-repositories";
import { REALNAME_LEVEL, type BundleTimeUnit, type Pass, type PassRenewPrice } from "@/domain/types";
import { LoginModal } from "@/components/site/login-modal";
import { ProductPageShell } from "@/components/site/product-chrome";
import { useT } from "@/i18n/t";
import { avatarImageUrl } from "@/lib/avatar-image";
import {
  canDeletePass,
  canRenewPass,
  centsToYuan,
  formatDuration,
  formatYuan,
  getPassStatus,
  isPaidBillingEnabled,
} from "@/lib/billing-flow";
import { getBillingErrorCode, resolveBillingErrorMessage } from "@/lib/billing-error";
import { AppLink, useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { isCN, isGlobal } from "@/lib/region";
import { REALNAME_REQUIRED_QUERY_KEY } from "@/lib/agent-routes";
import { cn } from "@/lib/utils";
import { buildPayPlan } from "@/lib/wx-pay";
import { QRCodeSVG } from "qrcode.react";

/* ─── animation variants ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
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

const FACE_ID_PENDING_POLL_DELAYS_MS = [250, 500, 1000, 1500, 2000, 3000, 5000, 8000, 10000];

type VerifyIdentityModalStage = "identity" | "face" | "phone" | "shadow";

const formatFaceIdExpiry = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const VerifyIdentityModal = ({
  onClose,
  onSuccess,
  verified,
  phoneVerificationEnabled,
  realnameLevel,
  realnameSyncStatus,
  faceIdFlowEnabled,
  phone,
}: {
  onClose: () => void;
  onSuccess: () => void;
  verified: boolean;
  phoneVerificationEnabled: boolean;
  realnameLevel?: string;
  realnameSyncStatus?: RealnameSyncStatus;
  faceIdFlowEnabled: boolean;
  phone?: string;
}) => {
  const t = useT();
  const { auth } = useRepositories();
  const { refreshProfile } = useSession();
  const normalizedPhone = phone?.trim() ?? "";
  const hasIdCardVerified = phoneVerificationEnabled
    && (verified || realnameLevel === "idcard_2fa" || realnameLevel === "phone_3fa");
  const initialStage: VerifyIdentityModalStage = faceIdFlowEnabled
    ? !verified && realnameLevel === REALNAME_LEVEL.PHONE_3FA
      ? "shadow"
      : !verified && realnameLevel === REALNAME_LEVEL.IDCARD_2FA
        ? "phone"
        : "identity"
    : hasIdCardVerified
      ? "phone"
      : "identity";
  const [stage, setStage] = useState<VerifyIdentityModalStage>(initialStage);
  const [realName, setRealName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{
    attemptId: string;
    state: "pending" | "face_succeeded" | "phone_pending" | "shadow_pending" | "succeeded" | "failed" | "expired";
    verificationUrl?: string;
    expiresAt?: string;
  } | null>(null);
  const [awaitingFinalRefresh, setAwaitingFinalRefresh] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );

  const ID_CARD_REGEX = /^\d{17}[\dXx]$/;
  const canSubmitIdentity = realName.trim().length >= 2 && ID_CARD_REGEX.test(idNumber.trim());
  const canSubmitLegacyIdentity = canSubmitIdentity;
  const canSubmitFaceIdIdentity = canSubmitIdentity && consent;
  const canSubmitPhone = normalizedPhone.length > 0 && smsCode.trim().length >= 4;
  const shadowFailed = !faceIdFlowEnabled && stage === "shadow" && !attempt && realnameSyncStatus === "failed";
  const shadowPending = stage === "shadow" && (
    awaitingFinalRefresh
    || attempt?.state === "shadow_pending"
    || attempt?.state === "succeeded"
    || (!attempt && realnameSyncStatus === "pending")
  );
  const faceNeedsRestart = stage === "face" && (attempt?.state === "expired" || attempt?.state === "failed");

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleResize = () => setIsMobileViewport(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (awaitingFinalRefresh && verified) {
      setAwaitingFinalRefresh(false);
      onSuccess();
    }
  }, [awaitingFinalRefresh, onSuccess, verified]);

  const mapErrorMessage = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "phone_required":
          return t("当前账号未绑定手机号，请先使用手机号登录或绑定手机号。");
        case "sms_code_not_found":
          return t("请先获取短信验证码。");
        case "sms_code_expired":
          return t("验证码已过期，请重新获取。");
        case "invalid_sms_code":
          return t("验证码不正确，请检查后重试。");
        case "invalid_realname":
          return t("真实姓名格式不正确，请检查后重试。");
        case "invalid_id_card":
          return t("身份证号格式不正确，请检查后重试。");
        case "realname_mismatch":
          return t("姓名与身份证号不一致，请重新输入。");
        case "realname_verify_failed":
          return t("实名核验失败，请稍后重试。");
        case "realname_unavailable":
          return t("实名认证服务暂未开放，请稍后再试。");
        case "shadow_binding_failed":
        case "shadow_binding_incomplete":
        case "shadow_basic_auth_failed":
          return t("LightVela 实名信息同步失败，请稍后重试。");
        default:
          break;
      }
      if (err.status === 502 || err.status === 503) {
        return t("认证服务繁忙或暂未开放，请稍后再试。");
      }
      return err.message || t("实名认证失败，请稍后重试。");
    }
    if (err instanceof Error && err.message.trim().length > 0) {
      return err.message;
    }
    return t("网络异常，请稍后再试。");
  };

  const applyAttemptState = useCallback(async (nextAttempt: NonNullable<typeof attempt>) => {
    setAttempt(nextAttempt);
    setPollError(null);

    switch (nextAttempt.state) {
      case "pending":
        setStage("face");
        return true;
      case "face_succeeded":
      case "phone_pending":
        setStage("phone");
        return false;
      case "shadow_pending":
        setStage("shadow");
        return false;
      case "succeeded":
        setStage("shadow");
        setAwaitingFinalRefresh(true);
        try {
          await refreshProfile();
        } catch {
          setAwaitingFinalRefresh(false);
          setPollError(t("最终认证状态同步较慢，请稍后刷新当前状态。"));
        }
        return false;
      case "failed":
        setStage("face");
        return false;
      case "expired":
        setStage("face");
        return false;
      default:
        return false;
    }
  }, [refreshProfile, t]);

  useEffect(() => {
    if (!faceIdFlowEnabled) return;
    let cancelled = false;
    void auth.getCurrentRealnameFaceIdAttempt()
      .then((currentAttempt) => {
        if (!cancelled) void applyAttemptState(currentAttempt);
      })
      .catch((err: unknown) => {
        const status = err instanceof RepositoryError
          ? err.status
          : typeof err === "object" && err !== null && "status" in err
            ? Number((err as { status?: unknown }).status)
            : 0;
        if (!cancelled && status !== 404) {
          setError(mapErrorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyAttemptState, auth, faceIdFlowEnabled]);

  useEffect(() => {
    if (!faceIdFlowEnabled || !attempt?.attemptId) return;
    if (attempt.state !== "pending") return;

    const delays = FACE_ID_PENDING_POLL_DELAYS_MS;
    let cancelled = false;
    let timerId: number | undefined;
    let index = 0;

    const poll = async () => {
      try {
        const nextAttempt = await auth.getRealnameFaceIdAttempt(attempt.attemptId);
        if (cancelled) return;
        const shouldContinue = await applyAttemptState(nextAttempt);
        if (!shouldContinue || cancelled) return;
        if (index >= delays.length) {
          setPollError(t("刷脸结果同步较慢，请稍后刷新当前状态。"));
          return;
        }
        timerId = window.setTimeout(poll, delays[index] ?? delays[delays.length - 1]);
        index += 1;
      } catch {
        if (!cancelled) {
          setPollError(t("刷脸结果同步较慢，请稍后刷新当前状态。"));
        }
      }
    };

    timerId = window.setTimeout(poll, delays[index] ?? delays[delays.length - 1]);
    index += 1;

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [applyAttemptState, attempt?.attemptId, attempt?.state, auth, faceIdFlowEnabled, t]);

  useEffect(() => {
    if (!faceIdFlowEnabled || !attempt?.attemptId) return;
    if (attempt.state !== "pending") return;

    const refreshPersistedState = () => {
      void auth.getRealnameFaceIdAttempt(attempt.attemptId)
        .then((nextAttempt) => applyAttemptState(nextAttempt))
        .catch((err: unknown) => setPollError(mapErrorMessage(err)));
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshPersistedState();
    };
    window.addEventListener("focus", refreshPersistedState);
    window.addEventListener("pageshow", refreshPersistedState);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshPersistedState);
      window.removeEventListener("pageshow", refreshPersistedState);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [applyAttemptState, attempt?.attemptId, attempt?.state, auth, faceIdFlowEnabled]);

  const sendPhoneCode = async () => {
    if (!normalizedPhone || sendingCode || cooldownSeconds > 0) return false;
    setSendingCode(true);
    setError(null);
    try {
      const result = faceIdFlowEnabled && attempt?.attemptId
        ? await auth.sendRealnameFaceIdPhoneCode(attempt.attemptId)
        : await auth.sendSmsCode({ phone: normalizedPhone });
      if (faceIdFlowEnabled && attempt?.attemptId && result.cooldownSeconds <= 0) {
        const nextAttempt = await auth.getRealnameFaceIdAttempt(attempt.attemptId);
        await applyAttemptState(nextAttempt);
        return false;
      }
      setCooldownSeconds(Math.max(1, result.cooldownSeconds || 60));
      return true;
    } catch (err) {
      setError(mapErrorMessage(err));
      return false;
    } finally {
      setSendingCode(false);
    }
  };

  const restartFaceIdFlow = () => {
    setStage("identity");
    setAttempt(null);
    setError(null);
    setPollError(null);
    setSmsCode("");
    setAwaitingFinalRefresh(false);
  };

  const refreshAttemptStatus = async () => {
    if (!attempt?.attemptId) return;
    setError(null);
    try {
      const nextAttempt = await auth.getRealnameFaceIdAttempt(attempt.attemptId);
      await applyAttemptState(nextAttempt);
    } catch (err) {
      setError(mapErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setPollError(null);
    try {
      if (stage === "identity") {
        if (!faceIdFlowEnabled) {
          const result = await auth.verifyRealname({
            name: realName.trim(),
            idCard: idNumber.trim().toUpperCase(),
          });
          try {
            await refreshProfile();
          } catch {
            // Swallow here to avoid logging sensitive auth flow details.
          }
          if (!result.phoneVerificationRequired) {
            onSuccess();
            return;
          }
          if (!normalizedPhone) {
            setError(t("当前账号未绑定手机号，请先使用手机号登录或绑定手机号。"));
            return;
          }
          setStage("phone");
          return;
        }

        const nextAttempt = await auth.startRealnameFaceIdAttempt({
          name: realName.trim(),
          idCard: idNumber.trim().toUpperCase(),
          consent: true,
        });
        await applyAttemptState(nextAttempt);
        return;
      }

      if (stage === "phone") {
        if (faceIdFlowEnabled && attempt?.attemptId) {
          const phoneAttempt = await auth.verifyRealnameFaceIdPhone(attempt.attemptId, { code: smsCode.trim() });
          await applyAttemptState(phoneAttempt);
        } else {
          await auth.verifyRealnamePhone({ code: smsCode.trim() });
          setStage("shadow");
          try {
            await refreshProfile();
          } catch {
            setPollError(t("最终认证状态同步较慢，请稍后刷新当前状态。"));
          }
        }
        return;
      }

      if (stage === "face") {
        await refreshAttemptStatus();
        return;
      }

      if (stage === "shadow") {
        if (shadowFailed) {
          await auth.retryRealnameSync();
          try {
            await refreshProfile();
          } catch {
            setPollError(t("最终认证状态同步较慢，请稍后刷新当前状态。"));
          }
          return;
        }

        await refreshAttemptStatus();
      }
    } catch (err) {
      setError(mapErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const primaryButtonLabel = (() => {
    if (stage === "identity") {
      if (faceIdFlowEnabled) return t("开始刷脸认证");
      return verified ? t("更新认证") : t("提交认证");
    }
    if (stage === "phone") return faceIdFlowEnabled ? t("完成当前手机号认证") : t("完成三要素认证");
    if (shadowFailed) return t("重新同步");
    return t("刷新当前状态");
  })();

  const canSubmit = stage === "identity"
    ? faceIdFlowEnabled
      ? canSubmitFaceIdIdentity
      : canSubmitLegacyIdentity
    : stage === "phone"
      ? canSubmitPhone
      : stage === "face"
        ? Boolean(attempt?.attemptId)
        : !faceIdFlowEnabled && (shadowFailed || Boolean(attempt?.attemptId));

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
                {faceIdFlowEnabled
                  ? verified
                    ? t("重新刷脸并完成当前手机号与 LightVela 同步后，新的实名信息才会生效。")
                    : t("请先完成刷脸核身，再继续当前手机号认证与 LightVela 同步。")
                  : verified
                    ? t("重新提交真实姓名和身份证号，通过核验后将更新当前实名信息。")
                    : t("完成实名认证后可以发布技能和参与更多社区活动")}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[rgba(0,0,0,0.04)]"
              style={{ color: "rgba(0,0,0,0.5)" }}
              aria-label={t("关闭")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

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
              {faceIdFlowEnabled
                ? verified
                  ? t("当前账号已完成实名。修改后会覆盖当前实名信息，后台保留变更记录。")
                  : stage === "identity"
                    ? t("第一步：提交真实姓名、身份证号，并发起刷脸核身。")
                    : stage === "face"
                      ? t("第二步：完成刷脸核身。")
                      : stage === "phone"
                        ? t("第三步：输入当前手机号收到的短信验证码。")
                        : t("第四步：等待 LightVela 实名同步完成。")
                : verified
                  ? t("当前账号已完成实名。修改后会覆盖当前实名信息，后台保留变更记录。")
                  : stage === "identity"
                    ? phoneVerificationEnabled
                      ? t("第一步：提交真实姓名和身份证号。")
                      : t("当前未认证，请完善信息并提交认证。")
                    : t("第二步：输入当前手机号收到的短信验证码。")}
            </span>
          </div>
        </div>

        <div style={{ height: 1, background: "#E9ECF1" }} />

        <div className="flex flex-col" style={{ gap: 24, padding: "24px 32px" }}>
          {stage === "identity" && (
            <>
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
                  {t("证件类型")}
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
                    {t("身份证")}
                  </span>
                  <ChevronRight className="h-4 w-4" style={{ color: "rgba(0,0,0,0.3)", transform: "rotate(90deg)" }} />
                </div>
              </div>

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
                  {t("真实姓名")} <span style={{ color: "#cf3d4c" }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder={t("请输入真实姓名")}
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
                  {t("身份证号")} <span style={{ color: "#cf3d4c" }}>*</span>
                </label>
                <input
                  type="text"
                  placeholder={t("请输入身份证号码")}
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

              {faceIdFlowEnabled && (
                <label className="flex items-start gap-3 text-sm" style={{ color: "rgba(0,0,0,0.72)", lineHeight: "22px" }}>
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-[#D1D5DB]"
                    aria-label={t("我已阅读并同意实名认证与刷脸核身说明")}
                  />
                  <span>{t("我已阅读并同意实名认证与刷脸核身说明，知道最终实名状态以后端确认结果为准。")}</span>
                </label>
              )}
            </>
          )}

          {stage === "face" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-[#E9ECF1] bg-[#F9F8F7] p-5">
                <p className="m-0 text-sm font-medium" style={{ color: "rgba(0,0,0,0.9)" }}>
                  {t("请使用微信或手机扫码完成人脸核身")}
                </p>
                <p className="mb-0 mt-2 text-sm" style={{ color: "rgba(0,0,0,0.58)", lineHeight: "22px" }}>
                  {attempt?.state === "failed"
                    ? t("本次刷脸未通过，请重新发起认证。")
                    : attempt?.state === "expired"
                      ? t("本次刷脸已过期，请重新发起认证。")
                      : t("等待刷脸结果")}
                </p>
              </div>

              {!faceNeedsRestart && attempt?.verificationUrl && (
                isMobileViewport ? (
                  <div className="rounded-xl border border-[#E9ECF1] p-5">
                    <p className="m-0 text-sm font-medium" style={{ color: "rgba(0,0,0,0.9)" }}>{t("当前设备为移动端")}</p>
                    <p className="mb-0 mt-2 text-sm" style={{ color: "rgba(0,0,0,0.58)", lineHeight: "22px" }}>
                      {t("请直接打开腾讯核身页面，完成刷脸后再返回这里等待状态同步。")}
                    </p>
                    <a
                      href={attempt.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-4 inline-flex items-center justify-center rounded-full bg-[#202020] px-5 py-3 text-sm font-medium text-white"
                    >
                      {t("打开刷脸页面")}
                    </a>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4 rounded-xl border border-[#E9ECF1] p-6">
                    <p className="m-0 text-sm font-medium" style={{ color: "rgba(0,0,0,0.9)" }}>{t("核身二维码")}</p>
                    <div className="rounded-xl border border-[#E9ECF1] bg-white p-4">
                      <QRCodeSVG value={attempt.verificationUrl} size={184} level="M" includeMargin={false} />
                    </div>
                    <p className="m-0 text-xs" style={{ color: "rgba(0,0,0,0.45)" }}>
                      {t("有效期至：{{time}}", { time: formatFaceIdExpiry(attempt.expiresAt) })}
                    </p>
                  </div>
                )
              )}
            </div>
          )}

          {stage === "phone" && (
            <>
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
                  {t("当前手机号")}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={normalizedPhone || t("未绑定手机号")}
                    disabled
                    className="w-full focus:outline-none"
                    style={{
                      background: "#F2F4F8",
                      border: "1px solid #E9ECF1",
                      borderRadius: 8,
                      padding: "6px 16px",
                      fontFamily: "PingFang SC",
                      fontWeight: 400,
                      fontSize: 14,
                      lineHeight: "24px",
                      color: normalizedPhone ? "rgba(0,0,0,0.9)" : "rgba(0,0,0,0.3)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void sendPhoneCode()}
                    disabled={!normalizedPhone || sendingCode || cooldownSeconds > 0}
                    className="flex-shrink-0 rounded-lg px-4 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ border: "1px solid #202020", color: "#202020" }}
                  >
                    {sendingCode
                      ? t("发送中...")
                      : cooldownSeconds > 0
                        ? t("重新发送 {{seconds}}s").replace("{{seconds}}", String(cooldownSeconds))
                        : t("获取验证码")}
                  </button>
                </div>
              </div>

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
                  {t("短信验证码")} <span style={{ color: "#cf3d4c" }}>*</span>
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder={t("请输入短信验证码")}
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  maxLength={8}
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
            </>
          )}

          {stage === "shadow" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl border border-[#E9ECF1] bg-[#F9F8F7] p-5">
                <p className="m-0 text-sm font-medium" style={{ color: "rgba(0,0,0,0.9)" }}>
                  {shadowFailed ? t("LightVela 实名同步失败") : t("正在确认最终实名结果")}
                </p>
                <p className="mb-0 mt-2 text-sm" style={{ color: "rgba(0,0,0,0.58)", lineHeight: "22px" }}>
                  {shadowFailed
                    ? t("你无需重新刷脸，可直接重试当前实名同步。")
                    : t("刷脸和当前手机号认证完成后，系统还会继续等待 LightVela 同步成功，再刷新最终实名状态。")}
                </p>
              </div>
              {attempt?.expiresAt && (
                <p className="m-0 text-xs" style={{ color: "rgba(0,0,0,0.45)" }}>
                  {t("本次尝试有效期：{{time}}", { time: formatFaceIdExpiry(attempt.expiresAt) })}
                </p>
              )}
              {shadowPending && !shadowFailed && (
                <p className="m-0 text-sm" style={{ color: "rgba(0,0,0,0.58)" }}>
                  {awaitingFinalRefresh ? t("正在刷新最终实名状态...") : t("实名信息同步中")}
                </p>
              )}
            </div>
          )}

          {(error || pollError) && (
            <p className="m-0 text-[13px]" style={{ color: "#cf3d4c" }}>
              {error || pollError}
            </p>
          )}
        </div>

        <div style={{ height: 1, background: "#E9ECF1" }} />

        <div className="flex flex-col" style={{ gap: 8, padding: "24px 32px 32px" }}>
          {faceNeedsRestart ? (
            <button
              onClick={restartFaceIdFlow}
              className="flex w-full items-center justify-center gap-2 transition-opacity"
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
              {t("重新开始认证")}
            </button>
          ) : faceIdFlowEnabled && stage === "shadow" ? null : (
            <button
              onClick={() => void handleSubmit()}
              disabled={!canSubmit || submitting || awaitingFinalRefresh}
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
                  {stage === "phone"
                    ? t("认证中...")
                    : stage === "shadow"
                      ? t("处理中...")
                      : verified
                        ? t("更新中...")
                        : t("提交中...")}
                </>
              ) : (
                primaryButtonLabel
              )}
            </button>
          )}
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
            {faceIdFlowEnabled
              ? t("你的姓名、身份证号和核身过程仅用于本次实名认证；最终成功以服务端持久状态和当前会话刷新结果为准。")
              : phoneVerificationEnabled
                ? t("你的姓名、身份证号和手机号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。")
                : t("你的姓名和身份证号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。")}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Change Phone Modal ─── */

const ChangePhoneModal = ({
  currentPhone,
  onClose,
  onSuccess,
}: {
  currentPhone: string;
  onClose: () => void;
  onSuccess: () => void;
}) => {
  const t = useT();
  const { auth } = useRepositories();
  const { refreshProfile } = useSession();
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedPhone = phone.replace(/[^\d]/g, "").slice(0, 11);
  const canSubmit = /^1\d{10}$/.test(normalizedPhone) && smsCode.trim().length >= 4 && !submitting;

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);

  const mapErrorMessage = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "invalid_phone":
          return t("手机号格式不正确，请检查后重试。");
        case "phone_in_use":
          return t("该手机号已绑定其他账号，请更换手机号。");
        case "sms_code_not_found":
          return t("请先获取短信验证码。");
        case "sms_code_expired":
          return t("验证码已过期，请重新获取。");
        case "invalid_sms_code":
          return t("验证码不正确，请检查后重试。");
        case "shadow_binding_failed":
        case "shadow_binding_incomplete":
          return t("安全手机同步失败，请稍后重试。");
        case "unauthorized":
          return t("登录已失效，请重新登录后再试。");
        default:
          break;
      }
      if (err.status === 502 || err.status === 503) {
        return t("账号服务繁忙，请稍后重试。");
      }
      return err.message || t("手机号修改失败，请稍后重试。");
    }
    return t("网络异常，请稍后再试。");
  };

  const sendPhoneCode = async () => {
    if (!/^1\d{10}$/.test(normalizedPhone) || sendingCode || cooldownSeconds > 0) return;
    setSendingCode(true);
    setError(null);
    try {
      const result = await auth.sendPhoneChangeCode({ phone: normalizedPhone });
      setCooldownSeconds(Math.max(1, result.cooldownSeconds || 60));
    } catch (err) {
      setError(mapErrorMessage(err));
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await auth.verifyPhoneChange({ phone: normalizedPhone, code: smsCode.trim() });
      try {
        await refreshProfile();
      } catch (refreshErr) {
        console.warn("Failed to refresh profile after phone change", refreshErr);
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
        className="relative mx-4 w-full max-w-[520px] overflow-hidden bg-white"
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
        <div className="flex flex-col gap-4" style={{ padding: "32px 32px 24px" }}>
          <div className="flex items-center gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <h3 className="m-0" style={{ fontFamily: "PingFang SC", fontWeight: 500, fontSize: 20, lineHeight: "1.6em", color: "rgba(0,0,0,0.9)" }}>
                {t("修改安全手机")}
              </h3>
              <p className="m-0" style={{ fontFamily: "PingFang SC", fontWeight: 400, fontSize: 14, lineHeight: "22px", color: "rgba(0,0,0,0.9)" }}>
                {t("安全手机用于后续计费、支付和账号安全校验。")}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[rgba(0,0,0,0.04)]"
              style={{ color: "rgba(0,0,0,0.5)" }}
              aria-label={t("关闭")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="rounded-lg bg-[rgba(7,193,96,0.08)] px-4 py-3 text-sm leading-[22px]" style={{ color: "rgba(0,0,0,0.75)" }}>
            {t("当前安全手机：{{phone}}", { phone: currentPhone })}
          </div>
        </div>

        <div style={{ height: 1, background: "#E9ECF1" }} />

        <div className="flex flex-col" style={{ gap: 24, padding: "24px 32px" }}>
          <div className="flex flex-col" style={{ gap: 8 }}>
            <label style={{ fontFamily: "PingFang SC", fontWeight: 500, fontSize: 14, lineHeight: "22px", color: "rgba(0,0,0,0.9)" }}>
              {t("新手机号")} <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="tel"
                inputMode="numeric"
                placeholder={t("请输入中国大陆手机号")}
                value={normalizedPhone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={11}
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
              <button
                type="button"
                onClick={() => void sendPhoneCode()}
                disabled={!/^1\d{10}$/.test(normalizedPhone) || sendingCode || cooldownSeconds > 0}
                className="flex-shrink-0 rounded-lg px-4 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ border: "1px solid #202020", color: "#202020" }}
              >
                {sendingCode
                  ? t("发送中...")
                  : cooldownSeconds > 0
                    ? t("重新发送 {{seconds}}s").replace("{{seconds}}", String(cooldownSeconds))
                    : t("获取验证码")}
              </button>
            </div>
          </div>

          <div className="flex flex-col" style={{ gap: 8 }}>
            <label style={{ fontFamily: "PingFang SC", fontWeight: 500, fontSize: 14, lineHeight: "22px", color: "rgba(0,0,0,0.9)" }}>
              {t("短信验证码")} <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              placeholder={t("请输入短信验证码")}
              value={smsCode}
              onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              maxLength={8}
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

        <div style={{ height: 1, background: "#E9ECF1" }} />

        <div className="flex flex-col" style={{ gap: 8, padding: "24px 32px 32px" }}>
          <button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
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
                {t("更新中...")}
              </>
            ) : (
              t("确认修改")
            )}
          </button>
          <p className="m-0 text-center" style={{ fontFamily: "PingFang SC", fontWeight: 400, fontSize: 12, lineHeight: "24px", color: "rgba(0,0,0,0.3)" }}>
            {t("验证码通过后会更新安全手机；同步失败时不会修改当前账号手机号。")}
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
}) => {
  const t = useT();
  return (
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
            {t("注销账号")}
          </h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ margin: '12px 0 32px 0', color: "#666" }}>
          {t("注销后，账号内的订阅、订单、Agent 数据将被永久清除且不可恢复。确定要注销账号吗？")}
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
            style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
          >
            {t("取消")}
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: "#cf3d4c" }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? t("处理中...") : t("确认注销")}
          </button>
        </div>
      </div>
    </motion.div>
  </motion.div>
  );
};

/* ─── Renew Pass Modal ─── */

/**
 * 续费弹窗 —— 联调文档 §3（v1.7.31 两阶段下单）
 *
 * 流程：
 *   1. 选周期（默认 1 个月）→ 自动调 getRenewPrice 询价（分→元）
 *   2. 用户确认 → 调 createRenewOrder 拿 deal_names → buildPayPlan 生成中转页二维码 URL
 *   3. paying 阶段渲染二维码，用户扫码后中转页走 OAuth → getRenewOrderUrl → wxSign
 *   4. 同时轮询 listMyPasses 检测同 pass_id 的 expired_time 被推后 → 续费成功
 *
 * 设计取舍：
 *   - 仅给定 1 / 3 / 6 / 12 个月 4 个预设档，避免任意输入引发风险
 *   - 询价失败不阻塞 UI，仍允许用户尝试下单（trade 侧最终兜底）
 *   - v1.7.31 起零元订单判定不在 PC 端进行，统一走二维码 bridge；
 *     中转页拿到 getRenewOrderUrl 响应后从 need_charge === 0 路径提示「已完成」
 */
const RenewPassModal = ({
  pass,
  onClose,
  onSuccess,
  t,
}: {
  pass: Pass;
  onClose: () => void;
  onSuccess: () => void;
  t: (zh: string, opts?: Record<string, unknown>) => string;
}) => {
  const { plans } = useRepositories();
  /* 默认选中 1 个月，与 RENEW_PRESETS[0] 保持一致；直接写字面量避免索引型推断雷区 */
  const [selected, setSelected] = useState<{ period: number; time_unit: BundleTimeUnit }>({
    period: 1,
    time_unit: "m",
  });
  const [priceInfo, setPriceInfo] = useState<PassRenewPrice | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);

  const [step, setStep] = useState<"confirm" | "paying">("confirm");
  /* 付费上下文：v1.7.31 起统一走 bridge 中转页，仅保留 deal_names + bridgeUrl */
  const [payContext, setPayContext] = useState<{
    dealNames: string[];
    bridgeUrl: string;
  } | null>(null);
  const payContextRef = useRef(payContext);
  payContextRef.current = payContext;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /* 询价：周期变化即重新询价 */
  useEffect(() => {
    if (step !== "confirm") return;
    let cancelled = false;
    setPricing(true);
    setPriceError(null);
    void (async () => {
      try {
        const result = await plans.getRenewPrice(pass.pass_id, selected);
        if (cancelled) return;
        setPriceInfo(result);
      } catch (err) {
        if (cancelled) return;
        setPriceInfo(null);
        setPriceError(resolveBillingErrorMessage(err, t("询价失败，可直接下单或稍后重试")));
      } finally {
        if (!cancelled) setPricing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pass.pass_id, plans, selected, step, t]);

  /* v1.7.30 后端联调文档明确「前端不需要轮询支付状态」——
     原轮询 listMyPasses + 补 expired_time 逻辑已删除，改为 SDK callback / 手动确认刷一次。 */

  /** SDK / 手动确认后走该函数：刷新外层页面状态、并判定续费是否生效 */
  const finalizeRenewSuccess = useCallback(async () => {
    /* 后端文档推荐刷列表拿新 expired_time，这里仅做一次刷新，不再轮询 */
    onSuccess();
  }, [onSuccess]);

  /** 用户点「我已完成支付」→ 直接转交给 finalizeRenewSuccess，跳出轮询中 */
  const handleManualConfirm = useCallback(() => {
    void finalizeRenewSuccess();
  }, [finalizeRenewSuccess]);

  /* v1.7.31 起统一二维码 bridge，原 handleReopenPayUrl + payContextRef 已删除（无 pay_url 可重新打开） */

  /* paying 阶段轮询：代替原 SDK callback。轮询 listMyPasses 检测同 pass_id 的 expired_time 被推后、
     由外层 onSuccess() 接棒 finalize。超时不主动报错，用户仍可点「我已完成支付」。 */
  useEffect(() => {
    if (step !== "paying") return;
    let cancelled = false;
    const startedAt = Date.now();
    const startExpired = pass.expired_time ? new Date(pass.expired_time).getTime() : 0;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const list = await plans.listMyPasses();
        const updated = list.find((p) => p.pass_id === pass.pass_id);
        if (updated && updated.expired_time && new Date(updated.expired_time).getTime() > startExpired) {
          window.clearInterval(timer);
          if (!cancelled) await finalizeRenewSuccess();
          return;
        }
      } catch (err) {
        console.warn("[account] poll renew status failed", err);
      }
      if (Date.now() - startedAt > 180_000) {
        window.clearInterval(timer);
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [step, pass.pass_id, pass.expired_time, plans, finalizeRenewSuccess]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      /* 阶段一：续费下单拿 deal_names + auth_code（CodeBuddy AuthCode 模型） */
      const order = await plans.createRenewOrder(pass.pass_id, selected);

      /* 把 deal_name + auth_code + passId + bundleName 编进二维码 URL；
         中转页根据 passId 非空走 renew/order-url 路径，再调 wxSign。
         PC 端不再调 getRenewOrderUrl —— 因为 jifei pay_url 生成时绑定 wx_open_id，
         必须等到中转页拿到 wx_code 后才能拉。零元订单由中转页直接显示「已完成」。 */
      const payPlan = buildPayPlan({
        dealName: order.deal_names[0] ?? "",
        authCode: order.auth_code,
        passId: pass.pass_id,
        bundleName: pass.bundle_name,
      });
      /* bridge：渲染中转页二维码，上方轮询 useEffect 检测 expired_time 推后即触发 onSuccess */
      setPayContext({ dealNames: order.deal_names, bridgeUrl: payPlan.bridgeUrl });
      setStep("paying");
    } catch (err) {
      const code = getBillingErrorCode(err);
      const fallbackMsg = err instanceof Error ? err.message : t("下单失败，请稍后重试。");
      console.error("[account] create renew order failed", err instanceof RepositoryError
        ? { status: err.status, code: err.code, message: err.message }
        : err);
      setSubmitError(`${code ? `[${code}] ` : ""}${resolveBillingErrorMessage(err, fallbackMsg)}`);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, plans, pass.pass_id, pass.bundle_name, selected, t]);

  /* 原「手动确认」/「重新打开 pay_url」逻辑已在 useEffect 上方声明 */

  const realTotalYuan = priceInfo ? centsToYuan(priceInfo.real_total_cost) : null;
  const originalTotalYuan = priceInfo ? centsToYuan(priceInfo.total_cost) : null;
  const hasDiscount = priceInfo != null && originalTotalYuan != null && realTotalYuan != null
    && originalTotalYuan > realTotalYuan + 0.001;

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="relative mx-4 w-full max-w-[460px] overflow-hidden rounded-2xl bg-white"
        style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: "rgba(0,0,0,0.5)" }}
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-7 pb-6 pt-7">
          <h3 className="m-0 text-[18px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
            {step === "confirm" ? t("续费套餐") : t("请完成支付")}
          </h3>
          <p className="text-sm" style={{ margin: "6px 0 20px 0", color: "#999" }}>
            {pass.bundle_name}
          </p>

          {step === "confirm" ? (
            <>
              {/* 周期选择 */}
              <div className="mb-5">
                <p className="mb-2 text-sm font-semibold" style={{ color: "#333" }}>{t("续费时长")}</p>
                <div className="flex flex-wrap gap-2">
                  {RENEW_PRESETS.map((preset) => {
                    const active = selected.period === preset.period && selected.time_unit === preset.time_unit;
                    return (
                      <button
                        key={`${preset.period}-${preset.time_unit}`}
                        type="button"
                        onClick={() => setSelected({ period: preset.period, time_unit: preset.time_unit })}
                        className="rounded-full border px-4 py-1.5 text-sm font-medium transition-colors"
                        style={{
                          borderColor: active ? "#202020" : "rgba(0,0,0,0.1)",
                          background: active ? "#202020" : "white",
                          color: active ? "white" : "#333",
                        }}
                      >
                        {t(preset.label)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 价格展示 */}
              <div
                className="mb-5 rounded-xl p-4"
                style={{ background: "#F9F8F7", border: "1px solid #E6E9EF" }}
              >
                <div className="mb-1 flex items-center justify-between text-xs" style={{ color: "#999" }}>
                  <span>{t("续费时长")}</span>
                  <span>{formatDuration(selected.period, selected.time_unit)}</span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-sm font-semibold" style={{ color: "#333" }}>{t("应付金额")}</span>
                  <div className="text-right">
                    {pricing ? (
                      <span className="inline-flex items-center gap-1 text-sm" style={{ color: "#999" }}>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("询价中...")}
                      </span>
                    ) : realTotalYuan != null ? (
                      <>
                        <p className="m-0 text-xl font-bold tracking-tight" style={{ color: "var(--lw-accent)" }}>
                          {formatYuan(realTotalYuan, priceInfo?.currency ?? "CNY")}
                        </p>
                        {hasDiscount && originalTotalYuan != null && (
                          <p className="m-0 text-xs line-through" style={{ color: "#bbb" }}>
                            {formatYuan(originalTotalYuan, priceInfo?.currency ?? "CNY")}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-sm" style={{ color: "#999" }}>{t("暂无报价")}</span>
                    )}
                  </div>
                </div>
                {priceError && (
                  <p className="m-0 mt-2 text-xs" style={{ color: "#C67B1E" }}>{priceError}</p>
                )}
              </div>

              {submitError && (
                <p className="mb-3 text-sm" style={{ color: "#cf3d4c" }}>{submitError}</p>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                  style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || pricing || realTotalYuan == null}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: "#202020" }}
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? t("正在生成订单...") : t("前往支付")}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* paying 面板：v1.7.31 起统一渲染中转页二维码 */}
              <div
                className="mb-5 flex flex-col items-center gap-3 rounded-xl p-4"
                style={{ background: "#F9F8F7" }}
              >
                <p className="m-0 text-sm" style={{ color: "#333" }}>
                  {t("请使用微信扫描下方二维码完成支付")}
                </p>
                {payContext?.bridgeUrl ? (
                  <QRCodeSVG value={payContext.bridgeUrl} size={180} level="M" includeMargin={false} />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--lw-accent)" }} />
                )}
              </div>

              {submitError && (
                <p className="mb-3 text-sm" style={{ color: "#cf3d4c" }}>{submitError}</p>
              )}

              <div className="flex flex-row gap-3">
                {/* 左「刷新」：重新下单生成新二维码。复用 handleSubmit 走与首次下单一致逻辑。 */}
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting}
                  className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ borderColor: "var(--lw-accent)", color: "var(--lw-accent)", background: "#fff" }}
                >
                  {submitting ? t("刷新中...") : t("刷新")}
                </button>
                {/* 右「完成」：语义同原「我已完成支付」，主动接棒 finalize，成功后关闭 */}
                <button
                  type="button"
                  onClick={handleManualConfirm}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors"
                  style={{ background: "#202020" }}
                >
                  {t("完成")}
                </button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Pass Delete Modal ─── */

/**
 * Pass 销毁弹窗 —— 联调文档 §4.1
 *
 * 流程：
 *   1. 二次确认 → 调 deletePass 同步返回 deleted=true
 *   2. 启动轮询：每 3s 拉 listMyPasses，直到目标 pass 从列表消失或被打上 deleted_time
 *   3. 2 分钟超时 → 提示用户稍后刷新
 *
 * 注意：与账号注销 DeleteAccountModal 区分 —— 这里仅销毁单个 pass，账号本体不受影响
 */
const PassDeleteModal = ({
  pass,
  onClose,
  onSuccess,
  t,
}: {
  pass: Pass;
  onClose: () => void;
  onSuccess: () => void;
  t: (zh: string, opts?: Record<string, unknown>) => string;
}) => {
  const { plans } = useRepositories();
  const [step, setStep] = useState<"confirm" | "polling">("confirm");
  const [submitting, setSubmitting] = useState(false);
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  /* 销毁后的轮询：等 pass 从列表消失 */
  useEffect(() => {
    if (step !== "polling" || pollStartedAt == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - pollStartedAt > DELETE_POLL_TIMEOUT_MS) {
        setErrMsg(t("销毁请求已提交，但状态确认超时。请稍后刷新页面查看结果。"));
        setStep("confirm");
        return;
      }
      try {
        const list = await plans.listMyPasses();
        if (cancelled) return;
        const stillThere = list.find((p) => p.pass_id === pass.pass_id);
        const finalized = !stillThere || Boolean(stillThere.deleted_time);
        if (finalized) {
          onSuccess();
          return;
        }
      } catch (err) {
        console.warn("[account] poll delete pass status failed", err);
      }
      if (!cancelled) {
        timer = setTimeout(tick, DELETE_POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, DELETE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, pollStartedAt, pass.pass_id, plans, onSuccess, t]);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const result = await plans.deletePass(pass.pass_id);
      if (!result.deleted) {
        setErrMsg(t("销毁请求未确认，请稍后重试。"));
        return;
      }
      setPollStartedAt(Date.now());
      setStep("polling");
    } catch (err) {
      const fallbackMsg = err instanceof Error ? err.message : t("销毁失败，请稍后重试。");
      console.error("[account] delete pass failed", err instanceof RepositoryError
        ? { status: err.status, code: err.code, message: err.message }
        : err);
      setErrMsg(resolveBillingErrorMessage(err, fallbackMsg));
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
      onClick={step === "confirm" ? onClose : undefined}
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
              {t("销毁套餐")}
            </h3>
          </div>
          <p className="text-sm leading-relaxed" style={{ margin: "12px 0 8px 0", color: "#666" }}>
            {t("销毁套餐 {{name}} 后，该套餐对应的 Agent 资源、积分与订单关联将被清除，且无法恢复。", { name: pass.bundle_name })}
          </p>
          <p className="text-xs" style={{ margin: "0 0 24px 0", color: "#999" }}>
            {t("销毁完成后，您可以重新购买新的套餐。")}
          </p>

          {errMsg && (
            <p className="mb-3 text-sm" style={{ color: "#cf3d4c" }}>{errMsg}</p>
          )}

          {step === "polling" ? (
            <div
              className="flex items-center gap-3 rounded-xl p-3"
              style={{ background: "#F9F8F7" }}
            >
              <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" style={{ color: "var(--lw-accent)" }} />
              <p className="m-0 text-sm" style={{ color: "#333" }}>
                {t("正在销毁套餐，请稍候...")}
              </p>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:opacity-50"
                style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
              >
                {t("取消")}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={submitting}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-50"
                style={{ background: "#cf3d4c" }}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? t("处理中...") : t("确认销毁")}
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Subscription Section ─── */

/**
 * 询价选项——联调文档 §3 说明起始仅提供「月15/30/180/365」几个限定组合。
 * 主动按「1 / 3 / 6 / 12 个月」展示，发请求时仅发 period+time_unit。
 */
const RENEW_PRESETS: ReadonlyArray<{ period: number; time_unit: BundleTimeUnit; label: string }> = [
  { period: 1, time_unit: "m", label: "1个月" },
  { period: 3, time_unit: "m", label: "3个月" },
  { period: 6, time_unit: "m", label: "6个月" },
  { period: 12, time_unit: "m", label: "1年" },
];

/** 中转页轮询的超时 / 间隔在 useEffect 中内联使用，不再需要独立常量。原 MIDAS_PAY_RENEW_TARGET_ID 已与 wxSign 拆离，不再需要。 */

/** 销毁轮询：联调文档 §4.1 说明销毁是异步，需等 pass 从列表消失 */
const DELETE_POLL_INTERVAL_MS = 3_000;
const DELETE_POLL_TIMEOUT_MS = 2 * 60 * 1_000;

const SubscriptionSection = ({
  subscription,
  pass,
  showAccountRenewTools,
}: {
  subscription: { code?: string; status?: string; currentPeriodStart?: string; currentPeriodEnd?: string } | null | undefined;
  pass: Pass | null;
  showAccountRenewTools: boolean;
}) => {
  const t = useT();
  const { refreshPasses, user } = useOpenClaw();
  const { plans } = useRepositories();
  const paidBillingEnabled = usePaidBillingEnabled();
  const paidBillingActive = isPaidBillingEnabled(paidBillingEnabled);
  const plan = user.plan;

  /**
   * 只读 fallback pass — 国内站场景：activePass 为 null 但用户仍有 expired/isolated pass 需要续费或销毁。
   * 仅在国内站且未多貌 activePass 时拉一次，避免与 openclaw-context.refreshPasses 重复干活。
   */
  const [fallbackPass, setFallbackPass] = useState<Pass | null>(null);

  /** 续费 / 销毁弹窗状态 */
  const [renewModalOpen, setRenewModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  useEffect(() => {
    if (!paidBillingActive) return;
    if (pass) {
      setFallbackPass(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await plans.listMyPasses();
        if (cancelled) return;
        /* 取首个未销毁的 pass；isolated/expired 都会在这里被包含。
           互斥占用规则保证不会同时出现多个未销毁 pass。 */
        const first = list.find((p) => !p.deleted_time) ?? null;
        setFallbackPass(first);
      } catch (err) {
        console.warn("[account] fetch fallback pass failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paidBillingActive, pass, plans]);

  /** 可操作的 pass：优先 active，其次 fallback */
  const operablePass = pass ?? fallbackPass;
  const passStatus = operablePass ? getPassStatus(operablePass) : null;
  const canRenew = paidBillingActive && operablePass != null && canRenewPass(operablePass);
  const canDelete = paidBillingActive && operablePass != null && canDeletePass(operablePass);

  const handleRenewSuccess = useCallback(async () => {
    setRenewModalOpen(false);
    await refreshPasses();
    setFallbackPass(null);
  }, [refreshPasses]);

  const handleDeleteSuccess = useCallback(async () => {
    setDeleteModalOpen(false);
    await refreshPasses();
    setFallbackPass(null);
  }, [refreshPasses]);

  /**
   * 活跃权益的认定：
   * 1. 有 activePass 〔主路径〕
   * 2. 有 fallbackPass 〔过期 / 隔离期，仍需展示以供续费 / 销毁〕
   * 3. 后退到旧的 subscription
   */
  const hasActive = Boolean(pass) || Boolean(fallbackPass) || Boolean(subscription);

  /**
   * 所有 Hook 必须在任何 early return 之前调用，以保证每次渲染 Hook 数量恒定。
   * 这里把有效期计算无条件执行，未订阅分支直接忽略其返回值即可。
   */
  const validityInfo = useMemo(() => {
    const now = new Date();
    /* 优先从 operablePass（activePass / fallbackPass）取有效期，其次才是 subscription / 试用默认 */
    const sourcePass = operablePass;
    if (sourcePass) {
      const start = new Date(sourcePass.created_time);
      const end = new Date(sourcePass.expired_time);
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
  }, [operablePass, subscription, plan.trialDays]);

  // 积分：统一从 operablePass 取（credit_total / credit_available），没有 pass 时为 0
  const creditsTotal = operablePass ? operablePass.credit_total : 0;
  const creditsUsed = operablePass ? Math.max(0, operablePass.credit_total - operablePass.credit_available) : 0;
  const usedPercent = creditsTotal > 0 ? Math.min(100, Math.round((creditsUsed / creditsTotal) * 100)) : 0;

  // 展示用的套餐名称
  const displayName = operablePass?.bundle_name ?? subscription?.code ?? plan.name;

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
            {t("订阅套餐")}
          </h3>
        </div>
        <div className="flex flex-col items-center gap-5 px-5 py-8 text-center md:px-8 md:py-10">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl">
            <CreditCard className="h-7 w-7" style={{ color: "rgba(0,0,0,0.9)" }} />
          </div>
          <div>
            <p className="text-base font-bold" style={{ color: "#333" }}>{t("还没有订阅套餐")}</p>
            <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "#999" }}>
              {t("即刻创建你的专属云端 Hermes")}
            </p>
          </div>
          <AppLink
            to="/subscribe"
            className="inline-flex items-center justify-center gap-2 bg-black/90 px-6 py-3 rounded-full font-semibold text-sm cursor-pointer shadow-[0_2px_0_rgba(187,187,187,0.05)] hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] transition-all"
            style={{ color: "#fff" }}
          >
            <Zap className="h-4 w-4" style={{ color: "#fff" }} />
            <span style={{ color: "#fff" }}>{t("立即创建")}</span>
          </AppLink>
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
            {t("订阅套餐")}
          </h3>
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ background: "rgba(20,122,86,0.08)", color: "#147A56" }}
          >
            {t("内测期免费体验")}
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
              <p className="text-xs" style={{ color: "#999" }}>{t("当前生效")}</p>
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
            <span className="text-sm font-semibold" style={{ color: "#333" }}>{t("订阅有效期")}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" style={{ color: "#666" }}>
              {validityInfo.startDate} — {validityInfo.endDate}
            </p>
            <span
              className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-bold"
              style={{
                background:
                  passStatus === "isolated"
                    ? "rgba(198,123,30,0.12)"
                    : passStatus === "expired" || validityInfo.expired
                      ? "rgba(207,61,76,0.08)"
                      : validityInfo.remainDays <= 2
                        ? "rgba(198,123,30,0.08)"
                        : "rgba(20,122,86,0.08)",
                color:
                  passStatus === "isolated"
                    ? "#C67B1E"
                    : passStatus === "expired" || validityInfo.expired
                      ? "#cf3d4c"
                      : validityInfo.remainDays <= 2
                        ? "#C67B1E"
                        : "#147A56",
                borderRadius: "6px",
              }}
            >
              {validityInfo.expired ? t("已过期") : t("剩余 {{days}} 天", { days: validityInfo.remainDays })}
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
                <span className="text-sm font-semibold" style={{ color: "#333" }}>{t("已使用积分")}</span>
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

        {/* 续费 / 销毁按钮区：仅国内站 + 可操作 pass 时展示 */}
        {((showAccountRenewTools && canRenew) || canDelete) && operablePass && (
          <>
            <div style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />
            <div className="flex flex-wrap items-center gap-3">
              {showAccountRenewTools && canRenew && (
                <button
                  type="button"
                  onClick={() => setRenewModalOpen(true)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition-all hover:-translate-y-[1px] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
                  style={{ background: "#202020" }}
                >
                  <Zap className="h-4 w-4" />
                  {passStatus === "active" ? t("立即续费") : t("恢复使用")}
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => setDeleteModalOpen(true)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full border bg-white px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(207,61,76,0.04)]"
                  style={{ borderColor: "rgba(207,61,76,0.3)", color: "#cf3d4c" }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("销毁套餐")}
                </button>
              )}
              {passStatus === "isolated" && (
                <p className="basis-full text-xs" style={{ color: "#C67B1E" }}>
                  {t("套餐已进入隔离期，可选择续费恢复使用或销毁当前套餐。销毁后可重新购买。")}
                </p>
              )}
              {passStatus === "expired" && (
                <p className="basis-full text-xs" style={{ color: "#cf3d4c" }}>
                  {t("套餐已过期，请及时续费以免进入隔离期。")}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* 续费 / 销毁弹窗 — 仅国内站有机会被触发（operablePass != null 且 isPaidBillingEnabled） */}
      <AnimatePresence>
        {renewModalOpen && operablePass && (
          <RenewPassModal
            key="renew"
            pass={operablePass}
            onClose={() => setRenewModalOpen(false)}
            onSuccess={() => void handleRenewSuccess()}
            t={t}
          />
        )}
        {deleteModalOpen && operablePass && (
          <PassDeleteModal
            key="delete-pass"
            pass={operablePass}
            onClose={() => setDeleteModalOpen(false)}
            onSuccess={() => void handleDeleteSuccess()}
            t={t}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
};

/* ─── Main Account Page ─── */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type RealnameSyncStatus = "pending" | "failed" | "succeeded";
type AccountConsoleHost = Window & { console: Console; show?: unknown };

export const AccountPage = () => {
  const t = useT();
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useAppSearchParams();
  const { auth } = useRepositories();
  const {
    session,
    isAuthenticated,
    authReady,
    signInAsGuest,
    updateProfile,
    uploadAvatar,
    refreshProfile,
    signOut,
    deleteAccount,
  } = useSession();
  const user = session.user;
  const subscription = session.currentSubscription;
  const { activePass } = useOpenClaw();

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [nameSaveError, setNameSaveError] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadError, setAvatarUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Unauthenticated view state
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  const [showFaceIdFlow, setShowFaceIdFlow] = useState(false);
  const faceIdBackendEnabled = user?.realnameAssuranceMode === "observe"
    || user?.realnameAssuranceMode === "face_required";
  const hasSafetyPhone = Boolean(user?.phone?.trim());
  const faceIdFlowEnabled = showFaceIdFlow && faceIdBackendEnabled;
  const phoneProofEnabled = hasSafetyPhone && (realnamePhoneVerificationEnabled || faceIdFlowEnabled);

  const verified = faceIdFlowEnabled
    ? user?.realnameVerified === true && user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA
    : realnamePhoneVerificationEnabled
      ? user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA
      : Boolean(user?.realnameVerified);
  const idCardVerified = faceIdFlowEnabled
    ? !verified && (user?.realnameLevel === REALNAME_LEVEL.IDCARD_2FA || user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA)
    : realnamePhoneVerificationEnabled
      && (user?.realnameLevel === REALNAME_LEVEL.IDCARD_2FA || user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA);
  const shadowProofReady = faceIdFlowEnabled
    && idCardVerified
    && user?.realnameLevel === REALNAME_LEVEL.PHONE_3FA;
  const realnameSyncStatus = user?.realnameSyncStatus as RealnameSyncStatus | undefined;
  const idCardSyncStatus = faceIdFlowEnabled
    ? shadowProofReady ? realnameSyncStatus : undefined
    : idCardVerified && !verified ? realnameSyncStatus : undefined;
  const realnameSyncNeedsRetry = !faceIdFlowEnabled
    && realnamePhoneVerificationEnabled
    && hasSafetyPhone
    && idCardVerified
    && !verified
    && (idCardSyncStatus === "failed" || idCardSyncStatus === "pending");
  const realnameStatusLabel = verified
    ? t("已认证")
    : idCardSyncStatus === "failed"
      ? t("实名信息同步失败")
      : idCardSyncStatus === "pending"
        ? t("实名信息同步中")
        : idCardVerified
          ? t("待完成手机号认证")
          : "";
  const [showSafetyPhoneTools, setShowSafetyPhoneTools] = useState(false);
  const [showAccountRenewTools, setShowAccountRenewTools] = useState(false);
  const showRealnameSection = !isGlobal;
  const showSafetyPhoneSection = phoneProofEnabled && !isGlobal && showSafetyPhoneTools;
  const showEmailBindSection = isCN;
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showChangePhoneModal, setShowChangePhoneModal] = useState(false);
  const [realnameSyncRetrying, setRealnameSyncRetrying] = useState(false);
  const [realnameSyncError, setRealnameSyncError] = useState<string | null>(null);
  // 从首页「立即创建」跳转过来、要求先完成实名认证时的提醒 tips
  const [realnameRequiredTip, setRealnameRequiredTip] = useState<string | null>(null);

  // Email bind —— 国内站微信/QQ 登录用户通过 Magic Link 绑定邮箱
  const [bindEmail, setBindEmail] = useState(user?.email ?? "");
  const [emailBindSubmitting, setEmailBindSubmitting] = useState(false);
  const [emailBindError, setEmailBindError] = useState<string | null>(null);
  const [emailBindSuccess, setEmailBindSuccess] = useState<string | null>(null);
  const [emailBindCooldown, setEmailBindCooldown] = useState(0);
  const [copiedUserId, setCopiedUserId] = useState(false);
  const copyResetTimer = useRef<number | null>(null);

  useEffect(() => {
    if (isGlobal || typeof window === "undefined") return undefined;

    const host = window as AccountConsoleHost;
    const originalShow = host.show;
    const consoleRef = host.console;

    host.show = () => {
      setShowSafetyPhoneTools(true);
      setShowAccountRenewTools(true);
      setShowFaceIdFlow(true);
      consoleRef.info("账号隐藏入口已显示。");
      return true;
    };

    return () => {
      if (originalShow === undefined) {
        delete host.show;
      } else {
        host.show = originalShow;
      }
    };
  }, []);

  // Delete account
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const avatarSrc = avatarImageUrl(user?.avatarUrl ?? null);
  const pendingAvatarSrc = avatarImageUrl(user?.pendingAvatarUrl ?? null);
  const hasPendingAvatarAudit = user?.avatarAuditStatus === "pending" && Boolean(user.pendingAvatarUrl);
  const avatarAuditFailed = user?.avatarAuditStatus === "failed";
  const displayAvatarSrc = hasPendingAvatarAudit ? pendingAvatarSrc : avatarSrc;
  const pendingName = user?.nameAuditStatus === "pending" ? user.pendingName?.trim() ?? "" : "";
  const hasPendingNameAudit = pendingName.length > 0;
  const nameAuditFailed = user?.nameAuditStatus === "failed";

  useEffect(() => {
    if (emailBindCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setEmailBindCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailBindCooldown]);

  useEffect(() => {
    const bound = searchParams.get("email_bound");
    const bindError = searchParams.get("email_bind_error");
    if (!bound && !bindError) return;

    const next = new URLSearchParams(searchParams);
    next.delete("email_bound");
    next.delete("email_bind_error");
    setSearchParams(next, { replace: true });

    if (bound === "1") {
      setEmailBindSuccess(t("邮箱绑定成功。"));
      setEmailBindError(null);
      void refreshProfile().catch((err) => {
        console.warn("Failed to refresh profile after email bind", err);
      });
      return;
    }

    const message = (() => {
      switch (bindError) {
        case "expired":
          return t("绑定链接已过期，请重新发送验证邮件。");
        case "in_use":
          return t("该邮箱已被其他账号使用。");
        case "invalid":
          return t("绑定链接无效，请重新发送验证邮件。");
        case "unavailable":
          return t("邮箱绑定服务暂未开放，请稍后再试。");
        default:
          return t("邮箱绑定失败，请稍后重试。");
      }
    })();
    setEmailBindError(message);
    setEmailBindSuccess(null);
  }, [refreshProfile, searchParams, setSearchParams, t]);

  // 首页「立即创建」→ 未实名跳转到账号页时，展示实名提醒并清理 query
  useEffect(() => {
    // 国际站无实名概念，即便被手动拼接该 query 也不展示中文提醒
    if (isGlobal) return;
    if (searchParams.get(REALNAME_REQUIRED_QUERY_KEY) !== "1") return;

    const next = new URLSearchParams(searchParams);
    next.delete(REALNAME_REQUIRED_QUERY_KEY);
    setSearchParams(next, { replace: true });

    setRealnameRequiredTip(t("创建 LightVela 前，请先完成实名认证。"));
  }, [searchParams, setSearchParams, t, isGlobal]);

  // 实名认证完成后自动清除提醒
  useEffect(() => {
    if (verified) setRealnameRequiredTip(null);
  }, [verified]);

  useEffect(() => {
    if (!hasPendingAvatarAudit && !hasPendingNameAudit) return;

    const refreshTimer = window.setInterval(() => {
      void refreshProfile().catch((err) => {
        console.warn("Failed to refresh pending profile audit status", err);
      });
    }, 3000);
    return () => window.clearInterval(refreshTimer);
  }, [hasPendingAvatarAudit, hasPendingNameAudit, refreshProfile]);

  // 暂时隐藏「登录账号」信息展示，待能区分多渠道登录方式后恢复
  // const loginMethod = (user?.phone ?? "").length > 0 ? "phone" : "wechat";

  const beginNameEdit = () => {
    setNameSaveError(null);
    setEditName(pendingName || user?.name || "");
    setIsEditingName(true);
  };

  const cancelNameEdit = () => {
    setNameSaveError(null);
    setIsEditingName(false);
    setEditName(pendingName || user?.name || "");
  };

  const handleSaveName = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    setNameSaveError(null);
    try {
      await updateProfile({ name: editName.trim() });
      setIsEditingName(false);
    } catch (e) {
      console.error("Failed to update name", e);
      setNameSaveError(e instanceof Error ? e.message : t("昵称修改失败，请稍后重试。"));
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
      setAvatarUploadError(err instanceof Error ? err.message : t("头像上传失败，请稍后重试。"));
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  };

  // 实名认证成功后关闭弹窗；认证状态由 Modal 内部 refreshProfile 刷新 session 驱动
  const handleVerifySuccess = () => {
    setShowVerifyModal(false);
  };

  const handleOpenVerifyModal = () => {
    setShowVerifyModal(true);
  };

  const mapRealnameSyncError = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "phone_required":
          return t("当前账号未设置安全手机，暂时无法继续认证。");
        case "realname_required":
          return t("请先完成姓名和身份证认证。");
        case "shadow_binding_incomplete":
          return t("LightVela 账号绑定尚未完成，请稍后重试。");
        case "shadow_binding_disabled":
          return t("LightVela 账号同步暂未开放，请稍后再试。");
        case "shadow_basic_auth_failed":
          return t("LightVela 实名信息同步失败，请稍后重试。");
        default:
          break;
      }
      if (err.status === 502 || err.status === 503) {
        return t("LightVela 实名信息同步服务繁忙，请稍后再试。");
      }
      return err.message || t("LightVela 实名信息同步失败，请稍后重试。");
    }
    return t("网络异常，请稍后再试。");
  };

  const handleRetryRealnameSync = async () => {
    if (realnameSyncRetrying) return;
    setRealnameSyncRetrying(true);
    setRealnameSyncError(null);
    try {
      await auth.retryRealnameSync();
      await refreshProfile();
    } catch (err) {
      setRealnameSyncError(mapRealnameSyncError(err));
    } finally {
      setRealnameSyncRetrying(false);
    }
  };

  const handlePhoneChangeSuccess = () => {
    setShowChangePhoneModal(false);
  };

  const mapEmailBindError = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "invalid_email":
          return t("邮箱格式不正确，请检查后重试。");
        case "email_already_bound":
          return t("当前账号已绑定邮箱。");
        case "email_bind_cooldown":
          return t("发送过于频繁，请稍后再试。");
        case "email_bind_disabled":
        case "email_bind_unavailable":
          return t("邮箱绑定服务暂未开放，请稍后再试。");
        case "email_send_failed":
          return t("验证邮件发送失败，请稍后重试。");
        default:
          break;
      }
      if (err.status === 429) {
        return t("发送过于频繁，请稍后再试。");
      }
      return err.message || t("发送验证邮件失败，请稍后重试。");
    }
    return t("网络异常，请稍后再试。");
  };

  const handleRequestEmailBind = async () => {
    const trimmed = bindEmail.trim();
    if (!EMAIL_REGEX.test(trimmed) || emailBindSubmitting || emailBindCooldown > 0) return;
    setEmailBindSubmitting(true);
    setEmailBindError(null);
    setEmailBindSuccess(null);
    try {
      const response = await auth.requestEmailBind({ email: trimmed });
      const seconds = Math.max(0, response.cooldownSeconds ?? 0);
      setEmailBindCooldown(seconds);
      setEmailBindSuccess(t("验证邮件已发送，请前往邮箱点击链接完成绑定。"));
    } catch (err) {
      setEmailBindError(mapEmailBindError(err));
    } finally {
      setEmailBindSubmitting(false);
    }
  };

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
      // Users can still select the visible ID manually when clipboard permission is unavailable.
    }
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

  let pageContent: ReactNode;
  let pageOverlays: ReactNode = null;

  /* ── Unauthenticated view ── */
  if (authReady && !isAuthenticated) {
    pageContent = (
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
              {t("登录以查看账号信息")}
            </h2>
            <p className="mb-8 mt-2 text-sm leading-relaxed" style={{ color: "#999" }}>
              {t("登录后可查看和管理你的个人信息、订阅套餐和订单记录。")}
            </p>

            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => setShowLoginModal(true)}
                className="lw-btn-primary w-full"
              >
                {t("登录 / 注册")}
              </button>
              <button
                onClick={() => {
                  setGuestLoading(true);
                  setGuestError(null);
                  signInAsGuest()
                    .catch(() => setGuestError(t("游客登录失败，请稍后重试。")))
                    .finally(() => setGuestLoading(false));
                }}
                disabled={guestLoading}
                className="w-full rounded-lg border px-4 py-3 text-[15px] font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ borderColor: "rgba(0,0,0,0.1)", color: "#999" }}
              >
                {guestLoading ? t("进入中...") : t("游客体验")}
              </button>
            </div>

            {guestError && (
              <p className="mt-3 text-[13px]" style={{ color: "#cf3d4c" }}>{guestError}</p>
            )}

            <AppLink
              to="/"
              className="mt-6 inline-block text-[13px] transition-colors hover:text-[#666]"
              style={{ color: "#bbb" }}
            >
              ← {t("返回首页")}
            </AppLink>
          </motion.div>

          <LoginModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
        </main>
    );
  } else if (!authReady) {
    /* ── Loading auth ── */
    pageContent = (
        <main className="relative z-10 flex-grow pb-8 pt-20 md:pt-24" aria-hidden="true">
          <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
            <div className="mb-8 h-9 w-36 rounded-full bg-black/[0.06]" />
            <div className="space-y-4">
              <div className="h-40 rounded-lg bg-black/[0.04]" />
              <div className="h-24 rounded-lg bg-black/[0.04]" />
              <div className="h-24 rounded-lg bg-black/[0.04]" />
            </div>
          </section>
        </main>
    );
  } else {
    /* ── Authenticated view ── */
    pageContent = (
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

          {/* 实名提醒 tips：从首页「立即创建」跳转、且尚未完成实名认证时展示（仅国内站） */}
          {realnameRequiredTip && !verified && showRealnameSection && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-xl px-4 py-3"
              style={{
                background: "var(--color-warning-bg, rgba(255, 161, 0, 0.1))",
                border: "1px solid var(--color-warning-border, rgba(255, 161, 0, 0.35))",
              }}
            >
              <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0" style={{ color: "var(--color-warning, #C67B1E)" }} />
              <p className="m-0 text-sm" style={{ color: "var(--color-warning-text, rgba(0,0,0,0.75))", lineHeight: 1.5 }}>
                {realnameRequiredTip}
              </p>
            </motion.div>
          )}

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
                      title={avatarUploadError ?? (avatarUploading ? t("头像上传中...") : t("点击更换头像"))}
                    >
                      <img
                        src={displayAvatarSrc}
                        alt="avatar"
                        className={cn("h-14 w-14 object-cover transition-[filter,transform]", hasPendingAvatarAudit && "scale-105 blur-sm")}
                        style={{
                          border: hasPendingAvatarAudit ? "2px solid rgba(198, 123, 30, 0.55)" : "1px solid #E6E9EF",
                          borderRadius: "9999px",
                          background: "#F9F8F7",
                        }}
                      />
                      {hasPendingAvatarAudit && (
                        <span
                          className="absolute -bottom-1 -right-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: "#FFF4DE", color: "#9A5A00", border: "1px solid rgba(198, 123, 30, 0.28)" }}
                        >
                          {t("审核中")}
                        </span>
                      )}
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
                            onClick={cancelNameEdit}
                            className="rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[rgba(0,0,0,0.03)]"
                            style={{ color: "#aaa" }}
                          >
                            {t("取消")}
                          </button>
                        </div>
                        {nameSaveError && (
                          <p className="w-full text-xs" style={{ color: "#cf3d4c", lineHeight: 1.5 }}>
                            {nameSaveError}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <p
                            className={cn("truncate transition-[filter]", hasPendingNameAudit && "select-none blur-sm")}
                            style={{ fontSize: 20, fontWeight: 500, color: "rgba(0,0,0,0.9)", lineHeight: 1.6 }}
                          >
                            {hasPendingNameAudit ? pendingName : user?.name || t("未设置")}
                          </p>
                          {hasPendingNameAudit && (
                            <span
                              className="inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{ background: "rgba(198, 123, 30, 0.12)", color: "#9A5A00" }}
                            >
                              {t("审核中")}
                            </span>
                          )}
                          <button
                            onClick={beginNameEdit}
                            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[rgba(0,0,0,0.04)]"
                            style={{ color: "#aaa" }}
                            aria-label={hasPendingNameAudit ? t("修改待审核昵称") : t("修改昵称")}
                            title={hasPendingNameAudit ? t("修改待审核昵称") : t("修改昵称")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {hasPendingNameAudit && (
                          <p className="text-xs" style={{ color: "rgba(0,0,0,0.5)", lineHeight: 1.5 }}>
                            {t("当前对外显示：")}<span style={{ color: "rgba(0,0,0,0.78)" }}>{user?.name || t("未设置")}</span>
                            {t("，审核通过后将自动生效。")}
                          </p>
                        )}
                        {nameAuditFailed && (
                          <p className="text-xs" style={{ color: "#cf3d4c", lineHeight: 1.5 }}>
                            {t("上次昵称修改未通过审核，当前仍使用原昵称。")}
                          </p>
                        )}
                      </div>
                    )}
                    {avatarUploadError && (
                      <p className="mt-1 text-xs" style={{ color: "#cf3d4c" }}>{avatarUploadError}</p>
                    )}
                    {hasPendingAvatarAudit && (
                      <p className="mt-1 text-xs" style={{ color: "rgba(0,0,0,0.5)", lineHeight: 1.5 }}>
                        {t("新头像已提交审核，审核通过后将对外生效。")}
                      </p>
                    )}
                    {avatarAuditFailed && (
                      <p className="mt-1 text-xs" style={{ color: "#cf3d4c", lineHeight: 1.5 }}>
                        {t("上次头像修改未通过审核，当前仍使用原头像。")}
                      </p>
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
                    {t("退出登录")}
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
                <div className="flex flex-col gap-12 px-8 py-8">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm flex-shrink-0" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>
                      {t("账号 ID")}
                    </span>
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

              {(showEmailBindSection || showRealnameSection) && (
                /* Bottom: info rows —— 安全手机 / 实名认证 / 绑定邮箱 */
                <div className="flex flex-col gap-12 px-8 pb-8">
                  {showEmailBindSection && (
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-sm flex-shrink-0" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>
                          {t("绑定邮箱")}
                        </span>
                        {user?.emailVerified ? (
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm" style={{ color: "rgba(0,0,0,0.9)", maxWidth: 260 }}>
                              {user.email || t("已绑定")}
                            </span>
                            <span className="inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: "rgba(22, 163, 74, 0.1)", color: "var(--color-success)" }}>
                              {t("已验证")}
                            </span>
                          </div>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                            <input
                              type="email"
                              value={bindEmail}
                              onChange={(e) => setBindEmail(e.target.value)}
                              placeholder={t("请输入邮箱地址")}
                              className="lw-input min-w-0 max-w-[280px] flex-1"
                              autoComplete="email"
                            />
                            <button
                              type="button"
                              onClick={() => void handleRequestEmailBind()}
                              disabled={
                                emailBindSubmitting
                                || emailBindCooldown > 0
                                || !EMAIL_REGEX.test(bindEmail.trim())
                              }
                              className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-full bg-black/90 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {emailBindSubmitting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : emailBindCooldown > 0 ? (
                                t("{{seconds}} 秒", { seconds: emailBindCooldown })
                              ) : (
                                t("发送验证邮件")
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      {!user?.emailVerified && (
                        <p className="m-0 text-xs" style={{ color: "rgba(0,0,0,0.45)", lineHeight: 1.5 }}>
                          {t("绑定邮箱后可用于接收导出完成通知等重要消息。")}
                        </p>
                      )}
                      {emailBindSuccess && (
                        <p className="m-0 text-xs" style={{ color: "var(--color-success)", lineHeight: 1.5 }}>
                          {emailBindSuccess}
                        </p>
                      )}
                      {emailBindError && (
                        <p className="m-0 text-xs" style={{ color: "#cf3d4c", lineHeight: 1.5 }}>
                          {emailBindError}
                        </p>
                      )}
                    </div>
                  )}

                  {showSafetyPhoneSection && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>{t("安全手机")}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-sm" style={{ color: user?.phone ? "rgba(0,0,0,0.9)" : "rgba(0,0,0,0.5)" }}>
                          {user?.phone || t("未绑定")}
                        </span>
                        <button
                          onClick={() => setShowChangePhoneModal(true)}
                          className="flex items-center gap-1 text-sm transition-colors hover:opacity-80"
                          style={{ color: "var(--lw-accent)" }}
                        >
                          {user?.phone ? t("修改") : t("绑定")}
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {showRealnameSection && (
                    <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: "rgba(0,0,0,0.5)", lineHeight: "24px" }}>{t("实名认证")}</span>
                    {verified ? (
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-5 w-5 flex-shrink-0" style={{ color: "var(--color-success)" }} />
                          <span className="text-sm" style={{ color: "rgba(0,0,0,0.9)" }}>
                            {realnameStatusLabel}
                          </span>
                        </div>
                        <button
                          onClick={handleOpenVerifyModal}
                          className="flex items-center gap-1 text-sm transition-colors hover:opacity-80"
                          style={{ color: "var(--lw-accent)" }}
                        >
                          {t("修改")}
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        {(phoneProofEnabled || faceIdFlowEnabled) && (idCardVerified || realnameSyncError) && (
                          <div className="flex flex-col items-end gap-1">
                            {realnameStatusLabel && (
                              <span
                                className="text-sm"
                                style={{ color: idCardSyncStatus === "failed" ? "var(--color-danger, #D92D20)" : "rgba(0,0,0,0.5)" }}
                              >
                                {realnameStatusLabel}
                              </span>
                            )}
                            {realnameSyncError && (
                              <span className="max-w-[240px] text-right text-xs" style={{ color: "var(--color-danger, #D92D20)" }}>
                                {realnameSyncError}
                              </span>
                            )}
                          </div>
                        )}
                        <button
                          onClick={realnameSyncNeedsRetry ? () => void handleRetryRealnameSync() : handleOpenVerifyModal}
                          disabled={realnameSyncRetrying}
                          className="flex items-center gap-1 text-sm transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                          style={{ color: "var(--lw-accent)" }}
                        >
                          {realnameSyncRetrying && <Loader2 className="h-4 w-4 animate-spin" />}
                          {realnameSyncNeedsRetry
                            ? t("重新同步")
                            : phoneProofEnabled && idCardVerified
                              ? t("继续认证")
                              : t("去认证")}
                          {!realnameSyncRetrying && <ChevronRight className="h-4 w-4" />}
                        </button>
                      </div>
                    )}
                  </div>
                  )}
                </div>
              )}
            </motion.div>

            {/* ── Section 2: Subscription ── */}
            <SubscriptionSection subscription={subscription} pass={activePass} showAccountRenewTools={showAccountRenewTools} />

            {/* ── Sign out (page bottom) ── */}
            <motion.div variants={fadeIn} className="flex justify-center pt-2">
              <button
                onClick={() => void handleSignOut()}
                className="inline-flex items-center justify-center rounded-full bg-white px-6 py-2.5 transition-colors hover:bg-[rgba(0,0,0,0.03)]"
                style={{
                  border: "1px solid #E6E9EF",
                  fontSize: 14,
                  lineHeight: "22px",
                  color: "rgba(0,0,0,0.9)",
                  boxShadow: "0px 2px 0px 0px rgba(187, 187, 187, 0.05)",
                }}
              >
                {t("退出登录")}
              </button>
            </motion.div>
          </motion.div>
        </section>
      </main>
    );

    pageOverlays = (
      <AnimatePresence>
        {showRealnameSection && showVerifyModal && (
          <VerifyIdentityModal
            key="verify"
            onClose={() => setShowVerifyModal(false)}
            onSuccess={handleVerifySuccess}
            verified={verified}
            phoneVerificationEnabled={phoneProofEnabled}
            realnameLevel={user?.realnameLevel}
            realnameSyncStatus={realnameSyncStatus}
            faceIdFlowEnabled={faceIdFlowEnabled}
            phone={user?.phone}
          />
        )}
        {showRealnameSection && phoneProofEnabled && user?.phone && showChangePhoneModal && (
          <ChangePhoneModal
            key="change-phone"
            currentPhone={user?.phone}
            onClose={() => setShowChangePhoneModal(false)}
            onSuccess={handlePhoneChangeSuccess}
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
    );
  }

  return (
    <ProductPageShell afterFooter={pageOverlays}>
      {pageContent}
    </ProductPageShell>
  );
};

// InfoRow 组件保留定义以便后续功能上线时恢复使用。
// 通过 void 引用避免 TS 未使用告警（code: 6133）。
void InfoRow;

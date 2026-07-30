import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Camera, CircleAlert, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { REALNAME_LEVEL, type User } from "@/domain/types";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { RepositoryError } from "@/repositories/http-repositories";
import { QRCodeSVG } from "qrcode.react";
import { RealnameStepper, type RealnameStage } from "@/pages/marketing/realname-stepper";

export type RealnameSyncStatus = NonNullable<User["realnameSyncStatus"]>;

/* ─── Verify Identity Modal ─── */

const FACE_ID_PENDING_POLL_DELAYS_MS = [250, 500, 1000, 1500, 2000, 3000, 5000, 8000, 10000];

const formatFaceIdExpiry = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const REALNAME_ERROR_FIELD = {
  IDENTITY: "identity",
  NAME: "name",
  ID_CARD: "idCard",
  PHONE: "phone",
  SMS_CODE: "smsCode",
  GLOBAL: "global",
} as const;

type RealnameErrorField = (typeof REALNAME_ERROR_FIELD)[keyof typeof REALNAME_ERROR_FIELD];

type RealnameFormError = {
  field: RealnameErrorField;
  title: string;
  description?: string;
};

const InlineValidationMessage = ({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: string;
}) => (
  <div id={id} className="flex items-start gap-2.5" role="alert">
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
    <div className="min-w-0">
      <p className="m-0 text-[13px] font-medium leading-5 text-[var(--danger)]">{title}</p>
      {description && (
        <p className="mb-0 mt-0.5 text-[13px] leading-5 text-[var(--text-tertiary)]">{description}</p>
      )}
    </div>
  </div>
);

export const VerifyIdentityModal = ({
  onClose,
  onSuccess,
  verified,
  phoneVerificationEnabled,
  realnameLevel,
  realnameSyncStatus,
  faceIdFlowEnabled,
  faceCaptureEnabled,
  facelessFlowEnabled,
  phone,
  layerClassName = "z-50",
}: {
  onClose: () => void;
  onSuccess: () => void;
  verified: boolean;
  phoneVerificationEnabled: boolean;
  realnameLevel?: string;
  realnameSyncStatus?: RealnameSyncStatus;
  faceIdFlowEnabled: boolean;
  faceCaptureEnabled: boolean;
  facelessFlowEnabled: boolean;
  phone?: string;
  layerClassName?: string;
}) => {
  const t = useT();
  const { auth } = useRepositories();
  const { refreshProfile } = useSession();
  const normalizedPhone = phone?.trim() ?? "";
  const hasIdCardVerified = phoneVerificationEnabled
    && (verified || realnameLevel === "idcard_2fa" || realnameLevel === "phone_3fa");
  const initialStage: RealnameStage = faceIdFlowEnabled
    ? !verified && realnameLevel === REALNAME_LEVEL.PHONE_3FA
      ? "shadow"
      : "identity"
    : hasIdCardVerified
      ? "phone"
      : "identity";
  const [stage, setStage] = useState<RealnameStage>(initialStage);
  const reduceMotion = useReducedMotion();
  const [realName, setRealName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [phoneInput, setPhoneInput] = useState(normalizedPhone);
  const [smsCode, setSmsCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<RealnameFormError | null>(null);
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
  const PHONE_REGEX = /^1\d{10}$/;
  const phoneForVerification = normalizedPhone || phoneInput.trim();
  const canSubmitIdentity = realName.trim().length >= 2 && ID_CARD_REGEX.test(idNumber.trim());
  const canSubmitLegacyIdentity = canSubmitIdentity;
  const canSubmitFaceIdIdentity = canSubmitIdentity && consent;
  const canSubmitPhone = PHONE_REGEX.test(phoneForVerification) && smsCode.trim().length >= 4;
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

  const mapErrorMessage = (err: unknown): RealnameFormError => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "phone_required":
          return {
            field: REALNAME_ERROR_FIELD.PHONE,
            title: t("请输入手机号"),
            description: t("请输入用于实名认证的中国大陆手机号。"),
          };
        case "invalid_phone":
          return {
            field: REALNAME_ERROR_FIELD.PHONE,
            title: t("手机号格式不正确"),
            description: t("请输入 11 位中国大陆手机号后重试。"),
          };
        case "phone_in_use":
          return {
            field: REALNAME_ERROR_FIELD.PHONE,
            title: t("该手机号暂不可使用"),
            description: t("该手机号已绑定其他 LightVela 账号，请更换手机号或联系管理员。"),
          };
        case "sms_code_not_found":
          return {
            field: REALNAME_ERROR_FIELD.SMS_CODE,
            title: t("请先获取验证码"),
            description: t("获取短信验证码后再完成手机号认证。"),
          };
        case "sms_code_expired":
          return {
            field: REALNAME_ERROR_FIELD.SMS_CODE,
            title: t("验证码已过期"),
            description: t("请重新获取短信验证码后再试。"),
          };
        case "invalid_sms_code":
          return {
            field: REALNAME_ERROR_FIELD.SMS_CODE,
            title: t("验证码不正确"),
            description: t("请检查短信中的验证码后重试。"),
          };
        case "invalid_realname":
          return {
            field: REALNAME_ERROR_FIELD.NAME,
            title: t("姓名格式不正确"),
            description: t("请输入身份证上的真实姓名。"),
          };
        case "invalid_id_card":
          return {
            field: REALNAME_ERROR_FIELD.ID_CARD,
            title: t("身份证号格式不正确"),
            description: t("请输入 18 位中国大陆居民身份证号。"),
          };
        case "realname_mismatch":
          return {
            field: REALNAME_ERROR_FIELD.IDENTITY,
            title: t("身份信息未通过核验"),
            description: t("请确认姓名与身份证上的信息完全一致后重试。"),
          };
        case "realname_verify_failed":
          return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("实名核验失败"), description: t("请稍后重新提交认证。") };
        case "realname_unavailable":
          return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("实名认证暂不可用"), description: t("请稍后再试。") };
        case "shadow_binding_failed":
        case "shadow_binding_incomplete":
        case "shadow_basic_auth_failed":
          return {
            field: REALNAME_ERROR_FIELD.GLOBAL,
            title: t("实名信息同步失败"),
            description: t("你无需重新填写信息，请稍后重试。"),
          };
        default:
          break;
      }
      if (err.status === 502 || err.status === 503) {
        return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("认证服务暂时繁忙"), description: t("请稍后再试。") };
      }
      return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("实名认证失败"), description: t("请稍后重试。") };
    }
    if (err instanceof Error && err.message.trim().length > 0) {
      return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("实名认证失败"), description: t("请稍后重试。") };
    }
    return { field: REALNAME_ERROR_FIELD.GLOBAL, title: t("网络连接异常"), description: t("请检查网络连接后重试。") };
  };

  const clearErrorFor = (...fields: RealnameErrorField[]) => {
    setError((current) => current && fields.includes(current.field) ? null : current);
  };

  const getPollErrorMessage = (err: unknown) => {
    const mappedError = mapErrorMessage(err);
    return mappedError.description ?? mappedError.title;
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
        if (!cancelled && status !== 404) setError(mapErrorMessage(err));
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
        .catch((err: unknown) => setPollError(getPollErrorMessage(err)));
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
    if (!PHONE_REGEX.test(phoneForVerification) || sendingCode || cooldownSeconds > 0) return false;
    setSendingCode(true);
    setError(null);
    try {
      const result = faceIdFlowEnabled && attempt?.attemptId
        ? await auth.sendRealnameFaceIdPhoneCode(attempt.attemptId, { phone: phoneForVerification })
        : await auth.sendSmsCode({ phone: phoneForVerification });
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
    setPhoneInput(normalizedPhone);
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
            setError({
              field: REALNAME_ERROR_FIELD.PHONE,
              title: t("当前账号未绑定手机号"),
              description: t("请先使用手机号登录或绑定手机号。"),
            });
            return;
          }
          setStage("phone");
          return;
        }

        let nextAttempt = await auth.startRealnameFaceIdAttempt({
          name: realName.trim(),
          idCard: idNumber.trim().toUpperCase(),
          consent: true,
        });
        if (facelessFlowEnabled && normalizedPhone && nextAttempt.state === "face_succeeded") {
          nextAttempt = await auth.getRealnameFaceIdAttempt(nextAttempt.attemptId);
        }
        await applyAttemptState(nextAttempt);
        return;
      }

      if (stage === "phone") {
        if (faceIdFlowEnabled && attempt?.attemptId) {
          const phoneAttempt = await auth.verifyRealnameFaceIdPhone(attempt.attemptId, {
            phone: phoneForVerification,
            code: smsCode.trim(),
          });
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
      if (faceCaptureEnabled) return t("开始刷脸认证");
      if (facelessFlowEnabled && normalizedPhone) return t("提交认证");
      if (faceIdFlowEnabled) return t("下一步");
      return verified ? t("更新认证") : t("提交认证");
    }
    if (stage === "phone") {
      if (!faceIdFlowEnabled) return t("完成三要素认证");
      return normalizedPhone ? t("完成当前手机号认证") : t("完成手机号认证");
    }
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
  const modalTitle = verified ? t("修改实名认证") : t("实名认证");
  const stageDescription = stage === "identity"
    ? verified
      ? t("填写新的身份信息，通过核验后将更新当前实名。")
      : faceCaptureEnabled
        ? t("填写与你身份证一致的信息，下一步将进行人脸核身。")
        : facelessFlowEnabled && normalizedPhone
          ? t("填写与你身份证一致的信息，完成实名认证。")
        : faceIdFlowEnabled
          ? t("填写与身份证一致的信息，完成核验后验证安全手机号。")
          : t("填写与你身份证一致的信息，完成实名认证。")
    : stage === "face"
      ? t("使用手机完成核身，结果会在当前页面自动更新。")
      : stage === "phone"
        ? normalizedPhone
          ? t("验证当前绑定手机号，完成最后一步认证。")
          : t("绑定并验证中国大陆手机号，完成最后一步认证。")
        : t("认证已完成，正在同步最终结果。");
  const safetyText = faceCaptureEnabled
    ? t("你的姓名、身份证号和核身过程仅用于本次实名认证")
    : phoneVerificationEnabled
      ? t("你的姓名、身份证号和手机号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。")
      : t("你的姓名和身份证号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。");
  const fieldClassName = "h-11 w-full rounded-md border border-[var(--realname-control-border)] bg-[var(--surface-base)] px-4 text-sm text-[var(--text-primary)] outline-none transition-shadow duration-150 placeholder:text-[var(--text-tertiary)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]";
  const invalidFieldClassName = "border-[color-mix(in_oklab,var(--danger)_50%,transparent)] focus-visible:border-[color-mix(in_oklab,var(--danger)_60%,transparent)] focus-visible:ring-[color-mix(in_oklab,var(--danger)_15%,transparent)]";
  const identityErrorId = "realname-identity-error";
  const nameErrorId = "realname-name-error";
  const idCardErrorId = "realname-id-card-error";
  const phoneErrorId = "realname-phone-error";
  const smsCodeErrorId = "realname-sms-code-error";
  const errorMessageId = error ? {
    [REALNAME_ERROR_FIELD.IDENTITY]: identityErrorId,
    [REALNAME_ERROR_FIELD.NAME]: nameErrorId,
    [REALNAME_ERROR_FIELD.ID_CARD]: idCardErrorId,
    [REALNAME_ERROR_FIELD.PHONE]: phoneErrorId,
    [REALNAME_ERROR_FIELD.SMS_CODE]: smsCodeErrorId,
    [REALNAME_ERROR_FIELD.GLOBAL]: "realname-global-error",
  } satisfies Record<RealnameErrorField, string> : null;
  const isIdentityGroupInvalid = error?.field === REALNAME_ERROR_FIELD.IDENTITY;
  const isNameInvalid = isIdentityGroupInvalid || error?.field === REALNAME_ERROR_FIELD.NAME;
  const isIdCardInvalid = isIdentityGroupInvalid || error?.field === REALNAME_ERROR_FIELD.ID_CARD;
  const isPhoneInvalid = error?.field === REALNAME_ERROR_FIELD.PHONE;
  const isSmsCodeInvalid = error?.field === REALNAME_ERROR_FIELD.SMS_CODE;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay asChild>
          <motion.div
            className={cn("fixed inset-0 bg-[rgba(0,0,0,0.45)]", layerClassName)}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
          />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          asChild
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <motion.div
            className={cn(
              "fixed inset-x-4 bottom-4 flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl border border-[var(--realname-control-border)] bg-[var(--surface-base)] shadow-[0_24px_48px_-12px_rgba(0,0,0,0.15)] outline-none md:inset-auto md:left-1/2 md:top-1/2 md:w-[680px] md:max-w-[calc(100vw-2rem)] md:-translate-x-1/2 md:-translate-y-1/2",
              layerClassName,
            )}
            initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
          >
            <header className="shrink-0 px-6 pb-5 pt-6 md:px-8 md:pb-6 md:pt-7">
              <div className="flex items-start gap-6">
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="m-0 text-balance text-[22px] font-semibold leading-8 text-black/90">
                    {modalTitle}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mb-0 mt-1 text-pretty text-sm leading-6 text-black/50">
                    {stageDescription}
                  </DialogPrimitive.Description>
                </div>
                <DialogPrimitive.Close asChild>
                  <button
                    type="button"
                    aria-label={t("关闭")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-black/45 transition-colors duration-150 hover:bg-black/[0.04] hover:text-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/15"
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                </DialogPrimitive.Close>
              </div>

              {faceIdFlowEnabled && (
                <div className="mt-6">
                  <RealnameStepper
                    stage={stage}
                    includeFaceStep={faceCaptureEnabled}
                    includePhoneStep={!facelessFlowEnabled || !normalizedPhone || stage === "phone"}
                    labels={{
                      identity: t("身份信息"),
                      face: t("人脸核身"),
                      phone: faceCaptureEnabled ? t("手机验证") : t("安全手机"),
                    }}
                  />
                </div>
              )}

              {verified && stage === "identity" && (
                <div className="mt-5 flex items-center gap-2 rounded-md bg-[rgba(7,193,96,0.1)] px-3 py-2 text-sm text-black/75">
                  <ShieldCheck className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
                  <span>{t("当前账号已完成实名。修改后会覆盖当前实名信息。")}</span>
                </div>
              )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--realname-control-border)] px-6 py-6 md:px-8">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={stage}
                  data-testid="realname-stage-content"
                  className="flex flex-col gap-5"
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
                >
                  {stage === "identity" && (
                    <>
                      <div className="flex items-center justify-between rounded-md bg-[var(--realname-control-muted)] px-4 py-3 text-sm">
                        <span className="text-black/45">{t("证件类型")}</span>
                        <span className="font-medium text-black/75">{t("中国大陆居民身份证")}</span>
                      </div>

                      <div className="grid gap-5 md:grid-cols-[0.7fr_1.3fr]">
                        <div className="flex flex-col gap-2">
                          <label htmlFor="realname-name" className="text-sm font-medium text-black/90">
                            {t("真实姓名")} <span className="text-[var(--danger)]">*</span>
                          </label>
                          <input
                            id="realname-name"
                            type="text"
                            autoComplete="name"
                            placeholder={t("请输入真实姓名")}
                            value={realName}
                            onChange={(event) => {
                              setRealName(event.target.value);
                              clearErrorFor(REALNAME_ERROR_FIELD.NAME, REALNAME_ERROR_FIELD.IDENTITY);
                            }}
                            maxLength={20}
                            aria-invalid={isNameInvalid}
                            aria-describedby={isNameInvalid ? (isIdentityGroupInvalid ? identityErrorId : nameErrorId) : undefined}
                            className={cn(fieldClassName, isNameInvalid && invalidFieldClassName)}
                          />
                        </div>

                        <div className="flex flex-col gap-2">
                          <label htmlFor="realname-id-card" className="text-sm font-medium text-black/90">
                            {t("身份证号")} <span className="text-[var(--danger)]">*</span>
                          </label>
                          <input
                            id="realname-id-card"
                            type="text"
                            inputMode="text"
                            autoComplete="off"
                            placeholder={t("请输入身份证号码")}
                            value={idNumber}
                            onChange={(event) => {
                              setIdNumber(event.target.value.replace(/[^0-9Xx]/g, "").slice(0, 18));
                              clearErrorFor(REALNAME_ERROR_FIELD.ID_CARD, REALNAME_ERROR_FIELD.IDENTITY);
                            }}
                            maxLength={18}
                            aria-invalid={isIdCardInvalid}
                            aria-describedby={isIdCardInvalid ? (isIdentityGroupInvalid ? identityErrorId : idCardErrorId) : undefined}
                            className={cn(fieldClassName, isIdCardInvalid && invalidFieldClassName)}
                          />
                        </div>
                      </div>

                      {faceIdFlowEnabled && (
                        <label className="flex items-start gap-3 text-sm leading-6 text-black/70">
                          <input
                            type="checkbox"
                            checked={consent}
                            onChange={(event) => setConsent(event.target.checked)}
                            className="mt-1 size-4 rounded border-[var(--border-strong)]"
                            aria-label={t("我已阅读《隐私协议》并同意进行身份核验")}
                          />
                          <span>
                            {t("我已阅读")}
                            <a
                              href="https://privacy.qq.com/document/preview/a955b796edc34796b6e81d4f4df006f3"
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="text-[var(--lw-accent)] hover:underline"
                            >
                              {t("《隐私协议》")}
                            </a>
                            {t("并同意进行身份核验")}
                          </span>
                        </label>
                      )}
                    </>
                  )}

                  {stage === "face" && (
                    <>
                      {faceNeedsRestart || !attempt?.verificationUrl ? (
                        <div className="flex min-h-[248px] flex-col items-center justify-center text-center" role="status">
                          <div className="flex size-11 items-center justify-center rounded-full bg-black/[0.05]">
                            <ShieldAlert className="size-5 text-black/55" aria-hidden="true" />
                          </div>
                          <p className="mb-0 mt-4 text-base font-medium text-black/90">
                            {attempt?.state === "failed" ? t("本次刷脸未通过") : attempt?.state === "expired" ? t("本次刷脸已过期") : t("正在准备核身页面")}
                          </p>
                          <p className="mb-0 mt-2 text-sm leading-6 text-black/50">
                            {attempt?.state === "failed"
                              ? t("本次刷脸未通过，请重新发起认证。")
                              : attempt?.state === "expired"
                                ? t("本次刷脸已过期，请重新发起认证。")
                                : t("请稍候，核身页面准备完成后会自动显示。")}
                          </p>
                        </div>
                      ) : isMobileViewport ? (
                        <div className="flex min-h-[248px] flex-col items-center justify-center text-center">
                          <div className="flex size-12 items-center justify-center rounded-full bg-black/[0.05]">
                            <Camera className="size-5 text-black/60" aria-hidden="true" />
                          </div>
                          <p className="mb-0 mt-4 text-base font-medium text-black/90">{t("在手机上完成人脸核身")}</p>
                          <p className="mb-0 mt-2 max-w-sm text-pretty text-sm leading-6 text-black/50">
                            {t("打开腾讯核身页面，完成刷脸后返回这里，认证状态会自动更新。")}
                          </p>
                          <a
                            href={attempt.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-5 inline-flex h-11 items-center justify-center rounded-full bg-[var(--text-primary)] px-6 text-sm font-medium text-[var(--surface-base)]"
                          >
                            {t("打开刷脸页面")}
                          </a>
                        </div>
                      ) : (
                        <div className="grid min-h-[248px] items-center gap-8 md:grid-cols-[216px_1fr]">
                          <div className="flex flex-col items-center">
                            <div
                              role="img"
                              aria-label={t("核身二维码")}
                              className="rounded-2xl border border-[var(--realname-control-border)] bg-[var(--surface-base)] p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)]"
                            >
                              <QRCodeSVG value={attempt.verificationUrl} size={184} level="M" includeMargin={false} />
                            </div>
                            <p className="mb-0 mt-3 tabular-nums text-xs text-black/40">
                              {t("有效期至：{{time}}", { time: formatFaceIdExpiry(attempt.expiresAt) })}
                            </p>
                          </div>
                          <div>
                            <p className="m-0 text-balance text-lg font-semibold text-black/90">
                              {t("请使用手机扫码完成人脸核身")}
                            </p>
                            <ol className="mt-5 space-y-4 text-sm text-black/60">
                              {[t("使用微信或手机相机扫描二维码"), t("按页面提示完成人脸核验"), t("完成后返回，结果将自动更新")].map((item, index) => (
                                <li key={item} className="flex items-center gap-3">
                                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-xs font-medium text-black/55">
                                    {index + 1}
                                  </span>
                                  <span>{item}</span>
                                </li>
                              ))}
                            </ol>
                            <p className="mb-0 mt-5 flex items-center gap-2 text-sm text-black/45" role="status">
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                              {t("等待刷脸结果")}
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {stage === "phone" && (
                    <>
                      <div className="flex flex-col gap-2">
                        <label htmlFor="realname-phone" className="text-sm font-medium text-black/90">
                          {normalizedPhone ? t("当前手机号") : t("手机号")} <span className="text-[var(--danger)]">*</span>
                        </label>
                        <div className="flex gap-2">
                          <input
                            id="realname-phone"
                            type="tel"
                            inputMode="numeric"
                            autoComplete="tel"
                            placeholder={normalizedPhone ? undefined : t("请输入中国大陆手机号")}
                            value={phoneForVerification}
                            onChange={(event) => {
                              setPhoneInput(event.target.value.replace(/\D/g, "").slice(0, 11));
                              clearErrorFor(REALNAME_ERROR_FIELD.PHONE);
                            }}
                            disabled={Boolean(normalizedPhone)}
                            aria-invalid={isPhoneInvalid}
                            aria-describedby={isPhoneInvalid ? phoneErrorId : undefined}
                            className={cn(
                              fieldClassName,
                              normalizedPhone && "bg-[var(--realname-control-muted)]",
                              isPhoneInvalid && invalidFieldClassName,
                            )}
                          />
                          <button
                            type="button"
                            onClick={() => void sendPhoneCode()}
                            disabled={!PHONE_REGEX.test(phoneForVerification) || sendingCode || cooldownSeconds > 0}
                            className="h-11 shrink-0 rounded-full border border-[var(--text-primary)] px-5 text-sm font-medium text-[var(--text-primary)] transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {sendingCode
                              ? t("发送中...")
                              : cooldownSeconds > 0
                                ? t("重新发送 {{seconds}}s").replace("{{seconds}}", String(cooldownSeconds))
                                : t("获取验证码")}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        <label htmlFor="realname-sms-code" className="text-sm font-medium text-black/90">
                          {t("短信验证码")} <span className="text-[var(--danger)]">*</span>
                        </label>
                        <input
                          id="realname-sms-code"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder={t("请输入短信验证码")}
                          value={smsCode}
                          onChange={(event) => {
                            setSmsCode(event.target.value.replace(/\D/g, "").slice(0, 8));
                            clearErrorFor(REALNAME_ERROR_FIELD.SMS_CODE);
                          }}
                          maxLength={8}
                          aria-invalid={isSmsCodeInvalid}
                          aria-describedby={isSmsCodeInvalid ? smsCodeErrorId : undefined}
                          className={cn(fieldClassName, isSmsCodeInvalid && invalidFieldClassName)}
                        />
                      </div>
                    </>
                  )}

                  {stage === "shadow" && (
                    <div className="flex min-h-[248px] flex-col items-center justify-center text-center" role="status" aria-live="polite">
                      <div className="flex size-12 items-center justify-center rounded-full bg-black/[0.05]">
                        {shadowFailed
                          ? <ShieldAlert className="size-5 text-black/55" aria-hidden="true" />
                          : <Loader2 className="size-5 animate-spin text-black/55" aria-hidden="true" />}
                      </div>
                      <p className="mb-0 mt-4 text-base font-medium text-black/90">
                        {error?.title
                          ?? (pollError
                            ? t("状态更新遇到问题")
                            : shadowFailed
                              ? t("LightVela 实名同步失败")
                              : t("正在确认最终实名结果"))}
                      </p>
                      <p className="mb-0 mt-2 max-w-md text-pretty text-sm leading-6 text-black/50">
                        {error?.description
                          ?? pollError
                          ?? (shadowFailed
                            ? t("你无需重新刷脸，可直接重试当前实名同步。")
                            : awaitingFinalRefresh
                              ? t("正在刷新最终实名状态...")
                              : t("实名信息同步中"))}
                      </p>
                    </div>
                  )}

                </motion.div>
              </AnimatePresence>
            </div>

            {!(faceIdFlowEnabled && stage === "shadow") && (
              <footer className="shrink-0 border-t border-[var(--realname-control-border)] px-6 py-5 md:px-8">
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div
                    data-testid="realname-feedback-area"
                    className="flex min-h-16 w-full max-w-[420px] items-center sm:min-h-11"
                    aria-live="polite"
                  >
                    {error && errorMessageId ? (
                      <InlineValidationMessage
                        id={errorMessageId[error.field]}
                        title={error.title}
                        description={error.description}
                      />
                    ) : pollError ? (
                      <InlineValidationMessage
                        id="realname-poll-error"
                        title={t("状态更新遇到问题")}
                        description={pollError}
                      />
                    ) : (
                      <p className="m-0 text-pretty text-xs leading-5 text-black/35">
                        {safetyText}
                      </p>
                    )}
                  </div>
                  {faceNeedsRestart ? (
                    <button
                      type="button"
                      onClick={restartFaceIdFlow}
                      className="inline-flex h-11 w-full items-center justify-center rounded-full bg-[var(--text-primary)] px-6 text-sm font-medium text-[var(--surface-base)] sm:w-auto sm:min-w-40"
                    >
                      {t("重新开始认证")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSubmit()}
                      disabled={!canSubmit || submitting || awaitingFinalRefresh}
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--text-primary)] px-6 text-sm font-medium text-[var(--surface-base)] transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-40"
                    >
                      {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                      {submitting
                        ? stage === "phone"
                          ? t("认证中...")
                          : stage === "shadow"
                            ? t("处理中...")
                            : verified
                              ? t("更新中...")
                              : t("提交中...")
                        : primaryButtonLabel}
                    </button>
                  )}
                </div>
              </footer>
            )}
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

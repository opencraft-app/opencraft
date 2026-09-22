import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import { useOpenClaw } from "@/contexts/agent-context";
import { usePaidBillingEnabled, useRealnamePhoneVerificationEnabled, useReferralEnabled } from "@/contexts/runtime-config-context";
import { RepositoryError } from "@/repositories/http-repositories";
import { REALNAME_LEVEL } from "@/domain/types";
import { LoginModal } from "@/components/site/login-modal";
import { ProductPageShell, ProductReturnHomeHeader } from "@/components/site/product-chrome";
import { Button } from "@/components/ui/button";
import { DisplayTitle } from "@/components/ui/display-title";
import { useT } from "@/i18n/t";
import { avatarImageUrl } from "@/lib/avatar-image";
import { isPaidBillingEnabled } from "@/lib/billing-flow";
import { resolveBillingErrorMessage } from "@/lib/billing-error";
import { AppLink, useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { isCN, isGlobal } from "@/lib/region";
import { publicSiteHref } from "@/lib/public-site-navigation";
import { resolveVisiblePublicSiteLocale } from "@/lib/public-site-routing";
import { isRenewalRealnameVerified } from "@/lib/renewal-realname";
import { AccountPreviewStateSwitcher } from "@/components/dev/account-preview-state-switcher";
import { AccountProfileCard, AccountSecurityCard, AccountSubscriptionCard } from "@/components/account";
import {
  AccountDeleteDialog,
  AccountPageGate,
  BindEmailDialog,
  ChangePhoneDialog,
  PassDeleteDialogController,
} from "@/components/account/account-dialogs";
import { AGENTS_HOME_PATH, REALNAME_REQUIRED_QUERY_KEY } from "@/lib/agent-routes";
import { CONSOLE_SHOW_EVENT } from "@/lib/console-show-event";
import { RenewPassModal } from "@/pages/marketing/renew-pass-modal";
import { SavedCardsSection } from "./saved-cards-section";
import { ReferralSection } from "./referral-section";
import { VerifyIdentityModal, type RealnameSyncStatus } from "@/pages/marketing/verify-identity-modal";
import { useAccountSubscriptionModel } from "@/lib/use-account-subscription-model";

/* ─── Main Account Page ─── */

export const AccountPage = ({ view = "account" }: { view?: "account" | "billing" }) => {
  const isBillingView = view === "billing";
  const t = useT();
  const { i18n } = useTranslation();
  const navigate = useAppNavigate();
  const [searchParams, setSearchParams] = useAppSearchParams();
  const { auth, plans } = useRepositories();
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
  const {
    activePass,
    modifyingPass,
    passUpgradeFailed,
    passesError,
    refreshPasses,
    user: openClawUser,
  } = useOpenClaw();
  const paidBillingActive = isPaidBillingEnabled(usePaidBillingEnabled());
  const subscribeHref = publicSiteHref("/subscribe", resolveVisiblePublicSiteLocale(null, i18n.language), { localized: isGlobal });
  const subscriptionModel = useAccountSubscriptionModel({
    userId: session.user?.id,
    activePass,
    modifyingPass,
    subscription,
    planName: openClawUser.plan.name,
    trialDays: openClawUser.plan.trialDays,
    paidBillingActive,
    global: isGlobal,
    passUpgradeFailed,
    subscribeHref,
    listMyPasses: plans.listMyPasses,
    refreshPasses,
  });

  useEffect(() => { void refreshPasses(); }, [refreshPasses]);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [nameSaveError, setNameSaveError] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarUploadError, setAvatarUploadError] = useState<string | null>(null);
  const [referralRevealed, setReferralRevealed] = useState(false);

  useEffect(() => {
    const revealReferral = () => setReferralRevealed(true);
    window.addEventListener(CONSOLE_SHOW_EVENT, revealReferral);
    return () => window.removeEventListener(CONSOLE_SHOW_EVENT, revealReferral);
  }, []);

  // Unauthenticated view state
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  const referralEnabled = useReferralEnabled();
  const faceIdBackendEnabled = user?.realnameAssuranceMode === "observe"
    || user?.realnameAssuranceMode === "face_required";
  const facelessFlowEnabled = user?.realnameAssuranceMode === "faceless";
  const hasSafetyPhone = Boolean(user?.phone?.trim());
  // FaceID 与 faceless 共享 attempt 状态机；faceless 仅跳过人脸采集节点。
  const faceIdFlowEnabled = faceIdBackendEnabled || facelessFlowEnabled;
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
          ? t("需重新完成认证")
          : "";
  const showRealnameSection = !isGlobal;
  // 灰度结束：实名认证完成后展示「安全手机」行（不再依赖隐藏入口）。
  const showSafetyPhoneSection = phoneProofEnabled && !isGlobal && verified;
  const showEmailBindSection = isCN;
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showChangePhoneModal, setShowChangePhoneModal] = useState(false);
  const [realnameSyncRetrying, setRealnameSyncRetrying] = useState(false);
  const [realnameSyncError, setRealnameSyncError] = useState<string | null>(null);
  // 从首页「立即创建」跳转过来、要求先完成实名认证时的提醒 tips
  const [realnameRequiredTip, setRealnameRequiredTip] = useState<string | null>(null);
  // 实名完成后需要跳回的页面路径（从 return_to query 读取，仅站内路径）
  const [realnameReturnTo, setRealnameReturnTo] = useState<string | null>(null);

  // Email bind —— 国内站微信/QQ 登录用户通过 Magic Link 绑定邮箱。
  // 邮箱输入/发送验证邮件的交互已收敛进 BindEmailDialog；这里仅保留 OAuth 回跳
  // （?email_bound / ?email_bind_error）结果提示所需的状态。
  const [emailBindError, setEmailBindError] = useState<string | null>(null);
  const [emailBindSuccess, setEmailBindSuccess] = useState<string | null>(null);
  // 绑定邮箱弹窗开关（点击「去绑定」打开，仅首次绑定，无换绑/解绑）
  const [showBindEmailModal, setShowBindEmailModal] = useState(false);
  const [copiedUserId, setCopiedUserId] = useState(false);
  const copyResetTimer = useRef<number | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

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
    if (isBillingView) return;
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
  }, [isBillingView, refreshProfile, searchParams, setSearchParams, t]);

  // 首页「立即创建」→ 未实名跳转到账号页时，展示实名提醒并清理 query
  useEffect(() => {
    // 国际站无实名概念，即便被手动拼接该 query 也不展示中文提醒
    if (isBillingView || isGlobal) return;
    if (searchParams.get(REALNAME_REQUIRED_QUERY_KEY) !== "1") return;

    // 读取 return_to（仅站内路径，防开放重定向），实名完成后自动跳回
    const returnTo = searchParams.get("return_to") ?? "";
    if (returnTo.startsWith("/") && !returnTo.startsWith("//")) {
      setRealnameReturnTo(returnTo);
    }

    const next = new URLSearchParams(searchParams);
    next.delete(REALNAME_REQUIRED_QUERY_KEY);
    next.delete("return_to");
    setSearchParams(next, { replace: true });

    setRealnameRequiredTip(t("创建 LightVela 前，请先完成实名认证。"));
  }, [isBillingView, searchParams, setSearchParams, t, isGlobal]);

  // 实名认证完成后自动清除提醒；若有 return_to 则自动跳回原页面
  useEffect(() => {
    if (!verified) return;
    setRealnameRequiredTip(null);
    if (realnameReturnTo) {
      const target = realnameReturnTo;
      setRealnameReturnTo(null);
      navigate(target);
    }
  }, [verified, realnameReturnTo, navigate]);

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

  const mapPhoneChangeError = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "invalid_phone": return t("手机号格式不正确，请检查后重试。");
        case "phone_in_use": return t("该手机号已绑定其他账号，请更换手机号。");
        case "sms_code_not_found": return t("请先获取短信验证码。");
        case "sms_code_expired": return t("验证码已过期，请重新获取。");
        case "invalid_sms_code": return t("验证码不正确，请检查后重试。");
        case "shadow_binding_failed":
        case "shadow_binding_incomplete": return t("安全手机同步失败，请稍后重试。");
        case "unauthorized": return t("登录已失效，请重新登录后再试。");
        default: break;
      }
      if (err.status === 502 || err.status === 503) return t("账号服务繁忙，请稍后重试。");
      return err.message || t("手机号修改失败，请稍后重试。");
    }
    return t("网络异常，请稍后再试。");
  };

  const handleSendPhoneChangeCode = async (phone: string) => {
    try {
      return await auth.sendPhoneChangeCode({ phone });
    } catch (err) {
      throw new Error(mapPhoneChangeError(err));
    }
  };

  const handleSubmitPhoneChange = async (input: { phone: string; code: string }) => {
    try {
      await auth.verifyPhoneChange(input);
      try {
        await refreshProfile();
      } catch (refreshError) {
        console.warn("Failed to refresh profile after phone change", refreshError);
      }
    } catch (err) {
      throw new Error(mapPhoneChangeError(err));
    }
  };

  const mapEmailBindError = (err: unknown): string => {
    if (err instanceof RepositoryError) {
      switch (err.code) {
        case "invalid_email": return t("邮箱格式不正确，请检查后重试。");
        case "email_already_bound": return t("当前账号已绑定邮箱。");
        case "email_bind_cooldown": return t("发送过于频繁，请稍后再试。");
        case "email_bind_disabled":
        case "email_bind_unavailable": return t("邮箱绑定服务暂未开放，请稍后再试。");
        case "email_send_failed": return t("验证邮件发送失败，请稍后重试。");
        default: break;
      }
      if (err.status === 429) return t("发送过于频繁，请稍后再试。");
      return err.message || t("发送验证邮件失败，请稍后重试。");
    }
    return t("网络异常，请稍后再试。");
  };

  const handleSendEmailBind = async (email: string) => {
    try {
      return await auth.requestEmailBind({ email });
    } catch (err) {
      throw new Error(mapEmailBindError(err));
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
    setIsSigningOut(true);
    navigate("/", { replace: true });
    try {
      await signOut();
    } catch (err) {
      setIsSigningOut(false);
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
  if (authReady && !isAuthenticated && !isSigningOut) {
    pageContent = (
        <main className="relative z-10 flex flex-grow items-center justify-center px-6 pb-16 pt-24 md:px-8">
          <div className="max-w-[360px] text-center">
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
            <DisplayTitle size="section" className="text-balance">
              {t("登录以查看账号信息")}
            </DisplayTitle>
            <p className="mb-8 mt-2 text-sm leading-relaxed" style={{ color: "#999" }}>
              {t("登录后可查看和管理你的个人信息、订阅套餐和订单记录。")}
            </p>

            <div className="flex flex-col gap-2.5">
              <Button
                type="button"
                onClick={() => setShowLoginModal(true)}
                className="w-full"
              >
                {t("登录 / 注册")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setGuestLoading(true);
                  setGuestError(null);
                  signInAsGuest()
                    .catch(() => setGuestError(t("游客登录失败，请稍后重试。")))
                    .finally(() => setGuestLoading(false));
                }}
                disabled={guestLoading}
                className="w-full"
              >
                {guestLoading ? t("进入中...") : t("游客体验")}
              </Button>
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
          </div>

          <LoginModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
        </main>
    );
  } else if (!authReady || isSigningOut) {
    /* ── Loading auth ── */
    pageContent = (
      <main className="relative z-10 flex-grow pb-8 pt-20 md:pt-24">
        <AccountPageGate
          authReady={authReady}
          isAuthenticated={isAuthenticated}
          isSigningOut={isSigningOut}
          subscriptionState={subscriptionModel.state}
          passesError={passesError}
          onRetry={() => {
            subscriptionModel.actions.onRetrySummary();
            void refreshPasses();
          }}
          loadingTitle={t("正在加载账号")}
          errorTitle={t("套餐列表加载失败")}
          retryLabel={t("重试")}
        >
          {null}
        </AccountPageGate>
      </main>
    );
  } else {
    /* ── Authenticated view ── */
    pageContent = (
      <main className="relative z-10 flex-grow px-6 pb-8 pt-20 md:px-8 md:pt-24">
      <AccountPageGate
        authReady={authReady}
        isAuthenticated={isAuthenticated}
        isSigningOut={isSigningOut}
        subscriptionState={subscriptionModel.state}
        passesError={passesError || subscriptionModel.error.summary}
        onRetry={() => {
          subscriptionModel.actions.onRetrySummary();
          void refreshPasses();
        }}
        loadingTitle={t("正在加载账号")}
        errorTitle={t("套餐列表加载失败")}
        errorDescription={t("请刷新套餐信息后重试。")}
        retryLabel={t("重试")}
      >
        <section className="mx-auto w-full max-w-[46rem]">
          {/* Page Header */}
          <DisplayTitle className="mb-6 text-balance md:mb-8">{isBillingView ? t("套餐与费用") : t("账号")}</DisplayTitle>

          {/* 实名提醒 tips：从首页「立即创建」跳转、且尚未完成实名认证时展示（仅国内站） */}
          {!isBillingView && realnameRequiredTip && !verified && showRealnameSection && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-md px-4 py-3"
              style={{
                background: "var(--color-warning-bg, rgba(255, 161, 0, 0.1))",
                border: "1px solid var(--color-warning-border, rgba(255, 161, 0, 0.35))",
              }}
            >
              <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0" style={{ color: "var(--color-warning, #C67B1E)" }} />
              <p className="m-0 text-sm" style={{ color: "var(--color-warning-text, rgba(0,0,0,0.75))", lineHeight: 1.5 }}>
                {realnameRequiredTip}
              </p>
            </div>
          )}

          {/* Sections */}
          <div className="space-y-6">
            {!isBillingView && <div className="space-y-6">
              <AccountProfileCard
                user={user}
                displayAvatarSrc={displayAvatarSrc}
                hasPendingAvatarAudit={hasPendingAvatarAudit}
                avatarAuditFailed={avatarAuditFailed}
                pendingName={pendingName}
                hasPendingNameAudit={hasPendingNameAudit}
                nameAuditFailed={nameAuditFailed}
                copiedUserId={copiedUserId}
                isEditingName={isEditingName}
                editName={editName}
                saving={saving}
                nameSaveError={nameSaveError}
                avatarUploading={avatarUploading}
                avatarUploadError={avatarUploadError}
                onAvatarUpload={(event) => void handleAvatarUpload(event)}
                onEditNameChange={setEditName}
                onBeginNameEdit={beginNameEdit}
                onCancelNameEdit={cancelNameEdit}
                onSaveName={() => void handleSaveName()}
                onCopyUserId={() => void handleCopyUserId()}
                onSignOut={() => void handleSignOut()}
              />

              {(showEmailBindSection || showRealnameSection) && (
                <AccountSecurityCard
                  email={user?.email}
                  emailVerified={Boolean(user?.emailVerified)}
                  phone={user?.phone}
                  showEmailBindSection={showEmailBindSection}
                  showSafetyPhoneSection={showSafetyPhoneSection}
                  showRealnameSection={showRealnameSection}
                  verified={verified}
                  realnameStatusLabel={realnameStatusLabel}
                  phoneProofEnabled={phoneProofEnabled}
                  faceIdFlowEnabled={faceIdFlowEnabled}
                  idCardVerified={idCardVerified}
                  realnameSyncNeedsRetry={realnameSyncNeedsRetry}
                  realnameSyncRetrying={realnameSyncRetrying}
                  idCardSyncStatus={idCardSyncStatus}
                  emailBindSuccess={emailBindSuccess}
                  emailBindError={emailBindError}
                  realnameSyncError={realnameSyncError}
                  onBindEmail={() => setShowBindEmailModal(true)}
                  onBindPhone={() => setShowChangePhoneModal(true)}
                  onChangePhone={() => setShowChangePhoneModal(true)}
                  onVerifyRealname={handleOpenVerifyModal}
                  onRetryRealnameSync={() => void handleRetryRealnameSync()}
                />
              )}
            </div>}

            {/* ── Section 2: Subscription ── */}
            {isBillingView && <AccountSubscriptionCard
              state={subscriptionModel.state}
              pass={subscriptionModel.pass}
              displayName={subscriptionModel.displayName}
              validity={subscriptionModel.validity}
              credits={subscriptionModel.credits}
              creditPacks={subscriptionModel.creditPacks}
              passStatus={subscriptionModel.passStatus}
              passState={subscriptionModel.passState}
              actions={subscriptionModel.actions}
              error={subscriptionModel.error}
              subscribeHref={subscribeHref}
            />}
            {isBillingView && subscriptionModel.dialogs.renewOpen && subscriptionModel.actions.renewalAvailable && subscriptionModel.pass ? (
              <RenewPassModal
                pass={subscriptionModel.pass}
                onClose={subscriptionModel.dialogs.closeRenew}
                onSuccess={() => void subscriptionModel.dialogs.handleRenewSuccess()}
                initialRealnameRequired={Boolean(session.user) && !isRenewalRealnameVerified(session.user, realnamePhoneVerificationEnabled)}
              />
            ) : null}
            {isBillingView && subscriptionModel.pass ? (
              <PassDeleteDialogController
                open={subscriptionModel.dialogs.deleteOpen}
                onOpenChange={(open) => { if (!open) subscriptionModel.dialogs.closeDelete(); }}
                passId={subscriptionModel.pass.pass_id}
                passName={subscriptionModel.pass.bundle_name}
                deletePass={plans.deletePass}
                listMyPasses={plans.listMyPasses}
                onSuccess={() => void subscriptionModel.dialogs.handleDeleteSuccess()}
                resolveError={(error) => resolveBillingErrorMessage(
                  error,
                  error instanceof Error ? error.message : t("销毁失败，请稍后重试。"),
                )}
              />
            ) : null}

            {!isBillingView && referralEnabled && referralRevealed && <ReferralSection />}

            {isBillingView && isGlobal && <SavedCardsSection />}
          </div>
        </section>
      </AccountPageGate>
      </main>
    );

    pageOverlays = (
      <AnimatePresence>
        {!isBillingView && showRealnameSection && showVerifyModal && (
          <VerifyIdentityModal
            key="verify"
            onClose={() => setShowVerifyModal(false)}
            onSuccess={handleVerifySuccess}
            verified={verified}
            phoneVerificationEnabled={phoneProofEnabled}
            realnameLevel={user?.realnameLevel}
            realnameSyncStatus={realnameSyncStatus}
            faceIdFlowEnabled={faceIdFlowEnabled}
            faceCaptureEnabled={faceIdBackendEnabled}
            facelessFlowEnabled={facelessFlowEnabled}
            phone={user?.phone}
          />
        )}
        {!isBillingView && showRealnameSection && phoneProofEnabled && (
          <ChangePhoneDialog
            key="change-phone"
            open={showChangePhoneModal}
            currentPhone={user?.phone}
            onOpenChange={setShowChangePhoneModal}
            onSendCode={handleSendPhoneChangeCode}
            onSubmit={handleSubmitPhoneChange}
            onSuccess={handlePhoneChangeSuccess}
          />
        )}
        {!isBillingView && showEmailBindSection && !user?.emailVerified && (
          <BindEmailDialog
            key="bind-email"
            open={showBindEmailModal}
            onOpenChange={setShowBindEmailModal}
            onSend={handleSendEmailBind}
          />
        )}
        {!isBillingView && <AccountDeleteDialog
            key="delete"
            open={showDeleteModal}
            onOpenChange={setShowDeleteModal}
            onConfirm={() => void handleDeleteAccount()}
            submitting={deleting}
        />}
      </AnimatePresence>
    );
  }

  return (
    <ProductPageShell className="agents-ui min-h-dvh" afterFooter={pageOverlays} footer={null}
      header={<ProductReturnHomeHeader showLanguageSwitcher={false} beforeUserMenu={
        <AppLink to={AGENTS_HOME_PATH} aria-label={t("返回智能体")}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full border border-black/10 bg-white px-3 py-2 text-sm font-medium text-black/70 hover:bg-black/5 hover:text-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 sm:h-9 sm:min-h-9 sm:px-4 sm:py-0">
          <ArrowLeft className="size-4 shrink-0" aria-hidden="true" /><span className="hidden sm:inline">{t("返回智能体")}</span>
        </AppLink>} />}>
      {pageContent}
      {/* 本地 mock 预览专用：交互状态切换器（生产/真实后端环境自动隐藏，不影响线上） */}
      <AccountPreviewStateSwitcher />
    </ProductPageShell>
  );
};

export const PlansBillingPage = () => <AccountPage view="billing" />;

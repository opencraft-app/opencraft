import { ChevronRight } from "lucide-react";
import { useT } from "@/i18n/t";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  AccountInfoRow,
  AccountSectionHeader,
  AccountStatusBadge,
  accountCardClass,
} from "./account-surface";

export interface AccountSecurityCardProps {
  email: string | undefined;
  emailVerified: boolean;
  phone: string | undefined;
  showEmailBindSection: boolean;
  showSafetyPhoneSection: boolean;
  showRealnameSection: boolean;
  verified: boolean;
  realnameStatusLabel: string;
  phoneProofEnabled: boolean;
  faceIdFlowEnabled: boolean;
  idCardVerified: boolean;
  realnameSyncNeedsRetry: boolean;
  realnameSyncRetrying: boolean;
  idCardSyncStatus: "pending" | "failed" | "succeeded" | undefined;
  emailBindSuccess: string | null;
  emailBindError: string | null;
  realnameSyncError: string | null;
  onBindEmail: () => void;
  onBindPhone: () => void;
  onChangePhone: () => void;
  onVerifyRealname: () => void;
  onRetryRealnameSync: () => void;
}

const actionButtonClass = "h-auto rounded-md px-2 py-1 text-[var(--lw-accent)]";

export function AccountSecurityCard({
  email,
  emailVerified,
  phone,
  showEmailBindSection,
  showSafetyPhoneSection,
  showRealnameSection,
  verified,
  realnameStatusLabel,
  phoneProofEnabled,
  faceIdFlowEnabled,
  idCardVerified,
  realnameSyncNeedsRetry,
  realnameSyncRetrying,
  idCardSyncStatus,
  emailBindSuccess,
  emailBindError,
  realnameSyncError,
  onBindEmail,
  onBindPhone,
  onChangePhone,
  onVerifyRealname,
  onRetryRealnameSync,
}: AccountSecurityCardProps) {
  const t = useT();
  const realnameActionLabel = realnameSyncNeedsRetry
    ? t("重新同步")
    : phoneProofEnabled && idCardVerified
      ? t("继续认证")
      : t("去认证");

  return (
    <section className={accountCardClass}>
      <AccountSectionHeader
        title={t("安全")}
      />
      <div className="divide-y divide-black/[0.06] px-5">
        {showEmailBindSection ? (
          <AccountInfoRow
            label={t("邮箱")}
            value={emailVerified ? (
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <span className="min-w-0 break-all">{email || t("已绑定")}</span>
                <AccountStatusBadge tone="success">{t("已验证")}</AccountStatusBadge>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={actionButtonClass}
                onClick={onBindEmail}
                aria-label={`${t("去绑定")} ${t("邮箱")}`}
              >
                {t("去绑定")}
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            )}
            description={(emailBindSuccess || emailBindError) ? (
              <div className="space-y-1">
                {emailBindSuccess ? <p role="status" className="text-[var(--color-success)]">{emailBindSuccess}</p> : null}
                {emailBindError ? <p role="alert" className="text-[var(--danger)]">{emailBindError}</p> : null}
              </div>
            ) : undefined}
          />
        ) : null}

        {showSafetyPhoneSection ? (
          <AccountInfoRow
            label={t("手机号")}
            value={(
              <div className="flex items-center gap-2">
                <span className={phone ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}>
                  {phone || t("未绑定")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={actionButtonClass}
                  onClick={phone ? onChangePhone : onBindPhone}
                  aria-label={phone ? `${t("修改")} ${t("手机号")}` : `${t("绑定")} ${t("手机号")}`}
                >
                  {phone ? t("修改") : t("绑定")}
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            )}
          />
        ) : null}

        {showRealnameSection ? (
          <AccountInfoRow
            label={t("实名认证")}
            value={verified ? (
              <div className="flex items-center gap-2">
                <AccountStatusBadge tone="success">{realnameStatusLabel}</AccountStatusBadge>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={actionButtonClass}
                  onClick={onVerifyRealname}
                  aria-label={t("修改实名认证")}
                >
                  {t("修改")}
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {(phoneProofEnabled || faceIdFlowEnabled) && (idCardVerified || realnameSyncError) ? (
                  <div className="flex max-w-[240px] flex-col items-end gap-1 text-right">
                    {realnameStatusLabel ? (
                      <AccountStatusBadge tone={idCardSyncStatus === "failed" ? "danger" : "warning"}>
                        {realnameStatusLabel}
                      </AccountStatusBadge>
                    ) : <AccountStatusBadge tone="neutral">{t("未认证")}</AccountStatusBadge>}
                    {realnameSyncError ? <span role="alert" className="text-xs text-[var(--danger)]">{realnameSyncError}</span> : null}
                  </div>
                ) : <AccountStatusBadge tone="neutral">{t("未认证")}</AccountStatusBadge>}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={actionButtonClass}
                  onClick={realnameSyncNeedsRetry ? onRetryRealnameSync : onVerifyRealname}
                  disabled={realnameSyncRetrying}
                  aria-label={realnameActionLabel}
                >
                  {realnameSyncRetrying ? <Spinner size="sm" aria-label={t("实名信息同步中")} /> : null}
                  {realnameActionLabel}
                  {!realnameSyncRetrying ? <ChevronRight className="size-4" aria-hidden="true" /> : null}
                </Button>
              </div>
            )}
          />
        ) : null}
      </div>
    </section>
  );
}

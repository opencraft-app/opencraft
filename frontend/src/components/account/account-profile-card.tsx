import { useRef, type ChangeEventHandler } from "react";
import { Camera, Check, Copy, Pencil } from "lucide-react";
import type { User } from "@/domain/types";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  AccountSectionHeader,
  AccountStatusBadge,
  accountCardClass,
} from "./account-surface";

export interface AccountProfileCardProps {
  user: User | null | undefined;
  displayAvatarSrc: string;
  hasPendingAvatarAudit: boolean;
  avatarAuditFailed: boolean;
  pendingName: string;
  hasPendingNameAudit: boolean;
  nameAuditFailed: boolean;
  copiedUserId: boolean;
  isEditingName: boolean;
  editName: string;
  saving: boolean;
  nameSaveError: string | null;
  avatarUploading: boolean;
  avatarUploadError: string | null;
  onAvatarUpload: ChangeEventHandler<HTMLInputElement>;
  onEditNameChange: (value: string) => void;
  onBeginNameEdit: () => void;
  onCancelNameEdit: () => void;
  onSaveName: () => void;
  onCopyUserId: () => void;
  onSignOut: () => void;
}

export function AccountProfileCard({
  user,
  displayAvatarSrc,
  hasPendingAvatarAudit,
  avatarAuditFailed,
  pendingName,
  hasPendingNameAudit,
  nameAuditFailed,
  copiedUserId,
  isEditingName,
  editName,
  saving,
  nameSaveError,
  avatarUploading,
  avatarUploadError,
  onAvatarUpload,
  onEditNameChange,
  onBeginNameEdit,
  onCancelNameEdit,
  onSaveName,
  onCopyUserId,
  onSignOut,
}: AccountProfileCardProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className={cn(accountCardClass, "overflow-hidden")}>
      <AccountSectionHeader
        title={t("用户")}
      />
      <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 items-center gap-4 md:gap-5">
          <div className="relative shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              aria-label={t("点击更换头像")}
              className="hidden"
              onChange={onAvatarUpload}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={avatarUploading}
              className="group relative size-14 rounded-full p-0 disabled:cursor-not-allowed"
              aria-label={t("点击更换头像")}
              title={avatarUploadError ?? (avatarUploading ? t("头像上传中...") : t("点击更换头像"))}
            >
              <img
                src={displayAvatarSrc}
                alt="avatar"
                className={cn(
                  "size-14 rounded-full border border-black/[0.08] bg-[var(--surface-muted)] object-cover",
                  hasPendingAvatarAudit && "scale-105 blur-sm",
                )}
              />
              {hasPendingAvatarAudit ? (
                <span className="absolute -bottom-1 -right-1">
                  <AccountStatusBadge tone="warning">{t("审核中")}</AccountStatusBadge>
                </span>
              ) : null}
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-100">
                {avatarUploading ? (
                  <Spinner size="md" className="text-white" aria-label={t("头像上传中...")} />
                ) : (
                  <Camera className="size-4 text-white" aria-hidden="true" />
                )}
              </span>
            </Button>
          </div>

          <div className="min-w-0">
            {isEditingName ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="account-profile-name">{t("昵称")}</label>
                <input
                  id="account-profile-name"
                  type="text"
                  value={editName}
                  onChange={(event) => onEditNameChange(event.target.value)}
                  className="lw-input w-full flex-1 md:w-auto"
                  maxLength={20}
                  aria-invalid={Boolean(nameSaveError)}
                  aria-describedby={nameSaveError ? "account-profile-name-error" : undefined}
                  autoFocus
                />
                <Button
                  type="button"
                  size="sm"
                  className="size-8 rounded-md p-0"
                  onClick={onSaveName}
                  disabled={saving || !editName.trim()}
                  aria-label={t("保存")}
                >
                  {saving ? (
                    <Spinner size="sm" aria-label={t("保存中...")} />
                  ) : (
                    <Check className="size-4" aria-hidden="true" />
                  )}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="rounded-md" onClick={onCancelNameEdit}>
                  {t("取消")}
                </Button>
                {nameSaveError ? (
                  <p id="account-profile-name-error" role="alert" className="w-full text-xs text-[var(--danger)]">
                    {nameSaveError}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className={cn("truncate text-xl font-medium text-[var(--text-primary)]", hasPendingNameAudit && "select-none blur-sm")}>
                    {hasPendingNameAudit ? pendingName : user?.name || t("未设置")}
                  </p>
                  {hasPendingNameAudit ? <AccountStatusBadge tone="warning">{t("审核中")}</AccountStatusBadge> : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-7 rounded-md p-0"
                    onClick={onBeginNameEdit}
                    aria-label={hasPendingNameAudit ? t("修改待审核昵称") : t("修改昵称")}
                    title={hasPendingNameAudit ? t("修改待审核昵称") : t("修改昵称")}
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                {user?.id ? (
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="max-w-[300px] truncate font-mono text-xs text-black/35" title={user.id}>
                      {`id: ${user.id}`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-6 rounded-md p-0"
                      onClick={onCopyUserId}
                      aria-label={copiedUserId ? t("已复制") : t("复制")}
                      title={copiedUserId ? t("已复制") : t("复制")}
                    >
                      {copiedUserId ? (
                        <Check className="size-3 text-[var(--color-success)]" aria-hidden="true" />
                      ) : (
                        <Copy className="size-3" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                ) : null}
                {hasPendingNameAudit ? (
                  <p className="text-pretty text-xs text-[var(--text-secondary)]">
                    {t("当前对外显示：")}<span className="text-[var(--text-primary)]">{user?.name || t("未设置")}</span>
                    {t("，审核通过后将自动生效。")}
                  </p>
                ) : null}
                {nameAuditFailed ? (
                  <p className="text-pretty text-xs text-[var(--danger)]">{t("上次昵称修改未通过审核，当前仍使用原昵称。")}</p>
                ) : null}
              </div>
            )}

            {avatarUploadError ? <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{avatarUploadError}</p> : null}
            {hasPendingAvatarAudit ? (
              <p className="mt-1 text-pretty text-xs text-[var(--text-secondary)]">{t("新头像已提交审核，审核通过后将对外生效。")}</p>
            ) : null}
            {avatarAuditFailed ? (
              <p className="mt-1 text-pretty text-xs text-[var(--danger)]">{t("上次头像修改未通过审核，当前仍使用原头像。")}</p>
            ) : null}
          </div>
        </div>

        <Button type="button" variant="outline" className="w-full rounded-md md:w-auto" onClick={onSignOut}>
          {t("退出登录")}
        </Button>
      </div>
    </section>
  );
}

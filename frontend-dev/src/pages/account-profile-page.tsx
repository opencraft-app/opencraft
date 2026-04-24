import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Camera, LoaderCircle, UserRound } from "lucide-react";
import { planCatalog } from "@/domain/plan-catalog";
import type { CurrentSubscription } from "@/domain/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GrammarPageIntro, GrammarSectionCard } from "@/components/site/homepage-grammar";
import { useRepositories } from "@/contexts/repository-context";
import { useSession } from "@/contexts/session-context";
import { compressAvatarFile } from "@/lib/avatar-image";
import { resolveConfiguredAuthApiBaseUrl, resolveAPIURL } from "@/repositories/http-repositories";
import { useAsyncResource } from "@/services/use-async-resource";

const avatarBaseURL = resolveConfiguredAuthApiBaseUrl();

const buildAvatarURL = (path?: string, version?: number) => {
  if (!path) {
    return null;
  }

  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    if (version) {
      url.searchParams.set("v", String(version));
    }
    return url.toString();
  }

  if (!avatarBaseURL) {
    return path ?? null;
  }

  const url = new URL(resolveAPIURL(avatarBaseURL, path));
  if (version) {
    url.searchParams.set("v", String(version));
  }
  return url.toString();
};

const initialsFor = (name?: string) => {
  const trimmed = name?.trim();
  if (!trimmed) {
    return "LC";
  }
  return trimmed.slice(0, 2).toUpperCase();
};

const subscriptionStatusLabel = (status: CurrentSubscription["status"]) => {
  switch (status) {
    case "pending_payment":
      return "待支付";
    case "cancelled":
      return "已取消";
    case "expired":
      return "已过期";
    case "active":
    default:
      return "生效中";
  }
};

const formatSubscriptionDateTime = (value?: string) => {
  if (!value) {
    return "未设置";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未设置";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export const AccountProfilePage = () => {
  const repositories = useRepositories();
  const { session, updateProfile, uploadAvatar } = useSession();
  const [name, setName] = useState(session.user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [localAvatarPreview, setLocalAvatarPreview] = useState<string | null>(null);
  const currentSubscription = useAsyncResource(() => repositories.plans.getCurrentSubscription(), [repositories.plans]);

  useEffect(() => {
    setName(session.user?.name ?? "");
  }, [session.user?.name]);

  useEffect(() => () => {
    if (localAvatarPreview) {
      URL.revokeObjectURL(localAvatarPreview);
    }
  }, [localAvatarPreview]);

  const avatarSrc = useMemo(() => {
    if (localAvatarPreview) {
      return localAvatarPreview;
    }
    return buildAvatarURL(session.user?.avatarUrl, avatarVersion);
  }, [avatarVersion, localAvatarPreview, session.user?.avatarUrl]);

  const saveProfile = async () => {
    setSavingProfile(true);
    setNotice(null);
    setError(null);
    try {
      await updateProfile({ name: name.trim() });
      setNotice("昵称已更新。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "昵称保存失败。");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setUploadingAvatar(true);
    setNotice(null);
    setError(null);
    try {
      const compressed = await compressAvatarFile(file, { maxBytes: 200 * 1024 });
      const previousPreview = localAvatarPreview;
      const nextPreview = URL.createObjectURL(compressed);
      setLocalAvatarPreview(nextPreview);
      await uploadAvatar(compressed);
      setLocalAvatarPreview((current) => {
        if (current === nextPreview) {
          URL.revokeObjectURL(current);
          return null;
        }
        return current;
      });
      if (previousPreview && previousPreview !== nextPreview) {
        URL.revokeObjectURL(previousPreview);
      }
      setAvatarVersion((current) => current + 1);
      setNotice("头像已更新。");
    } catch (uploadError) {
      setLocalAvatarPreview((current) => {
        if (current && current.startsWith("blob:")) {
          URL.revokeObjectURL(current);
        }
        return null;
      });
      setError(uploadError instanceof Error ? uploadError.message : "头像上传失败。");
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <div className="space-y-5">
      <GrammarPageIntro
        eyebrow={<Badge variant="neutral">Account</Badge>}
        title="账号设置"
        description="设置你的昵称和头像。无论是手机号还是 QQ 登录，这一页都应该像账户简介，而不是一张孤立的资料卡。"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <GrammarSectionCard
          kicker="Identity portrait"
          title="头像"
          description="支持 JPG、PNG、WEBP。前端会先尝试压缩到 200KB 以内。"
        >
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-5 py-6 text-center">
              <div className="flex size-28 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-base)]">
                {avatarSrc ? (
                  <img src={avatarSrc} alt={`${session.user?.name ?? "用户"} 的头像`} className="size-full object-cover" />
                ) : (
                  <span className="font-display text-3xl text-[var(--text-secondary)]">{initialsFor(session.user?.name)}</span>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm text-[var(--text-secondary)]">当前头像会用于你的账户资料展示。</p>
                <p className="text-xs text-[var(--text-secondary)]">如果你主动上传头像，后续不会再被第三方头像自动覆盖。</p>
              </div>
              <Button asChild variant="secondary" disabled={uploadingAvatar}>
                <label htmlFor="profile-avatar-upload" className="cursor-pointer">
                  {uploadingAvatar ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                  {uploadingAvatar ? "上传中..." : "上传头像"}
                </label>
              </Button>
              <input
                id="profile-avatar-upload"
                name="avatar"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(event) => void handleAvatarChange(event)}
              />
            </div>
        </GrammarSectionCard>

        <GrammarSectionCard
          kicker="Current plan"
          title="当前套餐"
          description="这里显示当前生效中的订阅状态和时间范围。"
        >
            {currentSubscription.loading ? (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-4 text-sm text-[var(--text-secondary)]">
                正在读取当前套餐...
              </div>
            ) : currentSubscription.error ? (
              <div className="rounded-2xl border border-[var(--status-danger)]/20 bg-[var(--surface-muted)] px-4 py-4 text-sm text-[var(--status-danger)]">
                {currentSubscription.error}
              </div>
            ) : currentSubscription.data ? (
              <div className="space-y-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-5 py-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-lg font-semibold text-[var(--text-primary)]">
                      {planCatalog.find((item) => item.tier === currentSubscription.data?.tier)?.name ?? currentSubscription.data.code}
                    </p>
                    <p className="text-sm text-[var(--text-secondary)]">{subscriptionStatusLabel(currentSubscription.data.status)}</p>
                  </div>
                  <Badge variant="neutral">{subscriptionStatusLabel(currentSubscription.data.status)}</Badge>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-secondary)]">生效时间</p>
                    <p className="text-sm text-[var(--text-primary)]">
                      {formatSubscriptionDateTime(currentSubscription.data.currentPeriodStart ?? currentSubscription.data.createdAt)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--text-secondary)]">到期时间</p>
                    <p className="text-sm text-[var(--text-primary)]">
                      {currentSubscription.data.currentPeriodEnd ? formatSubscriptionDateTime(currentSubscription.data.currentPeriodEnd) : "长期有效"}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-4 text-sm text-[var(--text-secondary)]">
                当前还没有生效中的套餐。
              </div>
            )}
        </GrammarSectionCard>

        <GrammarSectionCard
          kicker="Base profile"
          title="基础资料"
          description="昵称会显示在工作台和账号入口里。"
          tone="muted"
        >
            <div className="space-y-2">
              <Label htmlFor="profile-name">昵称</Label>
              <Input
                id="profile-name"
                aria-label="昵称"
                value={name}
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
                placeholder="给自己起一个容易识别的名字"
              />
            </div>

            <div className="space-y-2">
              <Label>登录账号</Label>
              <div className="flex min-h-11 items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-secondary)]">
                {session.user?.email ?? "QQ 授权账号"}
              </div>
            </div>

            <div className="space-y-2">
              <Label>用户 ID</Label>
              <div className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-secondary)]">
                <UserRound className="size-4" />
                <span className="truncate">{session.user?.id ?? "unknown"}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void saveProfile()} disabled={savingProfile || !name.trim()}>
                {savingProfile ? "保存中..." : "保存资料"}
              </Button>
              {notice ? <p className="text-sm text-[var(--text-secondary)]">{notice}</p> : null}
              {error ? <p className="text-sm text-[var(--status-danger)]">{error}</p> : null}
            </div>
        </GrammarSectionCard>
      </div>
    </div>
  );
};

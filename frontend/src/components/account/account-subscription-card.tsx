import { ChevronRight, CreditCard, Trash2, Zap } from "lucide-react";
import type { Pass } from "@/domain/types";
import type { CreditSourceView } from "@/domain/credit-pack";
import { formatCreditDate } from "@/lib/use-credit-sources";
import type { PassStatus } from "@/lib/billing-flow";
import type {
  AccountSubscriptionCredits,
  AccountSubscriptionPassState,
  AccountSubscriptionValidity,
} from "@/lib/use-account-subscription-model";
import { AppLink } from "@/lib/app-navigation";
import { useT } from "@/i18n/t";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { RenewComingSoonButton } from "@/components/ui/renew-coming-soon-button";
import {
  AccountSectionHeader,
  AccountStatusBadge,
  accountCardClass,
} from "./account-surface";
import { cn } from "@/lib/utils";

export interface AccountSubscriptionCardProps {
  state: "ready" | "loading" | "error" | "none" | "idle";
  pass: Pass | null;
  displayName: string;
  validity: AccountSubscriptionValidity | null;
  credits: AccountSubscriptionCredits | null;
  creditPacks?: {
    sources: CreditSourceView[];
    sourceCount: number;
    purchaseHref: string;
    failed: boolean;
    onRetry: () => void;
  };
  passStatus: PassStatus | null;
  passState: AccountSubscriptionPassState;
  actions: {
    canRenew: boolean;
    renewalAvailable: boolean;
    canDelete: boolean;
    upgradeHref: string | null;
    onRenew: () => void;
    onDelete: () => void;
    onRetryUpgrade: () => void;
  };
  error: {
    summary: boolean;
    upgrade: boolean;
  };
  subscribeHref: string;
}

const statusTone = (passStatus: PassStatus | null, validity: AccountSubscriptionValidity) => {
  if (passStatus === "isolated") return "warning" as const;
  if (passStatus === "expired" || validity.expired) return "danger" as const;
  if (validity.remainDays <= 2) return "warning" as const;
  return "success" as const;
};

const creditToneClass = (usedPercent: number) => usedPercent > 95
  ? "text-[#991B1B]"
  : usedPercent >= 80
    ? "text-[#CF3D4C]"
    : usedPercent >= 50
      ? "text-[#C67B1E]"
      : "text-[var(--lw-accent)]";

const creditFillClass = (usedPercent: number) => usedPercent > 95
  ? "bg-[#991B1B]"
  : usedPercent >= 80
    ? "bg-[#CF3D4C]"
    : usedPercent >= 50
      ? "bg-[#C67B1E]"
      : "bg-[var(--lw-accent)]";

export function AccountSubscriptionCard({
  state,
  displayName,
  validity,
  credits,
  creditPacks,
  passStatus,
  passState,
  actions,
  error,
  subscribeHref,
}: AccountSubscriptionCardProps) {
  const t = useT();
  const creditsExhausted = Boolean(credits && credits.total > 0 && credits.used >= credits.total);
  const showCreditPrompt = Boolean(credits && (creditsExhausted || credits.usedPercent > 95));

  if (state === "loading") {
    return (
      <Card className={cn(accountCardClass, "overflow-hidden")}>
        <AccountSectionHeader title={t("订阅套餐")} />
        <CardContent className="flex min-h-36 flex-col items-center justify-center gap-3 p-8 text-center">
          <Spinner size="md" aria-label={t("正在加载")} />
          <p className="text-pretty text-sm text-[var(--text-secondary)]">{t("正在加载")}</p>
        </CardContent>
      </Card>
    );
  }

  if (state === "error") {
    return (
      <Card className={cn(accountCardClass, "overflow-hidden")}>
        <AccountSectionHeader title={t("订阅套餐")} />
        <CardContent className="flex min-h-36 items-center justify-center p-8 text-center">
          <p role="alert" className="text-pretty text-sm text-[var(--danger)]">{t("套餐列表加载失败")}</p>
        </CardContent>
      </Card>
    );
  }

  if (state === "none" || state === "idle") {
    return (
      <Card className={cn(accountCardClass, "overflow-hidden")}>
        <AccountSectionHeader title={t("订阅套餐")} />
        <CardContent className="flex flex-col items-center gap-5 p-8 text-center md:p-10">
          <CreditCard className="size-7 text-[var(--text-primary)]" aria-hidden="true" />
          <div>
            <p className="font-semibold text-[var(--text-primary)]">{t("还没有订阅套餐")}</p>
            <p className="mt-1.5 text-pretty text-sm text-[var(--text-secondary)]">{t("即刻创建你的专属云端 Hermes")}</p>
          </div>
          <Button asChild>
            <AppLink to={subscribeHref}>
              <Zap className="size-4" aria-hidden="true" />
              {t("立即创建")}
            </AppLink>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(accountCardClass, "overflow-hidden")}>
      <AccountSectionHeader
        title={t("订阅套餐")}
        className="flex-row items-center justify-between gap-3"
      />
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{displayName}</p>
            <p className="mt-1 text-pretty text-xs text-[var(--text-secondary)]">
              {passState === "current" ? t("当前生效") : t("套餐信息将在升级完成后更新，到期时间不变。")}
            </p>
          </div>
          <AccountStatusBadge tone={passState === "modify-failed" ? "danger" : passState === "modifying" ? "warning" : "neutral"}>
            <span role={passState === "current" ? undefined : "status"}>
              {passState === "modify-failed" ? t("套餐升级失败") : passState === "modifying" ? t("套餐升级中") : t("当前套餐")}
            </span>
          </AccountStatusBadge>
        </div>

        {error.upgrade ? (
          <p role="alert" className="text-pretty text-sm text-[var(--danger)]">
            {t("升级资格加载失败，请重试")}{" "}
            <button type="button" className="font-semibold underline underline-offset-2" onClick={actions.onRetryUpgrade}>{t("重试")}</button>
          </p>
        ) : null}

        {validity ? (
          <div className="border-t border-black/[0.06] pt-5">
            <p className="text-sm font-semibold text-[var(--text-primary)]">{t("订阅有效期")}</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="tabular-nums text-sm text-[var(--text-secondary)]">{validity.startDate} — {validity.endDate}</p>
              <AccountStatusBadge tone={statusTone(passStatus, validity)}>
                {validity.expired ? t("已过期") : t("剩余 {{days}} 天", { days: validity.remainDays })}
              </AccountStatusBadge>
            </div>
          </div>
        ) : null}

        {credits ? (
          <div className="border-t border-black/[0.06] pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[var(--text-primary)]">{t("已使用积分")}</p>
              {creditPacks ? <AppLink to={creditPacks.purchaseHref} className="text-xs font-semibold underline underline-offset-2">{t("购买积分包")}</AppLink> : null}
            </div>
            <div className={cn("mt-2 flex items-center justify-between gap-3", creditToneClass(credits.usedPercent))}>
              <p className="tabular-nums text-sm font-semibold">
                {credits.used.toLocaleString()}
                <span className="font-normal text-[var(--text-secondary)]"> / {credits.total.toLocaleString()}</span>
              </p>
              <span className="tabular-nums text-xs font-semibold">{credits.usedPercent}%</span>
            </div>
            <Progress
              value={credits.usedPercent}
              aria-label={t("已使用积分")}
              className="mt-2"
              indicatorClassName={creditFillClass(credits.usedPercent)}
            />
            {creditPacks && creditPacks.sources.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{t("额度明细")}</p>
                  <span className="text-xs text-[var(--text-secondary)]">{t("共 {{count}} 个来源", { count: creditPacks.sourceCount })}</span>
                </div>
                <ul className="space-y-2">
                  {creditPacks.sources.map((source) => (
                    <li key={source.source_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-black/[0.02] px-3 py-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm text-[var(--text-primary)]">{source.display_name}</p>
                        {source.next_expire_at ? <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                          {source.source_type === "plan"
                            ? t("下次刷新：{{date}}", { date: formatCreditDate(source.next_expire_at) })
                            : t("到期时间：{{date}}", { date: formatCreditDate(source.next_expire_at) })}
                        </p> : null}
                      </div>
                      <p className="tabular-nums text-sm font-semibold">
                        {source.credit_available.toLocaleString()} <span className="font-normal text-[var(--text-secondary)]">/ {source.credit_total.toLocaleString()}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {creditPacks?.failed ? <button type="button" onClick={creditPacks.onRetry} className="mt-2 text-xs font-semibold text-[var(--danger)] underline underline-offset-2">{t("积分包额度加载失败，点击重试")}</button> : null}
            {showCreditPrompt ? (
              <p className="mt-3 text-pretty text-xs leading-relaxed text-red-800">
                {creditsExhausted
                  ? t("模型积分已用尽，如未配置自有模型，智能体将无法继续响应。")
                  : t("模型积分即将用尽，为避免智能体停止响应，请尽快")}
                <AppLink to="/agents/models" className="ml-1 inline-flex items-center gap-0.5 font-semibold underline underline-offset-2">
                  {creditsExhausted ? t("立即配置模型") : t("配置自有模型")}
                  <ChevronRight className="size-3" aria-hidden="true" />
                </AppLink>
              </p>
            ) : null}
          </div>
        ) : null}

        {(actions.canRenew || actions.upgradeHref || actions.canDelete || passStatus === "isolated" || passStatus === "expired") ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-5">
            {actions.canRenew ? (
              actions.renewalAvailable ? (
                <Button type="button" size="sm" onClick={actions.onRenew}>
                  <CreditCard className="size-4" aria-hidden="true" />
                  {t("立即续费")}
                </Button>
              ) : (
                <RenewComingSoonButton
                  label={t("立即续费")}
                  tooltip={t("敬请期待")}
                  icon={<CreditCard className="size-4" aria-hidden="true" />}
                  className="h-8 px-3 text-xs"
                />
              )
            ) : null}
            {actions.upgradeHref ? (
              <Button asChild type="button" variant="outline" size="sm">
                <AppLink to={actions.upgradeHref}>{t("升级套餐")}</AppLink>
              </Button>
            ) : null}
            {actions.canDelete ? (
              <Button type="button" variant="outline" size="sm" className="text-[var(--danger)]" onClick={actions.onDelete}>
                <Trash2 className="size-4" aria-hidden="true" />
                {t("销毁套餐")}
              </Button>
            ) : null}
            {passStatus === "isolated" ? (
              <p className="basis-full text-pretty text-xs text-amber-700">
                {actions.renewalAvailable
                  ? t("套餐已进入隔离期，可选择续费恢复使用或销毁当前套餐。销毁后可重新购买。")
                  : t("续费功能敬请期待。你仍可销毁当前套餐后重新购买。")}
              </p>
            ) : null}
            {passStatus === "expired" ? (
              <p className="basis-full text-pretty text-xs text-[var(--danger)]">
                {actions.renewalAvailable
                  ? t("套餐已过期，请及时续费以免进入隔离期。")
                  : t("续费功能敬请期待。套餐已过期，暂时无法发起续费。")}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

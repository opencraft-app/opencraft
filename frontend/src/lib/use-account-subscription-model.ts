import { useCallback, useEffect, useMemo, useState } from "react";
import type { CurrentSubscription, Pass } from "@/domain/types";
import {
  accountPassCanRenew,
  accountPassDisplayName,
} from "@/lib/account-pass-summary";
import { canDeletePass, getPassStatus, type PassStatus } from "@/lib/billing-flow";
import { useAccountPassSummary } from "@/lib/use-account-pass-summary";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";
import { isRenewalAvailableForRegion } from "@/lib/pass-renewal";
import { useT } from "@/i18n/t";
import { installCreditPackVisibilityHelper, useCreditPackVisibility } from "@/lib/credit-pack-visibility";
import { useCreditSources } from "@/lib/use-credit-sources";

export interface AccountSubscriptionValidity {
  startDate: string;
  endDate: string;
  remainDays: number;
  expired: boolean;
}

export interface AccountSubscriptionCredits {
  total: number;
  used: number;
  usedPercent: number;
}

export type AccountSubscriptionPassState = "current" | "modifying" | "modify-failed";

export interface UseAccountSubscriptionModelOptions {
  userId?: string;
  activePass: Pass | null;
  modifyingPass: Pass | null;
  subscription: CurrentSubscription | null | undefined;
  planName: string;
  trialDays: number;
  paidBillingActive: boolean;
  global: boolean;
  passUpgradeFailed?: boolean;
  subscribeHref: string;
  listMyPasses: () => Promise<Pass[]>;
  refreshPasses: () => Promise<unknown> | unknown;
}

const formatValidity = (startValue: string | Date, endValue: string | Date, now: Date): AccountSubscriptionValidity => {
  const start = new Date(startValue);
  const end = new Date(endValue);
  const remainDays = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  return {
    startDate: start.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
    endDate: end.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
    remainDays,
    expired: remainDays <= 0,
  };
};

type AccountSubscriptionSummaryState = "ready" | "loading" | "error" | "none" | "idle";

export const resolveAccountSubscriptionState = (
  summaryState: AccountSubscriptionSummaryState,
  pass: Pass | null,
  subscription: CurrentSubscription | null | undefined,
): AccountSubscriptionSummaryState => {
  if (pass) return "ready";
  if (summaryState === "loading" || summaryState === "error") return summaryState;
  if (subscription) return "ready";
  return summaryState;
};

export function useAccountSubscriptionModel({
  userId,
  activePass,
  modifyingPass,
  subscription,
  planName,
  trialDays,
  paidBillingActive,
  global,
  passUpgradeFailed = false,
  subscribeHref,
  listMyPasses,
  refreshPasses,
}: UseAccountSubscriptionModelOptions) {
  const t = useT();
  const summary = useAccountPassSummary({
    userId,
    activePass,
    modifyingPass,
    paidBillingActive,
    global,
    listMyPasses,
  });
  const [renewOpen, setRenewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const pass = summary.pass;
  const planCredit = useMemo(() => pass ? {
    displayName: pass.bundle_name ?? t("套餐积分"),
    creditTotal: pass.credit_total,
    creditAvailable: pass.credit_available,
  } : null, [pass, t]);
  const freeCredit = useMemo(() => {
    const creditTotal = Math.max(0, pass?.free_credit_total ?? 0);
    if (creditTotal <= 0) return null;
    return {
      displayName: t("额外积分"),
      creditTotal,
      creditAvailable: Math.min(creditTotal, Math.max(0, pass?.free_credit_available ?? 0)),
    };
  }, [pass, t]);
  const creditSources = useCreditSources(planCredit, freeCredit);
  const creditPackVisible = useCreditPackVisibility();
  useEffect(() => installCreditPackVisibilityHelper(), []);
  const totalCredits = creditPackVisible ? creditSources.summary.total : (summary.credits?.total ?? 0) + (freeCredit?.creditTotal ?? 0);
  const usedCredits = creditPackVisible
    ? Math.max(0, totalCredits - creditSources.summary.available)
    : (summary.credits?.used ?? 0) + Math.max(0, (freeCredit?.creditTotal ?? 0) - (freeCredit?.creditAvailable ?? 0));
  const passStatus: PassStatus | null = pass ? getPassStatus(pass) : null;
  const isModifying = pass?.status === "modifying";
  const renewalAvailable = isRenewalAvailableForRegion(global, paidBillingActive);
  const upgrade = usePassUpgrade({ userId, passId: pass?.pass_id, currentPass: pass, enabled: paidBillingActive });

  const validity = useMemo<AccountSubscriptionValidity | null>(() => {
    const now = new Date();
    if (pass) return formatValidity(pass.created_time, pass.expired_time, now);
    if (subscription?.currentPeriodStart && subscription.currentPeriodEnd) {
      return formatValidity(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
    }
    if (!subscription) return null;
    return formatValidity(now, new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000), now);
  }, [pass, subscription, trialDays]);

  const handleRenewSuccess = useCallback(async () => {
    setRenewOpen(false);
    await refreshPasses();
    summary.clearFallback();
  }, [refreshPasses, summary.clearFallback]);

  const handleDeleteSuccess = useCallback(async () => {
    setDeleteOpen(false);
    await refreshPasses();
    summary.clearFallback();
  }, [refreshPasses, summary.clearFallback]);

  return {
    state: resolveAccountSubscriptionState(summary.state, pass, subscription),
    pass,
    displayName: accountPassDisplayName(pass, subscription?.code, planName),
    validity,
    credits: summary.credits || totalCredits > 0
      ? { total: totalCredits, used: usedCredits, usedPercent: totalCredits > 0 ? Math.min(100, Math.round(usedCredits / totalCredits * 100)) : 0 }
      : null,
    creditPacks: creditPackVisible ? {
      sources: creditSources.sources,
      sourceCount: creditSources.summary.sourceCount,
      purchaseHref: `${subscribeHref}?section=credits`,
      failed: creditSources.failed,
      onRetry: creditSources.reload,
    } : undefined,
    passStatus,
    passState: isModifying ? (passUpgradeFailed ? "modify-failed" as const : "modifying" as const) : "current" as const,
    actions: {
      canRenew: accountPassCanRenew(pass, global, paidBillingActive),
      renewalAvailable,
      canDelete: !isModifying && paidBillingActive && pass != null && canDeletePass(pass),
      upgradeHref: upgrade.pass && upgrade.options.length > 0
        ? `${subscribeHref}/?upgrade_pass_id=${encodeURIComponent(upgrade.pass.pass_id)}`
        : null,
      onRenew: () => setRenewOpen(true),
      onDelete: () => setDeleteOpen(true),
      onRetryUpgrade: upgrade.retry,
      onRetrySummary: summary.retry,
    },
    dialogs: {
      renewOpen,
      deleteOpen,
      closeRenew: () => setRenewOpen(false),
      closeDelete: () => setDeleteOpen(false),
      handleRenewSuccess,
      handleDeleteSuccess,
    },
    error: {
      summary: summary.state === "error",
      upgrade: upgrade.error,
    },
  };
}

export type AccountSubscriptionModel = ReturnType<typeof useAccountSubscriptionModel>;

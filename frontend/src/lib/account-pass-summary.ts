import type { Pass } from "@/domain/types";
import { canRenewPass } from "@/lib/billing-flow";

export function ownedAccountPass(userId: string | undefined, pass: Pass | null | undefined): Pass | null {
  return userId && pass?.user_id === userId && !pass.deleted_time && pass.status !== "deleted" ? pass : null;
}

export function accountPassCredits(pass: Pass | null) {
  if (!pass) return null;
  const used = Math.max(0, pass.credit_total - pass.credit_available);
  return { total: pass.credit_total, available: pass.credit_available, used, usedPercent: pass.credit_total > 0 ? Math.min(100, Math.round(used / pass.credit_total * 100)) : 0 };
}

export function accountPassDisplayName(pass: Pass | null, subscriptionCode: string | null | undefined, planName: string) {
  return pass?.bundle_name ?? subscriptionCode ?? planName;
}

export function accountPassCanRenew(pass: Pass | null, global: boolean, paidBillingActive: boolean) {
  return pass != null && pass.status !== "modifying" && (global || paidBillingActive) && canRenewPass(pass);
}

import type { Pass } from "@/domain/types";
import { summarizePassCredits } from "@/lib/pass-credits";
import { canRenewPass } from "@/lib/billing-flow";

export function ownedAccountPass(userId: string | undefined, pass: Pass | null | undefined): Pass | null {
  return userId && pass?.user_id === userId && !pass.deleted_time && pass.status !== "deleted" ? pass : null;
}

export function accountPassCredits(pass: Pass | null) {
  if (!pass) return null;
  return summarizePassCredits(pass);
}

export function accountPassDisplayName(pass: Pass | null, subscriptionCode: string | null | undefined, planName: string) {
  return pass?.bundle_name ?? subscriptionCode ?? planName;
}

export function accountPassCanRenew(pass: Pass | null, global: boolean, paidBillingActive: boolean) {
  return pass != null && pass.status !== "modifying" && (global || paidBillingActive) && canRenewPass(pass);
}

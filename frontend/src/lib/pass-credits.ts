import type { Pass } from "@/domain/types";

/** Pass 套餐与赠送额度分别计量；各展示入口统一合计，不再只读取套餐余额。 */
export function summarizePassCredits(pass: Pass) {
  const freeTotal = Math.max(0, pass.free_credit_total ?? 0);
  const freeAvailable = Math.min(freeTotal, Math.max(0, pass.free_credit_available ?? 0));
  const total = pass.credit_total + freeTotal;
  const available = pass.credit_available + freeAvailable;
  const used = Math.max(0, total - available);
  return { total, available, used, usedPercent: total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0 };
}

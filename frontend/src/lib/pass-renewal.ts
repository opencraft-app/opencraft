import type { BundleTimeUnit, Pass } from "@/domain/types";
import { getPassStatus, type PassStatus } from "@/lib/billing-flow";

export type RenewalPeriodOption = {
  key: "monthly" | "quarterly";
  label: string;
  description: string;
  period: number;
  time_unit: BundleTimeUnit;
};

export const RENEWAL_PERIOD_OPTIONS: readonly RenewalPeriodOption[] = [
  { key: "monthly", label: "月付", description: "1个月", period: 1, time_unit: "m" },
  { key: "quarterly", label: "季付", description: "3个月", period: 3, time_unit: "m" },
] as const;

export const getPassStatusLabel = (status: PassStatus): string => {
  switch (status) {
    case "active":
      return "生效中";
    case "expired":
      return "已过期";
    case "isolated":
      return "隔离期";
    case "deleted":
      return "已销毁";
    default:
      return "未知";
  }
};

export const formatPassDate = (value?: string | null): string => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

export const estimateRenewalExpiry = (
  pass: Pass,
  period: number,
  timeUnit: BundleTimeUnit,
  now: number = Date.now(),
): Date => {
  const expiredAt = new Date(pass.expired_time).getTime();
  const base = Number.isFinite(expiredAt) && expiredAt > now ? expiredAt : now;
  const next = new Date(base);

  switch (timeUnit) {
    case "d":
      next.setDate(next.getDate() + period);
      return next;
    case "m":
      next.setMonth(next.getMonth() + period);
      return next;
    case "y":
      next.setFullYear(next.getFullYear() + period);
      return next;
    default:
      return next;
  }
};

export type PassExpiryReminder = {
  label: string;
  tooltip: string;
  level: "warning" | "urgent";
  remainingMs: number;
};

export const getPassExpiryReminder = (
  pass: Pass | null | undefined,
  now: number = Date.now(),
): PassExpiryReminder | null => {
  if (!pass || getPassStatus(pass, now) !== "active") return null;

  const expiredAt = new Date(pass.expired_time).getTime();
  if (!Number.isFinite(expiredAt)) return null;

  const remainingMs = expiredAt - now;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (remainingMs <= 0 || remainingMs > sevenDaysMs) return null;

  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneHourMs = 60 * 60 * 1000;
  if (remainingMs < oneDayMs) {
    const hours = Math.ceil(remainingMs / oneHourMs);
    const hourLabel = hours < 1 ? "不足 1 小时" : `${hours} 小时`;
    return {
      label: "即将到期",
      tooltip: `剩余 ${hourLabel}到期`,
      level: "urgent",
      remainingMs,
    };
  }

  const days = Math.ceil(remainingMs / oneDayMs);
  return {
    label: days <= 2 ? "即将到期" : "临近到期",
    tooltip: `剩余 ${days} 天到期`,
    level: days <= 2 ? "urgent" : "warning",
    remainingMs,
  };
};

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatPercentChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function quotaColor(used: number, total: number): string {
  const pct = total > 0 ? (used / total) * 100 : 0;
  if (pct >= 95) return "text-red-500";
  if (pct >= 80) return "text-yellow-500";
  return "text-green-500";
}

export function quotaProgressColor(used: number, total: number): string {
  const pct = total > 0 ? (used / total) * 100 : 0;
  if (pct >= 95) return "bg-red-500";
  if (pct >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

export function formatPeriod(value: number, unit: 'days' | 'months'): string {
  if (unit === 'days') return `${value} 天`;
  if (value % 12 === 0) return `${value / 12} 年`;
  return `${value} 个月`;
}

export function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "exhausted": return "destructive";
    case "suspended":
    case "disabled":
    case "deleted":
    case "expired": return "secondary";
    default: return "outline";
  }
}

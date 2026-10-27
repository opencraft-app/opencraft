import type { TokenUsageAggregate, TokenUsageSnapshot } from "@opencraft/appserver-protocol/token-usage";

export interface DashboardMetrics {
  settled: string;
  total: string;
  peak: string;
  peakDay: string | null;
  settledTurns: number | null;
  longestStreak: number;
  currentStreak: number;
}

export interface ActivityCell {
  date: string;
  tokens: string;
  turns: number;
  state: "measured" | "zero" | "outside";
  level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityGrid {
  weeks: number;
  columns: ActivityCell[][];
  monthLabels: { index: number; label: string }[];
  maxTokens: string;
}

export interface ActivityBar {
  key: string;
  label: string;
  tokens: string;
  turns: number;
}

export function compactTokens(value: string, locale = "zh-CN"): string {
  try {
    const n = BigInt(value);
    const sign = n < 0n ? "-" : "";
    const abs = n < 0n ? -n : n;

    if (abs < 1000n) {
      return sign + new Intl.NumberFormat(locale).format(abs);
    }
    if (abs >= 1_000_000_000n) {
      const num = Number(abs / 100_000_000n) / 10;
      return sign + new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(num) + "B";
    }
    if (abs >= 1_000_000n) {
      const num = Number(abs / 100_000n) / 10;
      return sign + new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(num) + "M";
    }
    const num = Number(abs / 100n) / 10;
    return sign + new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(num) + "K";
  } catch {
    return value;
  }
}

function toEpochDay(d: string): number {
  return Math.floor(Date.parse(d + "T00:00:00Z") / 86400000);
}

export function dashboardMetrics(
  snapshot: Pick<TokenUsageSnapshot, "summary" | "daily">,
  todayKey?: string,
): DashboardMetrics {
  const settled = snapshot.summary.categories?.settled ?? "0";
  const total = snapshot.summary.tokens ?? "0";
  let max = 0n;
  let peakDay: string | null = null;

  for (const d of snapshot.daily) {
    try {
      const t = BigInt(d.tokens);
      if (t > max) {
        max = t;
        peakDay = d.key;
      }
    } catch {}
  }
  const peak = max.toString();
  if (max === 0n) peakDay = null;

  const settledTurns = snapshot.summary.settledTurns ?? (snapshot.summary.turns === 0 ? 0 : null);

  // Active days: turns > 0 or tokens > 0
  const activeDaySet = new Set<number>();
  for (const d of snapshot.daily) {
    try {
      if (d.turns > 0 || BigInt(d.tokens) > 0n) {
        activeDaySet.add(toEpochDay(d.key));
      }
    } catch {}
  }

  const sortedDays = [...activeDaySet].sort((a, b) => a - b);
  let longestStreak = 0;
  let currentStreak = 0;

  if (sortedDays.length > 0) {
    let cur = 1;
    longestStreak = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      if (sortedDays[i] === sortedDays[i - 1]! + 1) {
        cur++;
      } else {
        cur = 1;
      }
      if (cur > longestStreak) longestStreak = cur;
    }

    const todayIdx = todayKey ? toEpochDay(todayKey) : toEpochDay(new Date().toISOString().slice(0, 10));
    const lastActive = sortedDays[sortedDays.length - 1]!;
    if (todayIdx - lastActive <= 1) {
      let streak = 1;
      for (let i = sortedDays.length - 1; i > 0; i--) {
        if (sortedDays[i] === sortedDays[i - 1]! + 1) streak++;
        else break;
      }
      currentStreak = streak;
    }
  }

  return {
    settled,
    total,
    peak,
    peakDay,
    settledTurns,
    longestStreak,
    currentStreak,
  };
}

function startOfWeek(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(d.getTime() - day * 86400000);
}

function endOfWeek(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() + (6 - day) * 86400000);
}

export function buildActivityGrid(
  daily: readonly TokenUsageAggregate[],
  from: string,
  through: string,
  locale = "zh-CN",
): ActivityGrid {
  const sow = startOfWeek(from);
  const eow = endOfWeek(through);
  const totalDays = Math.round((eow.getTime() - sow.getTime()) / 86400000) + 1;
  const rawWeeks = Math.ceil(totalDays / 7);
  const weeks = Math.min(26, Math.max(4, rawWeeks));

  let startWeekDate: Date;
  if (rawWeeks > 26) {
    startWeekDate = new Date(eow.getTime() - (26 * 7 - 1) * 86400000);
  } else {
    startWeekDate = sow;
  }

  const map = new Map<string, TokenUsageAggregate>();
  for (const d of daily) map.set(d.key, d);

  let maxTokens = 0n;
  const gridCells: { date: string; tokens: string; turns: number; state: "measured" | "zero" | "outside" }[][] = [];

  for (let w = 0; w < weeks; w++) {
    const col: { date: string; tokens: string; turns: number; state: "measured" | "zero" | "outside" }[] = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(startWeekDate.getTime() + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
      if (cellDate < from || cellDate > through) {
        col.push({ date: cellDate, tokens: "0", turns: 0, state: "outside" });
      } else {
        const item = map.get(cellDate);
        const tokens = item?.tokens ?? "0";
        const turns = item?.turns ?? 0;
        try {
          const val = BigInt(tokens);
          if (val > maxTokens) maxTokens = val;
        } catch {}
        const state = (turns > 0 || tokens !== "0") ? "measured" : "zero";
        col.push({ date: cellDate, tokens, turns, state });
      }
    }
    gridCells.push(col);
  }

  const columns: ActivityCell[][] = gridCells.map(col =>
    col.map(cell => {
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (cell.state !== "outside" && cell.tokens !== "0" && maxTokens > 0n) {
        try {
          const val = BigInt(cell.tokens);
          const scaled = Number(val * 4n / maxTokens);
          level = Math.min(4, Math.max(1, (1 + scaled) as any)) as 0 | 1 | 2 | 3 | 4;
        } catch {}
      }
      return { ...cell, level };
    })
  );

  const monthFmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const monthLabels: { index: number; label: string }[] = [];
  let prevMonth = "";

  for (let w = 0; w < weeks; w++) {
    const monday = new Date(startWeekDate.getTime() + w * 7 * 86400000);
    const mStr = monday.toISOString().slice(0, 7);
    if (w === 0 || mStr !== prevMonth) {
      monthLabels.push({ index: w, label: monthFmt.format(monday) });
      prevMonth = mStr;
    }
  }

  return {
    weeks,
    columns,
    monthLabels,
    maxTokens: maxTokens.toString(),
  };
}

export function buildActivityBars(
  daily: readonly TokenUsageAggregate[],
  from: string,
  through: string,
  mode: "weekly" | "cumulative",
  locale = "zh-CN",
): ActivityBar[] {
  const sow = startOfWeek(from);
  const eow = endOfWeek(through);
  const totalDays = Math.round((eow.getTime() - sow.getTime()) / 86400000) + 1;
  const rawWeeks = Math.ceil(totalDays / 7);
  const weeks = Math.min(26, Math.max(1, rawWeeks));

  let startWeekDate: Date;
  if (rawWeeks > 26) {
    startWeekDate = new Date(eow.getTime() - (26 * 7 - 1) * 86400000);
  } else {
    startWeekDate = sow;
  }

  const map = new Map<string, TokenUsageAggregate>();
  for (const d of daily) map.set(d.key, d);

  const labelFmt = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", timeZone: "UTC" });
  const bars: ActivityBar[] = [];
  let cumTokens = 0n;
  let cumTurns = 0;

  // The display is bounded to recent weeks; cumulative totals still begin at
  // the requested range start, including days before the first visible bar.
  if (mode === "cumulative") {
    const firstVisibleDay = startWeekDate.toISOString().slice(0, 10);
    for (const day of map.values()) {
      if (day.key >= from && day.key < firstVisibleDay && day.key <= through) {
        try {
          cumTokens += BigInt(day.tokens);
          cumTurns += day.turns;
        } catch {}
      }
    }
  }

  for (let w = 0; w < weeks; w++) {
    const monday = new Date(startWeekDate.getTime() + w * 7 * 86400000);
    const mondayStr = monday.toISOString().slice(0, 10);
    let weekTokens = 0n;
    let weekTurns = 0;

    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(monday.getTime() + d * 86400000).toISOString().slice(0, 10);
      if (dayDate >= from && dayDate <= through) {
        const item = map.get(dayDate);
        if (item) {
          try {
            weekTokens += BigInt(item.tokens);
            weekTurns += item.turns;
          } catch {}
        }
      }
    }

    cumTokens += weekTokens;
    cumTurns += weekTurns;

    const tokens = mode === "cumulative" ? cumTokens.toString() : weekTokens.toString();
    const turns = mode === "cumulative" ? cumTurns : weekTurns;

    bars.push({
      key: mondayStr,
      label: labelFmt.format(monday),
      tokens,
      turns,
    });
  }

  return bars;
}

export function modelShare(tokens: string, total: string): number {
  try {
    const t = BigInt(total);
    if (t === 0n) return 0;
    return Number(BigInt(tokens) * 10000n / t) / 100;
  } catch {
    return 0;
  }
}

export function formatModelLabel(key: string, copy: (cn: string, en: string) => string): string {
  try {
    const [provider, model] = JSON.parse(key);
    return `${provider ?? copy("未知提供方", "Unknown provider")} / ${model ?? copy("未知模型", "Unknown model")}`;
  } catch {
    return copy("未知模型", "Unknown model");
  }
}

export function formatStateLabel(state: string, copy: (cn: string, en: string) => string): string {
  return (
    {
      settled: copy("已结算", "Settled"),
      provisional: copy("暂定", "Provisional"),
      pending: copy("待归属", "Pending attribution"),
      system: copy("系统", "System"),
      unknown: copy("未知", "Unknown"),
    } as Record<string, string>
  )[state] ?? state;
}

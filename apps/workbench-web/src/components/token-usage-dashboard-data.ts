import type { AgentUsageSnapshot } from "@opencraft/appserver-protocol";
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

export interface ModelGatewayRequestRecord {
  readonly id: string;
  readonly thread: string;
  readonly turn?: string | null;
  readonly model: string;
  readonly period: string;
  readonly reserved: number;
  readonly actual: number | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_tokens?: number | null;
  readonly state: string;
  readonly created_at: number;
}

export interface ModelGatewayBudgetSnapshot {
  readonly actor: string;
  readonly period: string;
  readonly usedTokens: number;
  readonly heldTokens: number;
  readonly unresolved?: number;
  readonly activeRequests?: number;
  readonly canManage?: boolean;
  readonly limit: {
    readonly monthlyTokens: number;
    readonly requestTokens: number;
    readonly concurrency: number;
    readonly revision?: number;
  } | null;
  readonly personalLimit: {
    readonly monthlyTokens: number | null;
    readonly revision: number;
  };
  readonly requests?: readonly ModelGatewayRequestRecord[];
  readonly directory?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly models: ReadonlyArray<{ readonly id: string; readonly name: string; readonly enabled: boolean }>;
  }>;
}

export interface TokenUsageLedgerCapability {
  readonly supported: boolean;
  readonly settled: boolean;
  readonly timezone: string | null;
}

/**
 * Resolves Host token-usage ledger support from negotiated `initializeResult`
 * extension metadata, eliminating speculative `-32601` RPC probing.
 */
export function resolveTokenUsageLedgerCapability(
  extension: Readonly<Record<string, unknown>> | null | undefined,
): TokenUsageLedgerCapability {
  if (extension === undefined) {
    return { supported: false, settled: false, timezone: null };
  }
  if (extension === null || extension.query !== true) {
    return { supported: false, settled: true, timezone: null };
  }
  return {
    supported: true,
    settled: true,
    timezone: typeof extension.timezone === "string" && extension.timezone.trim() ? extension.timezone.trim() : null,
  };
}

interface HostTokenUsageReplicaEntry {
  latestLedger: TokenUsageSnapshot | null;
  readonly ledgerByQuery: Map<string, TokenUsageSnapshot>;
  localUsage: AgentUsageSnapshot | null;
}

/**
 * Scoped runtime state replica for Token Usage (`stale-while-revalidate`).
 * Retains snapshots across route re-entries and filter switches without DOM height hacks,
 * partitioned strictly by `(accountScope, hostId)`.
 */
export class TokenUsageReplicaStore {
  private readonly hosts = new Map<string, HostTokenUsageReplicaEntry>();
  private readonly gateways = new Map<string, ModelGatewayBudgetSnapshot | null>();

  private hostKey(scope: string, hostId: string): string {
    return JSON.stringify([scope, hostId]);
  }

  private ensureHost(scope: string, hostId: string): HostTokenUsageReplicaEntry {
    const key = this.hostKey(scope, hostId);
    let entry = this.hosts.get(key);
    if (!entry) {
      entry = { latestLedger: null, ledgerByQuery: new Map(), localUsage: null };
      this.hosts.set(key, entry);
    }
    return entry;
  }

  readLedger(scope: string, hostId: string, queryKey: string): TokenUsageSnapshot | null {
    const entry = this.hosts.get(this.hostKey(scope, hostId));
    if (!entry) return null;
    return entry.ledgerByQuery.get(queryKey) ?? entry.latestLedger;
  }

  writeLedger(scope: string, hostId: string, queryKey: string, snapshot: TokenUsageSnapshot): void {
    const entry = this.ensureHost(scope, hostId);
    const existing = entry.ledgerByQuery.get(queryKey);
    if (existing && snapshot.snapshotRevision < existing.snapshotRevision) return;
    entry.ledgerByQuery.set(queryKey, snapshot);
    if (entry.ledgerByQuery.size > 24) {
      const oldest = entry.ledgerByQuery.keys().next().value;
      if (oldest !== undefined) entry.ledgerByQuery.delete(oldest);
    }
    if (!entry.latestLedger || snapshot.snapshotRevision >= entry.latestLedger.snapshotRevision) {
      entry.latestLedger = snapshot;
    }
  }

  readLocalUsage(scope: string, hostId: string): AgentUsageSnapshot | null {
    return this.hosts.get(this.hostKey(scope, hostId))?.localUsage ?? null;
  }

  writeLocalUsage(scope: string, hostId: string, snapshot: AgentUsageSnapshot): void {
    this.ensureHost(scope, hostId).localUsage = snapshot;
  }

  readGateway(scope: string): ModelGatewayBudgetSnapshot | null | undefined {
    return this.gateways.get(scope);
  }

  writeGateway(scope: string, snapshot: ModelGatewayBudgetSnapshot | null): void {
    this.gateways.set(scope, snapshot);
  }

  clearScope(scope: string): void {
    this.gateways.delete(scope);
    const prefix = `[\"${scope.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\",`;
    for (const key of Array.from(this.hosts.keys())) {
      if (key.startsWith(prefix)) this.hosts.delete(key);
    }
  }
}

export const tokenUsageReplica = new TokenUsageReplicaStore();

export function parseModelGatewayBudgetSnapshot(raw: unknown): ModelGatewayBudgetSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.actor !== "string" ||
    typeof obj.period !== "string" ||
    typeof obj.usedTokens !== "number" ||
    typeof obj.heldTokens !== "number" ||
    !obj.personalLimit ||
    typeof obj.personalLimit !== "object"
  ) {
    return null;
  }
  return obj as unknown as ModelGatewayBudgetSnapshot;
}

export function formatDateInTimeZone(timeZone: string, epochMs = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(epochMs);
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10);
  }
}

export function dateBeforeDays(days: number, timeZone: string, epochMs = Date.now()): string {
  const anchor = formatDateInTimeZone(timeZone, epochMs);
  const date = new Date(`${anchor}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}

export function buildWeekdayLabels(locale: string): readonly string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // 2024-01-01 is Monday in UTC. Render Mon, Wed, Fri, Sun to avoid vertical crowding.
  return Array.from({ length: 7 }, (_, idx) => {
    if (idx % 2 !== 0) return "";
    const label = fmt.format(new Date(Date.UTC(2024, 0, 1 + idx)));
    return label.replace(/^周|^星期/u, "");
  });
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

  const startWeekDate = rawWeeks > 26 ? new Date(eow.getTime() - (26 * 7 - 1) * 86400000) : sow;

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
        const state = turns > 0 || tokens !== "0" ? "measured" : "zero";
        col.push({ date: cellDate, tokens, turns, state });
      }
    }
    gridCells.push(col);
  }

  const columns: ActivityCell[][] = gridCells.map((col) =>
    col.map((cell) => {
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (cell.state !== "outside" && cell.tokens !== "0" && maxTokens > 0n) {
        try {
          const val = BigInt(cell.tokens);
          const scaled = Number((val * 4n) / maxTokens);
          level = Math.min(4, Math.max(1, 1 + scaled)) as 0 | 1 | 2 | 3 | 4;
        } catch {}
      }
      return { ...cell, level };
    }),
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

  const startWeekDate = rawWeeks > 26 ? new Date(eow.getTime() - (26 * 7 - 1) * 86400000) : sow;

  const map = new Map<string, TokenUsageAggregate>();
  for (const d of daily) map.set(d.key, d);

  const labelFmt = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", timeZone: "UTC" });
  const bars: ActivityBar[] = [];
  let cumTokens = 0n;
  let cumTurns = 0;

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

    bars.push({
      key: mondayStr,
      label: labelFmt.format(monday),
      tokens: mode === "cumulative" ? cumTokens.toString() : weekTokens.toString(),
      turns: mode === "cumulative" ? cumTurns : weekTurns,
    });
  }

  return bars;
}

export function modelShare(tokens: string, total: string): number {
  try {
    const t = BigInt(total);
    if (t === 0n) return 0;
    return Number((BigInt(tokens) * 10000n) / t) / 100;
  } catch {
    return 0;
  }
}

export function formatModelLabel(
  key: string,
  labels: { readonly unknownProvider: string; readonly unknownModel: string },
): string {
  try {
    const [provider, model] = JSON.parse(key);
    return `${provider ?? labels.unknownProvider} / ${model ?? labels.unknownModel}`;
  } catch {
    return labels.unknownModel;
  }
}

export function formatStateLabel(
  state: string,
  labels: Readonly<Record<"settled" | "provisional" | "pending" | "system" | "unknown", string>>,
): string {
  return (labels as Readonly<Record<string, string>>)[state] ?? state;
}

export interface TrendDataPoint {
  date: string;
  total_tokens: number;
  total_interactions: number;
}

export interface ModelDistribution {
  model: string;
  tokens: number;
  requests: number;
}

export interface ModelDailyDistribution {
  date: string;
  model: string;
  tokens: number;
  requests: number;
  share: number;
}

export interface UsageTrend {
  period: string;
  granularity: string;
  data: TrendDataPoint[];
  model_distribution: ModelDistribution[];
  model_daily_distribution: ModelDailyDistribution[];
}

function toUTCDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periodToDays(period: string): number {
  const match = /^(\d+)d$/.exec(period.trim());
  if (!match) {
    return 7;
  }
  return Math.max(Number.parseInt(match[1], 10), 1);
}

export function normalizeUsageTrend(
  raw: Omit<UsageTrend, "data" | "model_distribution" | "model_daily_distribution"> & {
    data: TrendDataPoint[] | null;
    model_distribution: ModelDistribution[] | null;
    model_daily_distribution: Array<Omit<ModelDailyDistribution, "share"> & { share?: number | null }> | null;
  },
  now: Date = new Date(),
): UsageTrend {
  const spanDays = periodToDays(raw.period);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - spanDays + 1);

  const indexed = new Map(
    (raw.data ?? []).map((point) => [
      point.date,
      {
        date: point.date,
        total_tokens: point.total_tokens ?? 0,
        total_interactions: point.total_interactions ?? 0,
      },
    ]),
  );

  const data: TrendDataPoint[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = toUTCDateKey(cursor);
    data.push(indexed.get(date) ?? {
      date,
      total_tokens: 0,
      total_interactions: 0,
    });
  }

  const rawDailyRows = raw.model_daily_distribution ?? [];
  const rowsByDate = new Map<string, Array<Omit<ModelDailyDistribution, "share"> & { share?: number | null }>>();
  for (const row of rawDailyRows) {
    const rows = rowsByDate.get(row.date) ?? [];
    rows.push(row);
    rowsByDate.set(row.date, rows);
  }

  const modelDailyDistribution: ModelDailyDistribution[] = [];
  for (const point of data) {
    const rows = rowsByDate.get(point.date) ?? [];
    if (rows.length === 0) {
      modelDailyDistribution.push({
        date: point.date,
        model: "暂无模型",
        tokens: 0,
        requests: 0,
        share: 0,
      });
      continue;
    }

    const dailyTokenTotal = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    for (const row of rows) {
      const tokens = row.tokens ?? 0;
      modelDailyDistribution.push({
        date: row.date,
        model: row.model || "未知模型",
        tokens,
        requests: row.requests ?? 0,
        share: row.share ?? (dailyTokenTotal > 0 ? (tokens / dailyTokenTotal) * 100 : 0),
      });
    }
  }

  return {
    ...raw,
    data,
    model_distribution: raw.model_distribution ?? [],
    model_daily_distribution: modelDailyDistribution,
  };
}

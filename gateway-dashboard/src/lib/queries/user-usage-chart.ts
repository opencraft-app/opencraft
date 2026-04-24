interface UserUsagePoint {
  date: string;
  total_tokens: number;
  total_interactions: number;
}

interface UserUsageResponse {
  user_id: string;
  days: number;
  daily: UserUsagePoint[];
  total_tokens: number;
  total_interactions: number;
}

function toUTCDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeUserUsage(
  usage: UserUsageResponse,
  now: Date = new Date(),
): UserUsageResponse {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const spanDays = Math.max(usage.days, 1);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - spanDays + 1);

  const indexed = new Map(
    (usage.daily ?? []).map((point) => [
      point.date,
      {
        date: point.date,
        total_tokens: point.total_tokens ?? 0,
        total_interactions: point.total_interactions ?? 0,
      },
    ]),
  );

  const daily: UserUsagePoint[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = toUTCDateKey(cursor);
    daily.push(indexed.get(date) ?? {
      date,
      total_tokens: 0,
      total_interactions: 0,
    });
  }

  return {
    ...usage,
    daily,
  };
}

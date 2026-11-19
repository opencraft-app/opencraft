/** Native activity time, never the browser's arrival/open/resume clock.
 * Codex documents UUIDv7 Turn IDs; older Servers may omit startedAt. */
export function turnStartedRecency(
  turn: { readonly startedAt?: number | null; readonly id?: string } | null | undefined,
): number | undefined {
  const value = turn?.startedAt;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value * 1000).getTime())
  )
    return value;
  const uuid =
    typeof turn?.id === "string"
      ? /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(turn.id)
      : null;
  return uuid ? Math.floor(Number.parseInt(uuid[1]! + uuid[2]!, 16) / 1000) : undefined;
}

/** recencyAt is the directory ordering clock; do not overwrite updatedAt. */
export function withTurnRecency<T extends { readonly recencyAt?: number | null; readonly updatedAt: number }>(
  row: T,
  startedAt: number,
): T {
  return startedAt > (row.recencyAt ?? row.updatedAt) ? { ...row, recencyAt: startedAt } : row;
}

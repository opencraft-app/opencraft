import type { TokenUsageSnapshot } from "@opencraft/appserver-protocol/token-usage";

/** Names are presentation metadata from the existing identity directory. They
 * never enter the ledger or determine participant identity or allocation. */
export function labelUsagePeople(snapshot: TokenUsageSnapshot, lookup?: (id: string) => { kind: string; displayName: string } | null): TokenUsageSnapshot {
  if (!lookup || snapshot.scope !== "team" || !snapshot.canQueryTeam || snapshot.view !== "actors") return snapshot;
  return { ...snapshot, rows: snapshot.rows.map(row => {
    if (!("key" in row)) return row;
    const actor = lookup(row.key);
    return { ...row, label: actor?.kind === "human" ? actor.displayName : null };
  }) };
}

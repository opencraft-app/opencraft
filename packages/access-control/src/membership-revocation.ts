import type { SqlDatabase as MembershipConnection } from '@opencraft/sql';
/** Read-only epoch from the existing audit owner. Disable/enable between polls
 * cannot revive an older admitted credential context. Never writes audit data. */
export function membershipRevocationRevision(
  db: Pick<MembershipConnection, "prepare">,
  actorId: string,
  bindingKeys: readonly string[],
): number {
  return Math.max(
    0,
    ...[actorId, ...bindingKeys].map((key) =>
      Number(
        db
          .prepare(
            `SELECT COALESCE(MAX(id),0) AS revision FROM access_audit WHERE binding=? AND CASE WHEN json_valid(action) THEN json_extract(action,'$.enabled') END = 0`,
          )
          .get(key)!.revision,
      ),
    ),
  );
}

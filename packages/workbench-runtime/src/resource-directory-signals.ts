/** Invalidation hints, not resource records or authority. One bounded row per
 * kind/Host: revisions and the metadata Merkle root make dropped pushes visible. */
export interface ResourceDirectorySignal {
  readonly id: string;
  readonly kind: string;
  readonly hostId: string;
  readonly token: string;
}
export function parseResourceDirectorySignals(value: unknown): ResourceDirectorySignal[] {
  if (!Array.isArray(value) || value.length > 256) throw Error("Invalid resource invalidations");
  const seen = new Set<string>();
  return value.map((row) => {
    if (
      !row ||
      Object.keys(row).some((key) => !["id", "kind", "hostId", "token"].includes(key)) ||
      typeof row.kind !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(row.kind) ||
      typeof row.hostId !== "string" ||
      !row.hostId ||
      row.hostId.length > 512 ||
      /[\u0000-\u001f]/u.test(row.hostId) ||
      typeof row.token !== "string" ||
      !/^[a-zA-Z0-9-]{20,100}$/.test(row.token) ||
      row.id !== JSON.stringify([row.kind, row.hostId]) ||
      seen.has(row.id)
    )
      throw Error("Invalid resource invalidation identity");
    seen.add(row.id);
    return { id: row.id, kind: row.kind, hostId: row.hostId, token: row.token };
  });
}

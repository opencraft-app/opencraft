import { digest, requireText } from "./values.mjs";

/** Behavior constants follow the inspected 0.18 synthesis path. */
export class MemorySynthesisPolicy {
  static defaults = Object.freeze({
    enabled: true,
    debounceMs: 15000,
    deadlineMs: 90000,
    pollMs: 3600000,
    refreshMs: 86400000,
  });
  static limits = Object.freeze({
    evidence: 12,
    evidenceCharacters: 8000,
    changes: 64,
    content: 500,
    snapshot: 512,
    pending: 64,
  });
  static resolve(raw = {}) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((k) => !Object.hasOwn(this.defaults, k))
    )
      throw new Error("Unknown memory policy setting");
    const p = { ...this.defaults, ...raw };
    if (typeof p.enabled !== "boolean") throw new Error("memoryPolicy.enabled must be boolean");
    for (const k of ["debounceMs", "deadlineMs", "pollMs", "refreshMs"])
      if (!Number.isSafeInteger(p[k]) || p[k] < (k === "debounceMs" ? 0 : 1) || p[k] > 7 * 86400000)
        throw new Error(`Invalid memoryPolicy.${k}`);
    return p;
  }
}
export const normalizeMemory = (raw) =>
  requireText(raw, "memory content", 1000000).replace(/\s+/gu, " ").trim().slice(0, 500);
export const memoryDedupe = (content) => normalizeMemory(content).toLowerCase();
export const memoryFactId = (fact) =>
  digest([fact.scope ?? "user", fact.projectId ?? null, memoryDedupe(fact.value ?? fact.content)]).slice(0, 16);
export const memoryTombstoneId = (scope, projectId, content) => digest([scope, projectId, memoryDedupe(content)]);
export function boundMemoryEvidence(text) {
  const value = String(text ?? "").trim();
  return value.length <= 8000 ? value : `${value.slice(0, 4000)}\n[...middle omitted...]\n${value.slice(-4000)}`;
}
export function synthesisFingerprint(rows) {
  return digest(
    rows
      .map((m) => ({
        key: m.key,
        revision: m.revision,
        deleted: m.deleted,
        value: m.value,
        scope: m.scope,
        projectId: m.projectId,
        kind: m.kind,
        origin: m.origin,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}
export function synthesisFact(row) {
  return {
    id: memoryFactId(row),
    content: normalizeMemory(row.value),
    createdAt: row.updatedAt ?? 0,
    kind: row.kind ?? "profile",
    origin: row.origin === "automatic" ? "synthesis" : (row.origin ?? "legacy"),
    scope: row.scope ?? "user",
    projectId: row.projectId ?? null,
  };
}

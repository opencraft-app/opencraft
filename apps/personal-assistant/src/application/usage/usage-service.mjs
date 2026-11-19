import { requireText } from "../../domain/values.mjs";
import { normalizeUsage, sumUsage } from "../../domain/usage.mjs";

/** Readable observations, no debit/reservation or second native task ledger. */
export class UsageService {
  constructor({ repository, uow, readWork, readExecutions = () => [], now = Date.now }) {
    Object.assign(this, { repository, uow, readWork, readExecutions, now });
  }
  recordCall({ id, kind, provider, model, mode, usage, outcome, elapsedMs }) {
    requireText(id, "usage id", 200);
    if (!["reception", "memory-propose", "memory-verify", "context-summary"].includes(kind))
      throw new Error("Unknown usage kind");
    if (!["fixture", "model"].includes(mode) || !["returned", "error", "aborted", "timeout"].includes(outcome))
      throw new Error("Invalid usage observation");
    const data = {
      usage: normalizeUsage(usage),
      outcome,
      elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
      hostCalls: 1,
      source: "model-response",
      provider: typeof provider === "string" ? provider.slice(0, 160) : null,
      model: typeof model === "string" ? model.slice(0, 160) : null,
    };
    return this.uow.transaction(() => {
      if (this.repository.get(id)) return { duplicate: true };
      this.repository.save({
        id,
        kind,
        workId: null,
        mode,
        data,
        at: this.now(),
      });
      return { duplicate: false };
    });
  }
  recordNative(workId, state, mode, { engine = "pi", executionId = workId } = {}) {
    this.readWork(workId);
    if (
      !["pi", "codex"].includes(engine) ||
      (executionId !== workId && !this.readExecutions(workId).some((e) => e.id === executionId))
    )
      throw new Error("Invalid native usage owner");
    if (!["fixture", "model"].includes(mode)) throw new Error("Invalid usage mode");
    const groups = new Map();
    for (const bucket of ["models", "tools"]) {
      const entries = Object.entries(state?.[bucket] ?? {});
      if (entries.length > 128) throw new Error("Native usage buckets exceed bound");
      for (const [name, raw] of entries) {
        const actualMode = bucket === "models" && name.startsWith("faux/") ? "fixture" : mode;
        const key = `${bucket}:${actualMode}`;
        if (!groups.has(key)) groups.set(key, { bucket, mode: actualMode, rows: [] });
        groups.get(key).rows.push({ name: name.slice(0, 300), usage: normalizeUsage(raw) });
      }
    }
    if (!groups.size) groups.set(`models:${mode}`, { bucket: "models", mode, rows: [] });
    return this.uow.transaction(() => {
      for (const [key, group] of groups)
        this.repository.save({
          id: `${engine}:${executionId}:${key}`,
          kind: `worker-${group.bucket}`,
          workId,
          mode: group.mode,
          data: {
            usage: sumUsage(group.rows.map((r) => r.usage)),
            hostCalls: null,
            source: `${engine}.usage`,
            buckets: group.rows,
            coverage: "native-counters; provider reporting may be incomplete",
          },
          at: this.now(),
        });
    });
  }
  read({ workId, after, limit = 20 } = {}) {
    if (workId !== undefined) this.readWork(requireText(workId, "workId", 160));
    if (after !== undefined) requireText(after, "after", 300);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Usage limit must be 1..100");
    const rows = this.repository.list(workId, after, limit + 1);
    return {
      ...(workId
        ? {
            executions: this.readExecutions(workId).map((e) => ({
              executionId: e.id,
              revision: e.revision,
              control: e.guard_json ? JSON.parse(e.guard_json) : null,
            })),
          }
        : {}),
      totalsByMode: this.repository.totals(workId),
      items: rows.slice(0, limit),
      next: rows.length > limit ? rows[limit - 1].id : null,
      scope: workId ? { workId, nativeTotalsAcrossRevisions: true } : { profile: true },
      note: "Observed counters only; fixture is separate. Price estimates are not billed amounts; unknown fields and provider-internal retries are not zero.",
    };
  }
}

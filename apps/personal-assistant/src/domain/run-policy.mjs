/** Local run protection, deliberately separate from monetary budgets. */
export class RunPolicy {
  static defaults = Object.freeze({
    maxSteps: 128,
    workTimeoutMs: 600000,
    modelTimeoutMs: 120000,
    maxRetries: 2,
  });
  static resolve(raw = {}) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((k) => !Object.hasOwn(this.defaults, k))
    )
      throw new Error("Unknown run policy setting");
    const policy = { ...this.defaults, ...raw };
    for (const [key, max] of Object.entries({
      maxSteps: 5000,
      workTimeoutMs: 86400000,
      modelTimeoutMs: 3600000,
      maxRetries: 5,
    }))
      if (
        !Number.isSafeInteger(policy[key]) ||
        policy[key] < (key === "maxRetries" ? 0 : 1) ||
        policy[key] > max
      )
        throw new Error(
          `runPolicy.${key} must be ${key === "maxRetries" ? 0 : 1}..${max}`,
        );
    return policy;
  }
}
export class RunLimitError extends Error {
  constructor(kind, limit) {
    super(
      kind === "steps"
        ? `Execution reached its ${limit} model-step limit; amend the work to continue`
        : `${kind} exceeded ${limit} ms; previous effects are retained`,
    );
    this.name = "RunLimitError";
    this.code = `RUN_LIMIT_${kind.toUpperCase().replaceAll("-", "_")}`;
  }
}

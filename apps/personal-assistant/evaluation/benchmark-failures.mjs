/** Transport availability is not an answer-quality failure. Raw evidence remains unchanged. */
export function serviceStatus(message = "") {
  const text = String(message);
  const match = text.match(
    /^(?:Benchmark model HTTP |)(401|402|403|404|408|429|5\d\d)(?::|$)/,
  );
  if (match) return Number(match[1]);
  return null;
}

export function infrastructureFailure(record) {
  return record.status !== "completed" && serviceStatus(record.error) !== null;
}

export function recordVerdict(record) {
  if (!record || infrastructureFailure(record)) return null;
  if (record.status !== "completed") return false;
  return typeof record.judge?.correct === "boolean"
    ? record.judge.correct
    : null;
}

export function recoveryAction(record) {
  if (!record || infrastructureFailure(record)) return "retry-answer";
  if (record.status === "completed" && recordVerdict(record) === null)
    return "judge-only";
  return "reuse";
}

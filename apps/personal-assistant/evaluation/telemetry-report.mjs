import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const attributes = (items = []) =>
  Object.fromEntries(
    items.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue]),
  );
const identity = (item) => `${item.traceId}:${item.spanId}`;
export function summarizeTelemetry(envelopes, logs = []) {
  const spans = new Map(),
    started = new Map(),
    finished = new Set();
  for (const request of envelopes)
    for (const resource of request.resourceSpans ?? [])
      for (const scope of resource.scopeSpans ?? [])
        for (const span of scope.spans ?? []) spans.set(identity(span), span);
  for (const request of logs)
    for (const resource of request.resourceLogs ?? [])
      for (const scope of resource.scopeLogs ?? [])
        for (const log of scope.logRecords ?? []) {
          const body = log.body?.stringValue ?? "";
          if (body.endsWith(".started")) started.set(identity(log), body.slice(0, -8));
          if (body.endsWith(".finished")) finished.add(identity(log));
        }
  const groups = {};
  for (const span of spans.values()) {
    const attrs = attributes(span.attributes),
      role = attrs["app.model_role"];
    const key = role ? `${span.name}/${role}` : span.name;
    const ms = Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6;
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid span duration");
    const group = (groups[key] ??= {
      count: 0,
      totalInclusiveMs: 0,
      maxMs: 0,
      errors: 0,
    });
    group.count++;
    group.totalInclusiveMs += ms;
    group.maxMs = Math.max(group.maxMs, ms);
    if (span.status?.code === 2) group.errors++;
  }
  const incompleteByStage = {};
  for (const [key, stage] of started)
    if (!finished.has(key) && !spans.has(key)) incompleteByStage[stage] = (incompleteByStage[stage] ?? 0) + 1;
  return {
    completedSpans: spans.size,
    groups,
    observedUnfinishedStarts: incompleteByStage,
    interpretation:
      "Durations are inclusive and overlap across parent/child spans; never sum groups into wall time. Unmatched starts may reflect termination, rotation or missing export, not proven running work.",
  };
}

async function loadSignal(directory, name) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { requests: [], malformedLines: 0, files: [] };
    throw error;
  }
  const requests = [],
    files = [];
  let malformedLines = 0;
  for (const file of names
    .filter((f) => f === name || new RegExp(`^${name.replaceAll(".", "\\.")}\\.[1-3]$`).test(f))
    .sort()) {
    const bytes = await readFile(join(directory, file));
    files.push({
      name: file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
      try {
        requests.push(JSON.parse(line));
      } catch {
        malformedLines++;
      }
    }
  }
  return { requests, malformedLines, files };
}

export async function profileTelemetry(directory) {
  const signals = await Promise.all([
    loadSignal(directory, "traces.otlp.jsonl"),
    loadSignal(directory, "logs.otlp.jsonl"),
  ]);
  return {
    ...summarizeTelemetry(signals[0].requests, signals[1].requests),
    malformedLines: signals.reduce((n, s) => n + s.malformedLines, 0),
    files: signals.flatMap((s) => s.files),
    coverage: signals[0].files.length ? "observed-local-window" : "no-trace-files",
    remoteQueueNetworkAndComputeSeparated: false,
  };
}

async function main() {
  const directory = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Expected benchmark run directory");
  const plan = JSON.parse(await readFile(join(directory, "plan.json"), "utf8"));
  const cases = [];
  for (const id of plan.identity.selectedIds) {
    const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
    let record;
    try {
      record = JSON.parse(await readFile(join(directory, "records", key + "-native-assistant.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const telemetry = await profileTelemetry(join(directory, key, "telemetry"));
    cases.push({
      question_id: id,
      answerStatus: record?.status ?? "not-recorded",
      answerElapsedMs: record?.answerElapsedMs ?? null,
      telemetry,
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    sourceCodeSha256: plan.identity.sourceCodeSha256,
    variant: plan.variant ?? "oracle",
    cases,
    limitations: [
      "Only retained local files are observable; rotation is bounded and absent data is not zero.",
      "No model prompts, answers or credentials copied into this report.",
      "This report does not introduce OTel metrics or measure provider-internal phases.",
    ],
  };
  await writeFile(join(directory, "telemetry-summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(
    JSON.stringify({
      cases: cases.length,
      observed: cases.filter((c) => c.telemetry.completedSpans).length,
      report: join(directory, "telemetry-summary.json"),
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

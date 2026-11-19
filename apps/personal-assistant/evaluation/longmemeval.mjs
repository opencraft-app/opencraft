import { parseArgs } from "node:util";
import { open, mkdir, appendFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { selectCases } from "./longmemeval-data.mjs";
import { resolveHarnesses } from "../src/adapters/codex/config.mjs";

export function runCase(input, { directory, mode, model, apiKey, timeoutMs, harnesses }) {
  return new Promise((resolvePromise, reject) => {
    // No inherited provider credentials, account homes, custom Node loaders or preload scripts.
    const child = fork(new URL("./assistant-worker.mjs", import.meta.url), [], {
      execArgv: [],
      detached: process.platform !== "win32",
      env: { PATH: process.env.PATH ?? "", HOME: directory, LANG: "C.UTF-8" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    let settled = false,
      message;
    const stopTree = () => {
      if (!child.pid) return;
      try {
        process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timeout = setTimeout(stopTree, timeoutMs + 1000);
    child.once("message", (value) => {
      message = value;
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      stopTree(); // Reap native descendants even after a forced worker failure.
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal || code !== 0 || !message)
        reject(new Error(signal ? `Assistant process terminated (${signal})` : "Assistant process failed"));
      else if (!message.ok) reject(new Error(message.error));
      else resolvePromise(message.result);
    });
    child.send({ input, directory, mode, model, apiKey, timeoutMs, harnesses });
  });
}

export async function readCodexConfiguration(path) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077)
      throw new Error("Codex config must be a private regular file (chmod 600)");
    const codex = JSON.parse(await file.readFile("utf8"));
    return resolveHarnesses({
      harnesses: { assistant: "codex", execution: "pi", codex },
    });
  } finally {
    await file.close();
  }
}

export async function readModelConfiguration(path) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o077)
      throw new Error("Model config must be a private regular file (chmod 600)");
    const value = JSON.parse(await file.readFile("utf8"));
    if (
      !["deepseek", "anthropic", "openai-compatible"].includes(value.provider) ||
      typeof value.modelId !== "string" ||
      !value.modelId ||
      typeof value.apiKey !== "string" ||
      !value.apiKey ||
      Object.keys(value).some((k) => !["provider", "modelId", "apiKey", "baseUrl", "thinking"].includes(k))
    )
      throw new Error("Expected explicit provider, modelId and apiKey");
    if (value.provider === "openai-compatible") {
      const { compatibleProvider } = await import("../src/adapters/models/openai-compatible.mjs");
      compatibleProvider(value);
    } else if (value.baseUrl !== undefined || value.thinking !== undefined)
      throw new Error("Endpoint overrides require openai-compatible provider");
    return value;
  } finally {
    await file.close();
  }
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      dataset: { type: "string" },
      output: { type: "string" },
      mode: { type: "string", default: "fixture" },
      limit: { type: "string", default: "5" },
      "timeout-ms": { type: "string", default: "300000" },
      "model-config": { type: "string" },
      "assistant-harness": { type: "string", default: "pi" },
      "codex-config": { type: "string" },
      "strict-time": { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (v.help) {
    console.log(
      "node evaluation/longmemeval.mjs --dataset FILE --output NEW_DIR [--limit 5] [--plan] [--strict-time] [--mode fixture|model --model-config PRIVATE_JSON] [--assistant-harness pi|codex --codex-config PRIVATE_JSON] [--timeout-ms 300000]",
    );
    return;
  }
  if (!v.dataset || !v.output || !["fixture", "model"].includes(v.mode))
    throw new Error("dataset, output and a valid mode are required");
  if (!["pi", "codex"].includes(v["assistant-harness"])) throw new Error("assistant-harness must be pi or codex");
  const codexSelected = v["assistant-harness"] === "codex";
  if (codexSelected && (v.mode !== "model" || !v["codex-config"] || v["model-config"]))
    throw new Error("Codex requires --mode model --codex-config and no Pi --model-config");
  if (!codexSelected && v["codex-config"]) throw new Error("codex-config requires --assistant-harness codex");
  const timeoutMs = Number(v["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
    throw new Error("timeout-ms must be 1000..3600000 per case");
  const handle = await open(resolve(v.dataset), "r");
  let buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
      throw new Error("Dataset must be a JSON file no larger than 512 MiB; shard larger datasets first");
    buffer = await handle.readFile();
  } finally {
    await handle.close();
  }
  const rows = JSON.parse(buffer.toString("utf8"));
  const cases = selectCases(rows, Number(v.limit), {
    strictTime: v["strict-time"],
  });
  const datasetSha256 = createHash("sha256").update(buffer).digest("hex");
  if (v.plan) {
    console.log(
      JSON.stringify(
        {
          mode: v.mode,
          assistantHarness: v["assistant-harness"],
          selected: cases.length,
          total: rows.length,
          datasetSha256,
          historyMessages: cases.reduce(
            (n, c) => n + c.input.history.reduce((sum, s) => sum + s.messages.length, 0),
            0,
          ),
          futureSessions: cases.reduce((n, c) => n + c.futureSessionCount, 0),
          timeoutMsPerCase: timeoutMs,
          modelCallsPerformed: false,
          accuracy: null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (v.mode === "model" && !codexSelected && !v["model-config"])
    throw new Error("Real evaluation requires an explicit private --model-config; inherited credentials are not used");
  if (v.mode === "fixture" && v["model-config"]) throw new Error("Fixture runs do not accept model credentials");
  const config = v.mode === "model" && !codexSelected ? await readModelConfiguration(v["model-config"]) : null;
  const harnesses = codexSelected ? await readCodexConfiguration(v["codex-config"]) : undefined;
  const directory = resolve(v.output);
  await mkdir(directory, { mode: 0o700 }); // Refuse existing paths; never replace prior evidence/profiles.
  const model = config
    ? {
        provider: config.provider,
        modelId: config.modelId,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.thinking ? { thinking: config.thinking } : {}),
      }
    : undefined;
  const summary = {
    schemaVersion: 1,
    benchmark: "LongMemEval-classic",
    createdAt: new Date().toISOString(),
    mode: v.mode,
    assistantHarness: v["assistant-harness"],
    datasetSha256,
    sourceRows: rows.length,
    selected: cases.length,
    model: harnesses
      ? {
          provider: "codex-responses",
          modelId: harnesses.codex.modelId,
          baseUrl: harnesses.codex.baseUrl,
        }
      : (model ?? { provider: "fixture" }),
    timestampPolicy: v["strict-time"] ? "reject-future" : "preserve-official-input",
    futureSessions: cases.reduce((n, c) => n + c.futureSessionCount, 0),
    timeoutMsPerCase: timeoutMs,
    completed: 0,
    failed: 0,
    accuracy: null,
    scoring: "not-run",
    protocol: "recorded-history-replay/native-memory-and-history-qa",
    fixtureIsQualityEvidence: false,
    categories: Object.create(null),
    cases: [],
    limitations: [
      "History is replayed as recorded roles, not re-generated; old commands are not executed.",
      "Memory debounce is zero for deterministic per-exchange replay. Default production policy is unchanged.",
      "Native working-context summaries are lossy; temporal maintenance is not simulated.",
      "This runner does not perform official LLM judging or submit scores.",
      "LongMemEval knowledge updates/abstention do not certify privacy erasure. Canonical history remains accessible.",
    ],
  };
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(join(directory, "hypotheses.jsonl"), "", {
    mode: 0o600,
    flag: "wx",
  });
  for (const item of cases) {
    const started = Date.now();
    const record = {
      question_id: item.id,
      category: item.category,
      futureSessionCount: item.futureSessionCount,
      status: "failed",
      elapsedMs: 0,
    };
    let hypothesis = "";
    try {
      const result = await runCase(item.input, {
        directory: join(directory, item.key),
        mode: v.mode,
        model,
        harnesses,
        apiKey: config?.apiKey,
        timeoutMs,
      });
      if (typeof result.hypothesis !== "string" || !result.hypothesis.trim())
        throw new Error("Assistant returned an empty hypothesis");
      hypothesis = result.hypothesis;
      record.status = "completed";
      record.evidence = result.evidence;
      summary.completed++;
    } catch (error) {
      record.error = String(error.message)
        .split(config?.apiKey || "\0")
        .join("[redacted]");
      summary.failed++;
    }
    record.elapsedMs = Date.now() - started;
    summary.cases.push(record);
    const group = (summary.categories[item.category] ??= {
      completed: 0,
      failed: 0,
    });
    group[record.status]++;
    // Failures remain in the denominator, with empty answers. No gold labels are exported.
    await appendFile(join(directory, "hypotheses.jsonl"), JSON.stringify({ question_id: item.id, hypothesis }) + "\n");
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    console.log(
      JSON.stringify({
        question_id: item.id,
        status: record.status,
        elapsedMs: record.elapsedMs,
      }),
    );
  }
  console.log(
    JSON.stringify({
      directory,
      completed: summary.completed,
      failed: summary.failed,
      accuracy: null,
      scoring: "not-run",
      mode: v.mode,
    }),
  );
  if (summary.failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

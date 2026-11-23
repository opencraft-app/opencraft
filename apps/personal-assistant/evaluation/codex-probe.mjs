// Explicit, opt-in paid endpoint smoke. No benchmark score and no shared credentials.
import { parseArgs } from "node:util";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { readCodexConfiguration } from "./longmemeval.mjs";
import { initProfile } from "../src/adapters/local/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: { "codex-config": { type: "string" }, output: { type: "string" } },
});
if (!values["codex-config"] || !values.output)
  throw new Error("Required: --codex-config PRIVATE_JSON --output NEW_DIRECTORY");
const harnesses = await readCodexConfiguration(values["codex-config"]);
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
// Keep the Unix socket under a short private path; evidence directories may be long.
const profileDirectory = await mkdtemp(join(tmpdir(), "sa-codex-smoke-"));
const profile = initProfile(profileDirectory, "isolated-codex-probe", {
  harnesses,
  memoryPolicy: { enabled: false },
  runPolicy: { modelTimeoutMs: 45000 },
});
const report = {
  startedAt: new Date().toISOString(),
  assistantHarness: "codex",
  executionHarness: "pi",
  executionPerformed: false,
  endpoint: harnesses.codex.baseUrl,
  modelId: harnesses.codex.modelId,
  modelIsSynthetic: false,
  benchmarkScore: null,
};
let runner;
try {
  runner = await LocalRunner.open(profile);
  const call = (op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });
  await call("say", { text: "你好。这是一条连接烟测，请只回复你好，不要创建任务。" }, "native-codex-smoke");
  const deadline = Date.now() + 50000;
  for (;;) {
    const turn = await call("turn", { inputId: "native-codex-smoke" });
    if (turn.status === "blocked") throw new Error("Native reception failed");
    if (turn.status === "settled") {
      report.reply = turn.reply_text;
      break;
    }
    if (Date.now() > deadline) throw new Error("Native reception smoke timed out");
    await delay(50);
  }
  report.usage = await call("usage");
  report.workCount = (await call("status")).works.length;
  if (report.workCount !== 0 || !report.reply) throw new Error("Smoke did not remain an ordinary chat");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await runner?.close();
  await rm(profileDirectory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
console.log(
  JSON.stringify({
    passed: report.passed,
    report: join(output, "report.json"),
    benchmarkScore: null,
  }),
);

import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { initProfile, loadProfile } from "../src/profile.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { cases, runCase } from "./butler-cases.mjs";

export async function evaluateButlerCase({
  id,
  mode,
  harnesses,
  output,
  timeoutMs = 180000,
}) {
  const spec = cases.find((s) => s.id === id);
  if (!spec) throw new Error("Unknown case");
  const evidence = {
    id,
    mode,
    state: "running",
    startedAt: new Date().toISOString(),
    assertions: [],
    requests: [],
    turns: [],
    observations: [],
    semanticReview: { status: "unverified", rubric: spec.review },
    modelQualityScore: null,
  };
  const save = () =>
    writeFile(
      join(output, `${id}.json`),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  if (spec.modelOnly && mode === "fixture") {
    evidence.state = "not_run";
    evidence.reason =
      "This scenario requires real model intent or execution; fixture is not quality evidence";
    await save();
    return evidence;
  }
  const directory = await mkdtemp(join(tmpdir(), "sa-butler-"));
  evidence.profileDirectory = directory;
  const profile = initProfile(directory, "synthetic-butler-user", {
    mode,
    ...(harnesses ? { harnesses } : {}),
    concurrency: 2,
    fixtureDelayMs: 0,
    memoryPolicy: { enabled: false }, // Explicit-memory contract; no automatic-learning score.
    runPolicy: { modelTimeoutMs: 60000, workTimeoutMs: 120000, maxSteps: 16 },
  });
  let runner;
  const end = Date.now() + timeoutMs;
  const call = async (op, params = {}, key = crypto.randomUUID()) => {
    const message = { op, params, id: `${id}:${key}` };
    const result = await request(profile, message);
    return result;
  };
  const context = {
    mode,
    call: async (op, params = {}, key = crypto.randomUUID()) => {
      // Keep input evidence; polling observations are captured separately to avoid huge logs.
      if (
        ![
          "status",
          "work",
          "goal.get",
          "goal.list",
          "interaction.list",
          "turn",
          "events",
          "usage",
          "conversation",
          "memory.list",
        ].includes(op)
      ) {
        evidence.requests.push({ op, params, id: `${id}:${key}` });
        await save();
      }
      return call(op, params, key);
    },
    async wait(check) {
      while (Date.now() < end) {
        const value = await check();
        if (value) return value;
        await delay(75);
      }
      throw Object.assign(new Error("Scenario deadline exceeded"), {
        code: "SCENARIO_TIMEOUT",
      });
    },
    check(name, condition, detail) {
      evidence.assertions.push({
        name,
        passed: !!condition,
        ...(detail ? { detail } : {}),
      });
      assert.ok(condition, name);
    },
    async reject(name, op, params, key) {
      let error;
      try {
        await context.call(op, params, key);
      } catch (e) {
        error = e.message;
      }
      context.check(
        name,
        !!error && !/ECONN|socket|timed out|Runner closed/i.test(error),
        { error },
      );
    },
    async say(text, key, work) {
      await context.call(
        "say",
        {
          text,
          ...(work ? { workId: work.id, expectedRevision: work.revision } : {}),
        },
        key,
      );
      const turn = await context.wait(async () => {
        const t = await call("turn", { inputId: `${id}:${key}` });
        if (t.status === "blocked") {
          evidence.turns.push(t);
          throw new Error(`Reception blocked: ${t.error ?? t.reply_text}`);
        }
        return t.status === "settled" && t;
      });
      evidence.turns.push(turn);
      await save();
      return turn;
    },
    async observe() {
      // Bounded paused-state observation window, not simulated elapsed days.
      for (let i = 0; i < 4; i++) {
        evidence.observations.push(await call("status"));
        await delay(75);
      }
    },
    async restart() {
      await runner.close();
      runner = undefined;
      runner = await LocalRunner.open(loadProfile(directory));
    },
    async notes() {
      const names = await readdir(join(directory, "artifacts"));
      return Promise.all(
        names
          .filter((n) => n.endsWith(".md"))
          .map(async (name) => ({
            name,
            text: await readFile(join(directory, "artifacts", name), "utf8"),
          })),
      );
    },
  };
  await save();
  try {
    runner = await LocalRunner.open(profile);
    await runCase(id, context);
    evidence.state = "passed";
  } catch (error) {
    evidence.state = error.code === "SCENARIO_TIMEOUT" ? "timeout" : "failed";
    if (error.code === "SCENARIO_TIMEOUT") evidence.timeoutScope = "scenario";
    evidence.error = error.message;
  } finally {
    if (runner) {
      for (const [name, op, params] of [
        ["finalState", "status", {}],
        ["goals", "goal.list", {}],
        ["history", "conversation", {}],
        ["usage", "usage", { limit: 100 }],
        ["events", "events", {}],
      ]) {
        try {
          evidence[name] = await call(op, params);
        } catch (error) {
          (evidence.captureErrors ??= []).push(`${name}: ${error.message}`);
        }
      }
      try {
        evidence.artifacts = await context.notes();
      } catch (error) {
        (evidence.captureErrors ??= []).push(error.message);
      }
      try {
        await runner.close();
      } catch (error) {
        evidence.state = "failed";
        evidence.closeError = error.message;
      }
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.durationMs = Date.now() - Date.parse(evidence.startedAt);
    evidence.observationBounds = {
      eventsMax: 1000,
      usageNext: evidence.usage?.next ?? null,
    };
    await save();
  }
  return evidence;
}

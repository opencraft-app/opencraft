import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.mjs";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import { selectScenarios } from "../scripts/scenarios/catalog.mjs";
import { profileFor, root } from "./helpers.mjs";
const exec = promisify(execFile);

const temporary = (t) => {
  const path = mkdtempSync(join(tmpdir(), "superapp-scenarios-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};

test("Pi adapters cannot reach application owners or import the composition root", () => {
  for (const name of readdirSync(join(root, "src/adapters/pi"))) {
    if (!name.endsWith(".mjs")) continue;
    const source = readFileSync(join(root, "src/adapters/pi", name), "utf8");
    assert.doesNotMatch(source, /\b(?:this\.)?app\s*[.,:]/, name);
    assert.doesNotMatch(source, /from\s*["'][^"']*(?:runtime|application)\//, name);
    assert.doesNotMatch(source, /\b(?:repository|uow)\s*[.,:]/, name);
  }
});

test("work-bound tool ports preserve original work identity and cancel checks without exposing owners", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const app = store.app;
  const first = app.works.submit("first", { text: "整理项目，先问我范围" });
  const second = app.works.submit("second", { text: "other work" });
  const work = app.workRecord(first.workId);
  const ports = createExecutionPorts(app);
  const tools = ports.toolsFor(work, ports.executions.snapshot(work));
  for (const item of [ports, ports.executions, tools]) {
    assert.ok(Object.isFrozen(item));
    for (const key of ["app", "r", "uow", "works", "memory", "skills", "credentials", "outcomes"])
      assert.equal(item[key], undefined, key);
  }
  assert.equal(ports.executions.started, undefined);
  assert.equal(ports.executions.report, undefined);
  assert.equal(tools.readContext(second.workId).work.id, first.workId);
  app.executions.started(work);
  tools.assertAction("ask_user");
  const question = tools.requestInteraction("one-call", "本周还是本月？");
  assert.equal(question.work_id, first.workId);
  assert.equal(tools.requestInteraction("one-call", "本周还是本月？").id, question.id);
  assert.equal(app.detail(second.workId).interactions.length, 0);
  app.works.cancel("cancel-first", {
    workId: first.workId,
    expectedRevision: 1,
  });
  assert.throws(() => tools.assertAction("publish_note"), /current|cancelled|owns|active/i);
  assert.throws(() => tools.requestInteraction("late", "旧问题"), /current|cancelled|owns|active/i);
  assert.equal(app.detail(second.workId).work.status, "queued");
});

test("capability scenarios use public protocol helpers and selection is finite before setup", () => {
  for (const id of ["memory", "work", "automations", "skills"]) {
    const source = readFileSync(join(root, `scripts/scenarios/${id}.mjs`), "utf8");
    assert.doesNotMatch(source, /LocalRunner|DatabaseSync|\.app\b|repository|\.prepare\s*\(/);
    assert.doesNotMatch(source, /from\s*["'][^"']*(?:src\/|context\.mjs)/);
    assert.equal(selectScenarios([id])[0].id, id);
  }
  assert.throws(() => selectScenarios([]), /nonempty/);
  assert.throws(() => selectScenarios(["memory", "memory"]), /duplicates/);
  assert.throws(() => selectScenarios(["unknown"]), /Unknown scenario/);
});

for (const scenario of ["memory", "work", "automations", "skills"]) {
  test(`isolated ${scenario} CLI scenario records only its own checks and closes its runner`, async (t) => {
    const directory = join(temporary(t), scenario);
    await exec(
      process.execPath,
      ["scripts/demo-personal-assistant.mjs", "--directory", directory, "--scenario", scenario],
      { cwd: root, timeout: 30000 },
    );
    const result = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
    assert.equal(result.mode, "fixture");
    assert.equal(result.automatedScenarioPassed, true);
    assert.equal(result.productQualityVerified, false);
    assert.equal(result.stopped, true);
    for (const [id, item] of Object.entries(result.scenarios)) {
      assert.equal(item.status, id === scenario ? "passed" : "not_selected");
      assert.equal(item.quality, "unverified");
      assert.ok(item.review);
    }
    assert.ok(Object.keys(result.assertions).length);
    assert.ok(result.transcript.every((m) => m.id.startsWith(`${scenario}:`)));
    assert.equal(existsSync(join(directory, "profile/runner.sock")), false);
  });
}

test("unknown scenario is rejected by real CLI before it creates a directory or loads credentials", async (t) => {
  const directory = join(temporary(t), "invalid");
  await assert.rejects(
    exec(
      process.execPath,
      [
        "scripts/accept-personal-assistant.mjs",
        "--directory",
        directory,
        "--owner",
        "local:test",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-flash",
        "--scenario",
        "unknown",
      ],
      { cwd: root },
    ),
    (error) => {
      assert.match(error.stderr, /Unknown scenario/);
      return true;
    },
  );
  assert.equal(existsSync(directory), false);
});

test("a scenario failure preserves partial evidence, marks later cases not_run and shuts down", async (t) => {
  const directory = join(temporary(t), "failure");
  const script = `import {personalScenario} from './scripts/personal-scenario.mjs'; await personalScenario({directory:process.argv[1],owner:'local:test',mode:'fixture',timeoutMs:1,scenarios:['work','skills']});`;
  await assert.rejects(
    exec(process.execPath, ["--input-type=module", "-e", script, directory], {
      cwd: root,
      timeout: 30000,
    }),
  );
  const result = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
  assert.equal(result.automatedScenarioPassed, false);
  assert.equal(result.scenarios.work.status, "failed");
  assert.equal(result.scenarios.skills.status, "not_run");
  assert.equal(result.scenarios.memory.status, "not_selected");
  assert.equal(result.stopped, true);
  assert.ok(result.scenarios.work.error);
  assert.ok(result.history);
  assert.equal(existsSync(join(directory, "profile/runner.sock")), false);
});

test("missing explicit real-model credential leaves selected cases not_run without service calls", async (t) => {
  const directory = join(temporary(t), "no-credential");
  const environment = { ...process.env };
  delete environment.DEEPSEEK_API_KEY;
  await assert.rejects(
    exec(
      process.execPath,
      [
        "scripts/accept-personal-assistant.mjs",
        "--directory",
        directory,
        "--owner",
        "local:test",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-flash",
        "--scenario",
        "skills",
      ],
      { cwd: root, env: environment },
    ),
  );
  const result = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
  assert.match(result.error, /explicit API key/);
  assert.equal(result.scenarios.skills.status, "not_run");
  assert.equal(result.configuration.actualModelRequestPerformed, false);
  assert.equal(result.stopped, true);
  assert.equal(existsSync(join(directory, "profile/assistant.sqlite")), false);
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initProfile } from "../src/adapters/local/profile.mjs";
import { inspectLocalConfiguration } from "../src/runtime/local-diagnostics.mjs";
import { createScenarioContext } from "./scenarios/context.mjs";
import { selectScenarios, scenarioCatalog } from "./scenarios/catalog.mjs";

/** Evidence orchestration only; each capability scenario owns its assertions. */
export async function personalScenario({
  directory,
  owner,
  mode,
  model,
  timeoutMs = 120000,
  scenarios,
}) {
  const selected = selectScenarios(scenarios);
  const path = resolve(directory);
  mkdirSync(path, { mode: 0o700 }); // Existing paths are deliberately rejected.
  const materials = join(path, "materials");
  mkdirSync(materials, { mode: 0o700 });
  const source =
    "项目：青松。唯一已确认里程碑：本周完成导入接口。待跟进：核对权限。下周计划不属于本周进展。";
  writeFileSync(join(materials, "project.md"), source, { mode: 0o600 });
  const profile = initProfile(join(path, "profile"), owner, {
    mode,
    model,
    workspace: materials,
    concurrency: 1,
    ...(mode === "fixture" ? { memoryPolicy: { debounceMs: 0 } } : {}),
  });
  const evidence = {
    at: new Date().toISOString(),
    mode,
    profile: profile.path,
    source,
    assertions: {},
    transcript: [],
    productQualityVerified: false,
    stage: "development",
  };

  evidence.scenarios = Object.fromEntries(
    scenarioCatalog.map((s) => [
      s.id,
      {
        status: selected.includes(s) ? "not_run" : "not_selected",
        assertions: {},
        quality: "unverified",
        review: s.review,
      },
    ]),
  );
  evidence.coverage = {
    attentionAging:
      "not_run; covered by controlled-clock tests, not this real-time scenario",
    typedSensitiveWait: "not_run; no remote authentication fixture substituted",
    changedNotificationMeaning:
      "exact-text mechanism only; semantic novelty unverified",
  };
  const context = createScenarioContext({ profile, evidence, timeoutMs });
  try {
    evidence.configuration = await inspectLocalConfiguration(profile);
    if (mode === "model" && !evidence.configuration.credential?.present)
      throw new Error(
        "The selected provider needs its explicit API key in this process environment",
      );
    await context.open();
    for (const scenario of selected) {
      const item = evidence.scenarios[scenario.id];
      item.status = "running";
      item.startedAt = new Date().toISOString();
      try {
        await scenario.run(context.forScenario(scenario.id));
        item.status = "passed";
      } catch (error) {
        item.status = "failed";
        item.error = String(error);
        throw error;
      } finally {
        item.finishedAt = new Date().toISOString();
      }
    }
    evidence.automatedScenarioPassed = true;
  } catch (error) {
    evidence.automatedScenarioPassed = false;
    evidence.error = String(error);
    process.exitCode = 1;
  } finally {
    // Capture failures as evidence even if a diagnostic query or shutdown also fails.
    try {
      await context.capture();
    } catch (error) {
      evidence.captureError = String(error);
      evidence.automatedScenarioPassed = false;
      process.exitCode = 1;
    }
    try {
      await context.close();
      evidence.stopped = true;
    } catch (error) {
      evidence.closeError = String(error);
      evidence.stopped = false;
      evidence.automatedScenarioPassed = false;
      process.exitCode = 1;
    }
    writeFileSync(
      join(path, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify(
      {
        directory: path,
        mode,
        automatedScenarioPassed: evidence.automatedScenarioPassed,
        scenarios: evidence.scenarios,
        assertions: evidence.assertions,
        error: evidence.error,
        productQualityVerified: false,
      },
      null,
      2,
    ),
  );
  return evidence;
}

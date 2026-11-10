import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const files = ["copilot-host.json", "amp-host.json"];
const directory = resolve("design/agent-bridge/recordings/p3c");

for (const file of files) {
  test(`${file} keeps the limitations that make the real run honest`, async () => {
    const text = await readFile(resolve(directory, file), "utf8");
    const evidence = JSON.parse(text);
    assert.equal(evidence.schemaVersion, 1);
    assert.doesNotMatch(text, /\/data\/|\/root\//u);
    assert(Array.isArray(evidence.gaps));
    const gaps = evidence.gaps.join("\n");
    assert.match(gaps, /local test process backend/u);
    assert.match(gaps, /History replay is not yet projected/u);
    assert.match(gaps, /Elicitation and model\/list have no Web UI/u);
    const notes = evidence.notes.join("\n");
    assert.match(notes, /admission only/u);
    assert.match(notes, /modelList\.current was captured before/u);
    assert.equal(evidence.profile.modelSelection, file.startsWith("copilot") ? "claude-haiku-4.5" : "low");
    assert((evidence.session.models?.availableModels?.length ?? evidence.session.configOptions?.length ?? 0) > 0);
    assert.equal(evidence.steer.disposition, evidence.steer.delivery.value === "native-inject" ? "steered" : "next-turn");
  });
}

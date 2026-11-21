import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { localBuildInputs, resolveElectronArtifactRun } from "../../scripts/ci/resolve-electron-artifact-run.mjs";

const repository = "owner/repo";
const local = { "vendor/electron/fork.json": "fork-current", "vendor/electron/args.gn": "args-current" };

function fixture(runs, { artifacts = {}, blobs = {} } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push(path);
    const runsPage =
      /\/actions\/workflows\/electron-native-artifacts\.yml\/runs\?status=success&per_page=50&page=(\d+)$/u.exec(path);
    if (runsPage) return { workflow_runs: runsPage[1] === "1" ? runs : [] };
    const runArtifacts = /\/actions\/runs\/(\d+)\/artifacts\?name=(.+)$/u.exec(path);
    if (runArtifacts)
      return {
        artifacts: artifacts[runArtifacts[1]] ?? [{ name: decodeURIComponent(runArtifacts[2]), expired: false }],
      };
    const content = /\/contents\/(.+)\?ref=(.+)$/u.exec(path);
    if (content) {
      const key = `${content[2]}:${content[1]}`;
      const sha = key in blobs ? blobs[key] : local[content[1]];
      if (sha === null) {
        assert.equal(options.optional, true);
        return null;
      }
      return { sha };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const run = (id, overrides = {}) => ({
  id,
  conclusion: "success",
  head_branch: "main",
  head_sha: `sha-${id}`,
  head_repository: { full_name: repository },
  ...overrides,
});

const resolve = (api, extra = {}) =>
  resolveElectronArtifactRun({
    target: "linux-x64",
    repository,
    defaultBranch: "main",
    currentBranch: "feature",
    local,
    api,
    ...extra,
  });

test("the newest run built from this fork definition and build arguments wins", async () => {
  const { api } = fixture([run(30), run(20), run(10)], {
    blobs: { "sha-30:vendor/electron/fork.json": "fork-next", "sha-20:vendor/electron/args.gn": "args-old" },
  });
  assert.equal(await resolve(api), 10);
});

test("runs from other branches or repositories, failures and expired artifacts are skipped", async () => {
  const { api } = fixture(
    [
      run(60, { head_branch: "someone-else" }),
      run(50, { head_repository: { full_name: "fork/repo" } }),
      run(40, { conclusion: "failure" }),
      run(30),
      run(20, { head_branch: "feature" }),
    ],
    { artifacts: { 30: [{ name: "opencraft-electron-linux-x64", expired: true }] } },
  );
  assert.equal(await resolve(api), 20);
});

test("a fork definition missing at a run's commit does not match", async () => {
  const { api } = fixture([run(20), run(10)], { blobs: { "sha-20:vendor/electron/args.gn": null } });
  assert.equal(await resolve(api), 10);
});

test("only the requested target's artifact qualifies a run", async () => {
  const artifacts = { 20: [], 10: [{ name: "opencraft-electron-linux-x64", expired: false }] };
  const macos = fixture([run(20), run(10)], { artifacts });
  await assert.rejects(resolve(macos.api, { target: "macos-arm64" }), /No successful/u);
  assert.ok(macos.calls.some((path) => path.endsWith("/runs/20/artifacts?name=opencraft-electron-macos-arm64")));
  const linux = fixture([run(20), run(10)], { artifacts });
  assert.equal(await resolve(linux.api), 10);
});

test("no qualifying run explains how to produce one", async () => {
  const { api } = fixture([run(10)], { blobs: { "sha-10:vendor/electron/fork.json": "fork-old" } });
  await assert.rejects(resolve(api), (error) => {
    assert.match(error.message, /mode build, target linux-x64/u);
    assert.match(error.message, /OPENCRAFT_ELECTRON_ARTIFACT_RUN_ID/u);
    assert.match(error.message, /10: different vendor\/electron\/fork\.json/u);
    return true;
  });
});

test("an unsupported target is refused before any request", async () => {
  const { api, calls } = fixture([run(10)]);
  await assert.rejects(resolve(api, { target: "linux-arm64" }), /Unsupported/u);
  assert.deepEqual(calls, []);
});

test("local build inputs are the checkout's Git blob IDs", () => {
  const inputs = localBuildInputs();
  assert.deepEqual(Object.keys(inputs), ["vendor/electron/fork.json", "vendor/electron/args.gn"]);
  for (const id of Object.values(inputs)) assert.match(id, /^[0-9a-f]{40}$/u);
});

test("the native build exports no TARGET variable, which Chromium bindgen rejects", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/electron-native-artifacts.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /^\s+TARGET:/mu);
  assert.match(workflow, /^\s+NATIVE_TARGET: \$\{\{ matrix\.id \}\}/mu);
});

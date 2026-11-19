import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const entry = resolve("scripts/fast-release/release.sh"),
  publisher = resolve("scripts/fast-release/publish.sh");
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  throw Error("Release fixture timed out");
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-flow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, "deploy.lock"),
    plan = join(root, "plan.json"),
    build = join(root, "build.mjs"),
    capture = join(root, "capture.mjs"),
    shim = join(root, "node.sh");
  writeFileSync(
    build,
    `import fs from 'node:fs';const r=process.env.FLOW_ROOT;fs.writeFileSync(r+'/build.marker','built');if(process.argv[2]==='fail')process.exit(7);fs.writeFileSync(r+'/candidate.yaml','original candidate');fs.writeFileSync(r+'/plan.json',JSON.stringify({schemaVersion:1,sourceRevision:'original-source',candidateOverride:r+'/candidate.yaml'}));`,
  );
  writeFileSync(
    capture,
    `import fs from 'node:fs';import assert from 'node:assert/strict';const path=process.argv[3],p=JSON.parse(fs.readFileSync(path));assert.match(fs.readFileSync('/proc/self/fdinfo/9','utf8'),/FLOCK\\s+ADVISORY\\s+WRITE/);fs.writeFileSync(process.env.FLOW_ROOT+'/published.json',JSON.stringify({path,plan:p,override:fs.readFileSync(p.candidateOverride,'utf8')}));`,
  );
  writeFileSync(
    shim,
    '#!/bin/bash\nset -eu\nif [[ "$1" == */publish.mjs ]]; then exec "$FLOW_REAL_NODE" "$FLOW_CAPTURE" "$@"; fi\nexec "$FLOW_REAL_NODE" "$@"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    OPENCRAFT_NODE: shim,
    FLOW_ROOT: root,
    FLOW_REAL_NODE: process.execPath,
    FLOW_CAPTURE: capture,
    OPENCRAFT_DEPLOY_WAIT_SECONDS: "5",
  };
  const args = [entry, plan, lock, "--", process.execPath, build];
  return {
    root,
    lock,
    plan,
    build,
    env,
    args,
    run(extra = []) {
      return spawnSync("bash", [...args, ...extra], { env, encoding: "utf8" });
    },
  };
}
test("builds while another publisher owns the lock, then publishes only sealed inputs", async (t) => {
  const f = fixture(t),
    holder = spawn("flock", [f.lock, "sh", "-c", "echo held; read line"], { stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const child = spawn("bash", f.args, { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => {
    child.kill();
    holder.kill();
  });
  await until(() =>
    readdirSync(f.root).some((name) => name.startsWith(".prepared-") && existsSync(join(f.root, name, "plan.json"))),
  );
  assert.ok(existsSync(join(f.root, "build.marker")), "build must finish while a different publisher holds the lease");
  assert.equal(existsSync(join(f.root, "published.json")), false);
  writeFileSync(
    f.plan,
    JSON.stringify({ schemaVersion: 1, sourceRevision: "changed", candidateOverride: join(f.root, "candidate.yaml") }),
  );
  writeFileSync(join(f.root, "candidate.yaml"), "changed after preparation");
  holder.stdin.end("\n");
  assert.equal(await exit, 0, stderr);
  const value = JSON.parse(readFileSync(join(f.root, "published.json")));
  assert.equal(value.plan.sourceRevision, "original-source");
  assert.equal(value.override, "original candidate");
  assert.notEqual(value.path, f.plan);
  assert.equal(statSync(value.path).mode & 0o777, 0o400);
  assert.equal(statSync(value.plan.candidateOverride).mode & 0o777, 0o400);
});
for (const fd of [8, 9])
  test(`rejects a build that inherited deployment ownership on fd ${fd}`, (t) => {
    const f = fixture(t);
    const script = `exec ${fd}>"$1"; flock ${fd}; shift; exec bash "$@"`;
    const result = spawnSync("bash", ["-c", script, "fixture", f.lock, ...f.args], { env: f.env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build inherited the deployment lock/);
    assert.equal(existsSync(join(f.root, "build.marker")), false);
  });
test("failed builds never acquire deployment ownership or publish a partial candidate", (t) => {
  const f = fixture(t),
    result = f.run(["fail"]);
  assert.equal(result.status, 7);
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith(".prepared-")),
    false,
  );
  assert.equal(existsSync(join(f.root, "published.json")), false);
  assert.equal(spawnSync("flock", ["-n", f.lock, "true"]).status, 0);
});
test("invalid queue budgets are rejected before any publisher invocation", (t) => {
  const f = fixture(t);
  writeFileSync(f.plan, "{}");
  const result = spawnSync("bash", [publisher, f.plan, f.lock], {
    encoding: "utf8",
    env: { ...f.env, OPENCRAFT_DEPLOY_WAIT_SECONDS: "1801" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /0\.\.1800/);
  assert.equal(existsSync(join(f.root, "published.json")), false);
});

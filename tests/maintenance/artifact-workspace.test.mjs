import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { withArtifactWorkspace } from "../../scripts/maintenance/artifact-workspace.mjs";
import { dockerReferences } from "../../scripts/maintenance/artifact-retention.mjs";

const execute = promisify(execFile);
for (const fail of [false, true]) {
  test(`temporary artifact workspace is outside checkout and removed on ${fail ? "failure" : "success"}`, async () => {
    let directory;
    const action = withArtifactWorkspace(async path => {
      directory = path;
      assert.equal(path.startsWith(`${tmpdir()}/opencraft-artifacts-`), true);
      await writeFile(join(path, "image.zip"), "download");
      if (fail) throw new Error("acceptance failed");
      return "verified";
    });
    if (fail) await assert.rejects(action, /acceptance failed/);
    else assert.equal(await action, "verified");
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  });
}

test("CLI provides a scratch directory to the producer and preserves failure status while cleaning", async t => {
  const evidence = await mkdtemp(join(tmpdir(), "opencraft-artifact-test-"));
  t.after(() => rm(evidence, { recursive: true, force: true }));
  const receipt = join(evidence, "path");
  await assert.rejects(execute(process.execPath, [
    new URL("../../scripts/maintenance/artifact-workspace.mjs", import.meta.url).pathname, "--", process.execPath, "-e",
    "require('fs').writeFileSync(process.argv[1],process.env.OPENCRAFT_ARTIFACT_WORKSPACE);process.exit(7)", receipt,
  ]), { code: 7 });
  await assert.rejects(lstat(await readFile(receipt, "utf8")), { code: "ENOENT" });
});

test("Docker references include bind sources without exposing container environment", async () => {
  const calls = [];
  const state = await dockerReferences(async (command, args) => {
    calls.push([command, ...args]);
    return { stdout: args[0] === "ps" ? "abc\ndef\n" : '[{"Type":"bind","Source":"/releases/old/web"}]\n[{"Type":"volume","Source":"/volume"}]\n' };
  });
  assert.deepEqual(state, { roots: ["/releases/old/web"], unknown: false });
  assert.deepEqual(calls[1], ["docker", "inspect", "--format", "{{json .Mounts}}", "abc", "def"]);
});

for (const code of ["ENOENT", "EACCES", 1]) {
  test(`Docker probe ${code} ${code === "ENOENT" ? "allows proc-only hosts" : "retains unknown mounts"}`, async () => {
    const state = await dockerReferences(async () => { throw Object.assign(new Error("failure"), { code }); });
    assert.equal(state.unknown, code !== "ENOENT");
  });
}

test("CLI forwards termination, waits for its consumer, and removes the workspace", async t => {
  const evidence = await mkdtemp(join(tmpdir(), "opencraft-artifact-signal-"));
  t.after(() => rm(evidence, { recursive: true, force: true }));
  const receipt = join(evidence, "path");
  const child = spawn(process.execPath, [
    new URL("../../scripts/maintenance/artifact-workspace.mjs", import.meta.url).pathname, "--", process.execPath, "-e",
    "require('fs').writeFileSync(process.argv[1],process.env.OPENCRAFT_ARTIFACT_WORKSPACE);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);console.log('ready')", receipt,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const closed = once(child, "close");
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null]);
  await assert.rejects(lstat(await readFile(receipt, "utf8")), { code: "ENOENT" });
});

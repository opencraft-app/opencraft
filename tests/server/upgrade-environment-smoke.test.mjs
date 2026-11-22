import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/smoke/server/smoke-upgrade-environment.mjs", import.meta.url));

async function fixture(t, { identity = {}, dependencies = { worker: "ready" }, transportFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "upgrade-environment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const sh = async (name, body) => writeFile(join(bin, name), "#!/bin/sh\nset -eu\n" + body + "\n", { mode: 0o755 });
  await sh(
    "ssh",
    transportFailure
      ? "echo fixture-private-diagnostic >&2; exit 1"
      : 'for arg do command="$arg"; done\nexec /bin/sh -c "$command"',
  );
  await sh("systemctl", "printf 'ActiveState=active\\nNRestarts=2\\n'");
  await sh("journalctl", 'printf \'{"MESSAGE":"fixture-private-journal"}\\n\'');
  await sh("docker", "printf 'running 3 sha256:fixture fixture-revision\\n'");
  const program = join(root, "core.mjs");
  await writeFile(
    program,
    `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(request.url === '/health' ? {
    ok: true, core: { pid: process.pid }, version: 'fixture-version', buildId: 'fixture-build',
    dependencies: ${JSON.stringify(dependencies)},
  } : { sourceRevision: 'fixture-web-revision', buildId: 'fixture-web-build' }));
});
server.listen(0, '127.0.0.1', () => process.send(server.address().port));
`,
  );
  const core = spawn(process.execPath, [program], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise((resolve) => core.once("exit", resolve));
  t.after(async () => {
    core.kill();
    await closed;
  });
  const port = await new Promise((resolve, reject) => {
    core.once("message", resolve);
    core.once("error", reject);
  });
  const coreSha256 = createHash("sha256")
    .update(await readFile(program))
    .digest("hex");
  const config = join(root, "probe.json");
  const output = join(root, "report.json");
  await writeFile(
    config,
    JSON.stringify({
      sshAlias: "owned-fixture",
      port,
      coreProgram: program,
      units: ["fixture.service"],
      containers: ["fixture-container"],
      since: "1 hour ago",
      expectedIdentity: { buildId: "fixture-build", coreSha256, ...identity },
    }),
  );
  async function run() {
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH };
    delete env.BASH_ENV;
    const child = spawn(process.execPath, [script, config, output], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(15000),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { code, stdout, stderr };
  }
  return { run, output, coreSha256 };
}

test("environment probe hashes the live program and reports bounded counters without private diagnostics", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr + (await readFile(f.output, "utf8")));
  const raw = await readFile(f.output, "utf8");
  const report = JSON.parse(raw);
  assert.equal(report.checks.runtimeIdentity.evidence.coreSha256, f.coreSha256);
  assert.equal(report.checks.runtimeIdentity.evidence.webBuildId, "fixture-web-build");
  assert.equal(report.checks.serviceCounters.evidence["fixture.service"].journalErrors, 1);
  assert.equal(report.checks.serviceCounters.evidence["fixture.service"].restarts, 2);
  assert.equal(report.checks.serviceCounters.evidence["fixture-container"].restarts, 3);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.doesNotMatch(raw + result.stdout + result.stderr, /fixture-private|MESSAGE|cmdline/);
});

test("an unexpected live build fails identity while retaining successful health evidence", async (t) => {
  const f = await fixture(t, { identity: { buildId: "different-build" } });
  const result = await f.run();
  assert.equal(result.code, 1);
  const { checks } = JSON.parse(await readFile(f.output, "utf8"));
  assert.equal(checks.runtimeIdentity.status, "fail");
  assert.equal(checks.health.status, "pass");
});

test("a dependency which is not ready fails acceptance even when the process identity matches", async (t) => {
  const f = await fixture(t, { dependencies: { worker: "starting" } });
  const result = await f.run();
  assert.equal(result.code, 1);
  const { checks } = JSON.parse(await readFile(f.output, "utf8"));
  assert.equal(checks.health.status, "fail");
  assert.equal(checks.runtimeIdentity.status, "pass");
});

test("SSH failure is redacted and cannot overwrite an earlier report", async (t) => {
  const f = await fixture(t, { transportFailure: true });
  const result = await f.run();
  assert.equal(result.code, 1);
  const raw = await readFile(f.output, "utf8");
  assert.equal(JSON.parse(raw).checks.transport.status, "fail");
  assert.doesNotMatch(raw + result.stdout + result.stderr, /fixture-private/);
  assert.equal((await f.run()).code, 1);
  assert.equal(await readFile(f.output, "utf8"), raw);
});

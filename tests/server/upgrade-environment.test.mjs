import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../../scripts/smoke/upgrade-environment.mjs", import.meta.url));
// Only the SSH/process/proc boundaries are simulated. The actual Python probe
// performs real loopback HTTP, hashes an actual fixture file, and emits its report.
const ssh = `#!/usr/bin/python3
import sys,os,json,shlex,io,builtins,subprocess
raw=sys.stdin.read()
with open(os.environ['TEST_CAPTURE'],'w') as f:json.dump({'argv':sys.argv[1:],'input':json.loads(raw)},f)
if os.environ.get('TEST_OUTPUT'):
 print(os.environ['TEST_OUTPUT']);sys.exit(0)
if os.environ.get('TEST_BROKEN'):
 print('synthetic-private-transport-content');sys.stderr.write('synthetic-private-stderr');sys.exit(1)
command=shlex.split(sys.argv[-1])
assert command[:2]==['python3','-c'] and len(command)==3
real_open=builtins.open
root=os.environ['TEST_PROBE_ROOT']
def opened(path,*args,**kwargs):
 if path=='/proc/999999/cmdline':path=root+'/cmdline'
 elif path=='/proc/999999/root/fixture/core.cjs':path=root+'/core.cjs'
 return real_open(path,*args,**kwargs)
builtins.open=opened
def output(args,**kwargs):
 if args[:4]==('systemctl','show','--property=ActiveState,NRestarts','--'):return 'ActiveState=active\\nNRestarts=2\\n'
 if args[0]=='journalctl':return '{}\\n{}\\n'
 if args[:2]==('docker','inspect'):return 'running 0 sha256:fixture fixture-source\\n'
 raise ValueError('Unexpected process probe')
subprocess.check_output=output
sys.stdin=io.StringIO(raw)
exec(compile(command[2],'<actual-environment-probe>','exec'),{'__name__':'__main__'})
`;
async function fixture(t, { health = true, expected = {}, broken = false, output, probeEntry = entry } = {}) {
  const root = await mkdtemp(join(tmpdir(), "upgrade-environment-"));
  const bin = join(root, "bin"),
    capture = join(root, "capture.json"),
    report = join(root, "report.json"),
    configPath = join(root, "config.json");
  await mkdir(bin);
  await writeFile(join(bin, "ssh"), ssh, { mode: 0o700 });
  const program = Buffer.from("synthetic core fixture\n");
  await writeFile(join(root, "core.cjs"), program);
  await writeFile(join(root, "cmdline"), Buffer.from("node\0/fixture/core.cjs\0synthetic-private-argv\0"));
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? {
              ok: health,
              version: "fixture",
              buildId: "fixture-build",
              core: { pid: 999999 },
              dependencies: { core: "ready" },
            }
          : { sourceRevision: "fixture-source", buildId: "fixture-web" },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    sshAlias: "fixture-target",
    port: server.address().port,
    coreProgram: "/fixture/core.cjs",
    units: ["fixture-hands.service"],
    containers: ["fixture-hands"],
    since: "10 minutes ago",
    testPrivateCredential: "synthetic-private-config",
    expectedIdentity: { coreSha256: createHash("sha256").update(program).digest("hex"), ...expected },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const run = async () => {
    try {
      return {
        ...(await exec(process.execPath, [probeEntry, configPath, report], {
          env: {
            ...process.env,
            PATH: bin + ":" + process.env.PATH,
            TEST_CAPTURE: capture,
            TEST_PROBE_ROOT: root,
            ...(broken ? { TEST_BROKEN: "1" } : {}),
            ...(output === undefined ? {} : { TEST_OUTPUT: JSON.stringify(output) }),
          },
          timeout: 15000,
        })),
        code: 0,
      };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { root, config, configPath, report, capture, run };
}

test("environment smoke uses the configured SSH alias and actual bounded probe; reports identity and counters without argv/config disclosure", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(f.report, "utf8")),
    captured = JSON.parse(await readFile(f.capture, "utf8"));
  assert.deepEqual(captured.argv.slice(0, -1), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "--",
    "fixture-target",
  ]);
  assert.equal(captured.input.testPrivateCredential, "synthetic-private-config");
  assert.equal(report.checks.runtimeIdentity.evidence.coreSha256, f.config.expectedIdentity.coreSha256);
  assert.equal(report.checks.runtimeIdentity.evidence.webSourceRevision, "fixture-source");
  assert.equal(report.checks.serviceCounters.evidence["fixture-hands.service"].restarts, 2);
  assert.equal(report.checks.serviceCounters.evidence["fixture-hands.service"].journalErrors, 2);
  assert.equal(report.checks.serviceCounters.evidence["fixture-hands"].sourceRevision, "fixture-source");
  assert.ok(Object.values(report.checks).every((check) => check.status === "pass"));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-argv|synthetic-private-config|coreProgram/);
  assert.equal((await stat(f.report)).mode & 0o777, 0o600);
});

test("a mismatched actual core hash fails acceptance without changing the remote target", async (t) => {
  const f = await fixture(t, { expected: { coreSha256: "0".repeat(64) } });
  assert.equal((await f.run()).code, 1);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.checks.runtimeIdentity.status, "fail");
  assert.equal(report.checks.health.status, "pass");
});

test("HTTP health failure is distinct from a readable runtime identity", async (t) => {
  const f = await fixture(t, { health: false });
  assert.equal((await f.run()).code, 1);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.checks.health.status, "fail");
  assert.equal(report.checks.runtimeIdentity.status, "pass");
});

test("unconfirmed SSH/probe output records only a safe failure category", async (t) => {
  const f = await fixture(t, { broken: true }),
    result = await f.run();
  assert.equal(result.code, 1);
  const raw = await readFile(f.report, "utf8");
  assert.doesNotMatch(
    raw + result.stdout + result.stderr,
    /synthetic-private-transport-content|synthetic-private-stderr|synthetic-private-config/,
  );
  assert.deepEqual(JSON.parse(raw).checks, {
    transport: { status: "fail", evidence: { reason: "Target probe failed or timed out" } },
  });
});

for (const alias of ["-oProxyCommand=bad", "user@host", "host;echo bad"])
  test(`invalid SSH selector ${JSON.stringify(alias)} fails before opening a transport`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.configPath, JSON.stringify({ ...f.config, sshAlias: alias }));
    assert.notEqual((await f.run()).code, 0);
    await assert.rejects(stat(f.capture), { code: "ENOENT" });
    await assert.rejects(stat(f.report), { code: "ENOENT" });
  });

test("environment smoke never overwrites an earlier acceptance receipt", async (t) => {
  const f = await fixture(t);
  await writeFile(f.report, "preserved-report");
  assert.notEqual((await f.run()).code, 0);
  assert.equal(await readFile(f.report, "utf8"), "preserved-report");
});

test("the full runtime image recipe installs reviewed guest dependencies before switching to its unprivileged user", async () => {
  // source-contract: Dockerfile is the build input being validated, not a product source-code spelling proxy. Actual image builds are CI-owned.
  const recipe = await readFile(new URL("../../deploy/docker/Dockerfile", import.meta.url), "utf8");
  const runtime = recipe.slice(recipe.indexOf("AS runtime"));
  assert.match(
    runtime,
    /apt-get install[^;]*python3/u,
    "Workspace artifact and mount helpers need the interpreter in the runtime, not only the build stage",
  );
  const install = recipe.indexOf("RUN /bin/sh /usr/local/share/opencraft/install-sandbox-deps.sh");
  assert.ok(install > recipe.indexOf("COPY deploy/docker/install-sandbox-deps.sh"));
  assert.ok(install < recipe.indexOf("USER ${OPENCRAFT_UID}:${OPENCRAFT_GID}"));
});

for (const output of [
  {},
  null,
  { health: { status: "pass", evidence: {} } },
  {
    health: { status: "pass", evidence: {} },
    runtimeIdentity: { status: "unknown", evidence: {} },
    serviceCounters: { status: "pass", evidence: {} },
  },
])
  test(`incomplete or malformed probe receipt cannot become an acceptance success: ${JSON.stringify(output)}`, async (t) => {
    const f = await fixture(t, { output });
    assert.equal((await f.run()).code, 1);
    const report = JSON.parse(await readFile(f.report, "utf8"));
    assert.equal(report.checks.transport.status, "fail");
  });

test("the domain entry rejects an empty SSH receipt instead of accepting zero checks", async (t) => {
  const f = await fixture(t, {
    output: {},
    probeEntry: fileURLToPath(new URL("../../scripts/smoke/server/smoke-upgrade-environment.mjs", import.meta.url)),
  });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(await readFile(f.report, "utf8")).checks.transport.status, "fail");
});

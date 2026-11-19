import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxEnvironment } from "@opencraft/sandbox";
import {
  createExecutionRuntimePreparer,
  executionRuntimeArtifact,
} from "../../packages/sandbox-node/src/execution-runtime-bootstrap";
function fixture(source = "template", code = 0, diagnostic?: unknown) {
  let calls = 0,
    allowed = true;
  const sandbox: Pick<SandboxEnvironment, "spawn"> = {
    async spawn(command, output) {
      calls++;
      assert.equal(command.cwd, "/tmp");
      assert.deepEqual(JSON.parse(command.command[3]!), executionRuntimeArtifact);
      const executable =
        source === "template"
          ? "/opt/opencraft-codex/package/vendor/x86_64-unknown-linux-musl/bin/codex"
          : source === "temporary" || source === "shared-cache"
            ? "/tmp/opencraft-runtime-abcdef/package/vendor/x86_64-unknown-linux-musl/bin/codex"
            : "/workspace/untrusted";
      output?.({
        stream: "stdout",
        data: Buffer.from(JSON.stringify(diagnostic ?? { source, executable, version: "0.162.1", extra: "discard" })),
      });
      return {
        kind: "process",
        id: "test",
        exited: Promise.resolve({ code }),
        async writeStdin() {},
        async closeStdin() {},
        async terminate() {},
      };
    },
  };
  const runtime = createExecutionRuntimePreparer({
    sandbox,
    async authorize() {
      if (!allowed) throw Error("revoked");
    },
    onCleanupUnconfirmed() {
      throw Error("unexpected");
    },
  });
  return {
    runtime,
    get calls() {
      return calls;
    },
    deny() {
      allowed = false;
    },
  };
}
test("concurrent preparation uses one process and returns only runtime receipt", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.runtime.prepare(), f.runtime.prepare()]);
  assert.deepEqual(a, b);
  assert.equal(f.calls, 1);
  assert.deepEqual(Object.keys(a).sort(), ["executable", "source", "version"]);
});
test("temporary installation is explicitly identified", async () => {
  assert.equal((await fixture("temporary").runtime.prepare()).source, "temporary");
});
test("failed preparation is not silently retried", async () => {
  const f = fixture("template", 1);
  await assert.rejects(f.runtime.prepare());
  await assert.rejects(f.runtime.prepare());
  assert.equal(f.calls, 1);
});
test("cached success never bypasses current authorization", async () => {
  const f = fixture();
  await f.runtime.prepare();
  f.deny();
  await assert.rejects(f.runtime.prepare(), /revoked/);
  assert.equal(f.calls, 1);
});
test("untrusted paths fail closed", async () => {
  await assert.rejects(fixture("other").runtime.prepare(), /invalid_receipt/);
});

test("runtime diagnostics expose only safe stage and category", async () => {
  await assert.rejects(
    fixture("template", 1, {
      stage: "download",
      category: "TimeoutError",
      detail: "sensitive payload",
    }).runtime.prepare(),
    /^Error: runtime_preparation_failed:download:TimeoutError$/,
  );
  await assert.rejects(
    fixture("template", 1, { stage: "https://secret.invalid", category: "sensitive payload" }).runtime.prepare(),
    /^Error: runtime_preparation_failed$/,
  );
});

test("shared cache still yields a private temporary executable receipt", async () => {
  const r = await fixture("shared-cache").runtime.prepare();
  assert.equal(r.source, "shared-cache");
  assert.match(r.executable, /^\/tmp\/opencraft-runtime-/);
});

test("Python bootstrap validates shared archive and extracts privately without network", async () => {
  const { mkdtemp, rm, writeFile, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { executionRuntimeBootstrapScript } =
    await import("../../packages/sandbox-node/src/execution-runtime-bootstrap");
  const root = await mkdtemp(join(tmpdir(), "runtime-cache-test-"));
  let extracted: string | undefined;
  try {
    const archive = join(root, "runtime.tgz");
    const { stdout: hash } = await run("/usr/bin/python3", [
      "-c",
      `import tarfile,io,sys,hashlib,base64
p=sys.argv[1];data=b'#!/bin/sh\\nprintf "codex-cli 0.162.1\\\\n"\\n'
with tarfile.open(p,'w:gz') as t:
 m=tarfile.TarInfo('package/vendor/x86_64-unknown-linux-musl/bin/codex');m.size=len(data);m.mode=0o755;t.addfile(m,io.BytesIO(data))
print(base64.b64encode(hashlib.sha512(open(p,'rb').read()).digest()).decode())`,
      archive,
    ]);
    const pin = {
      ...executionRuntimeArtifact,
      cacheArchive: archive,
      sha512: hash.trim(),
      url: "http://127.0.0.1:1/network-must-not-run",
    };
    const { stdout } = await run("/usr/bin/python3", ["-c", executionRuntimeBootstrapScript, JSON.stringify(pin)]);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.source, "shared-cache");
    assert.match(receipt.executable, /^\/tmp\/opencraft-runtime-[^/]+\/package\//);
    extracted = receipt.executable.split("/").slice(0, 3).join("/");
    assert.equal((await run(receipt.executable, ["--version"])).stdout.trim(), "codex-cli 0.162.1");
    await writeFile(archive, "corrupt");
    await assert.rejects(
      run("/usr/bin/python3", ["-c", executionRuntimeBootstrapScript, JSON.stringify(pin)]),
      (e: any) => JSON.parse(e.stdout).stage === "integrity",
    );
    const linked = join(root, "linked.tgz");
    await symlink(archive, linked);
    await assert.rejects(
      run("/usr/bin/python3", [
        "-c",
        executionRuntimeBootstrapScript,
        JSON.stringify({ ...pin, cacheArchive: linked }),
      ]),
      (e: any) => JSON.parse(e.stdout).stage === "cache",
    );
  } finally {
    if (extracted) await rm(extracted, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { quoteSftpPath, SshFileTransfer } from "../apps/opencraft-daemon/src/ssh-file-transfer.js";

test("SFTP paths quote spaces, quotes and backslashes; line injection is rejected", () => {
  assert.equal(quoteSftpPath('/a/"quoted"\\ name'), '"/a/\\"quoted\\"\\\\ name"');
  for (const path of ["", "/a\nrm x", "/a\r", "/a\0"]) assert.throws(() => quoteSftpPath(path));
});

test("SFTP saved password/trust, real batch put/rename/get and askpass cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-file-transfer-"));
  const helpers: string[] = [];
  const transfer = new SshFileTransfer({ connection: {
    hostname: "fixture.invalid", port: 36000, username: "fixture", knownHostsFile: "/synthetic/known_hosts",
    authentication: { kind: "password", resolvePassword: async () => "synthetic-password" },
  }, spawnSftp: (args, env) => {
    assert.ok(args.includes("BatchMode=no"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("UserKnownHostsFile=/synthetic/known_hosts"));
    assert.ok(!JSON.stringify([args, env]).includes("synthetic-password"));
    helpers.push(env.SSH_ASKPASS!);
    assert.ok(args.includes("-S"), "Password authentication requires the private ssh batch wrapper");
    return spawn(process.execPath, [new URL("./fixtures/fake-sftp.mjs", import.meta.url).pathname], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...env, FIXTURE_SFTP_PASSWORD: "1" },
    });
  } });
  try {
    const source = join(root, '报告 "1" \\文档.bin'), part = join(root, ".part"), target = join(root, "remote.bin"), downloaded = join(root, "downloaded.bin");
    await writeFile(source, Buffer.from([0, 255, 4, 0]));
    await transfer.upload(source, part); await transfer.commit(part, target); await transfer.download(target, downloaded);
    assert.deepEqual(await readFile(downloaded), await readFile(source));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    for (const helper of helpers) await assert.rejects(access(helper));
  } finally { await transfer.close(); await rm(root, { recursive: true, force: true }); }
});

test("SFTP failure and cancellation do not expose raw stderr or leave processes running", async () => {
  for (const silent of [false, true]) {
    const transfer = new SshFileTransfer({ timeoutMs: 150, connection: { hostname: "fixture.invalid", port: 22, username: "fixture",
      knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" } }, spawnSftp: (_args, env) =>
      spawn(process.execPath, [new URL("./fixtures/fake-sftp.mjs", import.meta.url).pathname], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...env, ...(silent ? { FIXTURE_SFTP_SILENT: "1" } : { FIXTURE_SFTP_FAIL: "1" }) },
      }),
    });
    try { await assert.rejects(transfer.upload("/source", "/target"), error => error instanceof Error && !error.message.includes("private-failure")); }
    finally { await transfer.close(); }
    await assert.rejects(transfer.upload("/source", "/target"), /closed/u);
  }
});

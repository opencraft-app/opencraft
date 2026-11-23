import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeInheritedDescriptors } from "../../apps/opencraft-daemon/src/inherited-descriptors.ts";

const module = fileURLToPath(new URL("../../apps/opencraft-daemon/src/inherited-descriptors.ts", import.meta.url));

test(
  "descriptors without close-on-exec are closed, the process's own are kept",
  { skip: process.platform !== "linux" },
  async () => {
    // Node marks some inherited descriptors close-on-exec at startup, so the flags come from a stand-in /proc.
    const proc = await mkdtemp(join(tmpdir(), "inherited-fds-"));
    const inherited = openSync(process.execPath, "r"),
      own = openSync(process.execPath, "r");
    try {
      await mkdir(join(proc, "self", "fdinfo"), { recursive: true });
      await mkdir(join(proc, "net"));
      await writeFile(join(proc, "self", "fdinfo", String(inherited)), "pos:\t0\nflags:\t0100000\n");
      await writeFile(join(proc, "self", "fdinfo", String(own)), "pos:\t0\nflags:\t02100000\n");
      await writeFile(join(proc, "self", "fdinfo", "2"), "pos:\t0\nflags:\t0100002\n");
      assert.deepEqual(await closeInheritedDescriptors("linux", proc), [inherited]);
      assert.throws(() => fstatSync(inherited), { code: "EBADF" });
      fstatSync(own);
      fstatSync(2);
    } finally {
      closeSync(own);
      await rm(proc, { recursive: true, force: true });
    }
  },
);

test("other platforms are left alone", async () => {
  assert.deepEqual(await closeInheritedDescriptors("darwin"), []);
  assert.deepEqual(await closeInheritedDescriptors("win32"), []);
});

test(
  "an inherited TCP listener is closed even when Node marked it close-on-exec",
  { skip: process.platform !== "linux" },
  async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    const script = `
    const { fstatSync } = require("node:fs");
    const { closeInheritedDescriptors } = require(${JSON.stringify(module)});
    closeInheritedDescriptors().then(closed => {
    let inherited = "open";
    try { fstatSync(3); } catch (error) { inherited = error.code; }
    process.stdout.write(JSON.stringify({ closed, inherited }));
    });
  `;
    // Passed as the child's fd 3, the way Electron's DevTools listener reaches the daemon.
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
      stdio: ["ignore", "pipe", "inherit", fd],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.once("exit", resolve));
    server.close();
    assert.equal(code, 0);
    const result = JSON.parse(output);
    assert.ok(result.closed.includes(3));
    assert.equal(result.inherited, "EBADF");
  },
);

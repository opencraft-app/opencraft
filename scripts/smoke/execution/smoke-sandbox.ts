import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createSandboxPool, createSandbox, DEFAULT_SANDBOX_RESOURCES } from "../../../packages/sandbox/src/index.js";
import { systemdSandboxBackend } from "../../../packages/sandbox-node/src/systemd.js";

// Explicit Linux acceptance. Creates only a unique, bounded synthetic test domain.
if (process.platform !== "linux" || process.getuid?.() !== 0 || process.env.OPENCRAFT_SANDBOX_SMOKE !== "1") {
  throw Error("Run explicitly as root on a Linux test host with OPENCRAFT_SANDBOX_SMOKE=1");
}
const id = "smoke-" + randomUUID().replaceAll("-", "").slice(0, 12);
const policy = { id, capacity: DEFAULT_SANDBOX_RESOURCES };
const backend = systemdSandboxBackend({ scope: "system", uid: 65534, gid: 65534 });
const pool = await createSandboxPool(policy, backend);
const sandbox = await createSandbox(pool, { owner: "synthetic-acceptance" });
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
try {
  let output = "";
  const inspect = [
    "import json,os,resource,subprocess,sys",
    "from pathlib import Path",
    "cg=Path('/proc/self/cgroup').read_text().strip().split('::',1)[1]",
    "root=Path('/sys/fs/cgroup')/str(Path(cg).parent).lstrip('/')",
    "child=subprocess.check_output([sys.executable,'-c',\"from pathlib import Path;print(Path('/proc/self/cgroup').read_text().strip())\"],text=True).strip()",
    "print(json.dumps(dict(cgroup=cg,child=child,uid=os.getuid(),fd=resource.getrlimit(resource.RLIMIT_NOFILE),cpu=(root/'cpu.max').read_text().strip(),memory=int((root/'memory.max').read_text()),tasks=int((root/'pids.max').read_text()))))",
  ].join("\n");
  const child = await sandbox.spawn({ command: ["/usr/bin/python3", "-c", inspect], cwd: "/tmp", env }, event => { if (event.stream === "stdout") output += new TextDecoder().decode(event.data); });
  assert.equal((await child.exited).code, 0);
  const limits = JSON.parse(output);
  const [quota, period] = limits.cpu.split(" ").map(Number);
  assert.equal(quota / period, 4); assert.equal(limits.memory, 8 * 1024 ** 3);
  assert.equal(limits.tasks, 4096); assert.deepEqual(limits.fd, [65536, 65536]);
  assert.equal(limits.uid, 65534); assert.equal(limits.child, "0::" + limits.cgroup);
  assert(limits.cgroup.includes(sandbox.identity.id));
  let second = "";
  const another = await sandbox.spawn({ command: ["/usr/bin/printf", "%s", "$literal with spaces"], cwd: "/tmp", env }, event => { second += new TextDecoder().decode(event.data); });
  assert.equal((await another.exited).code, 0); assert.equal(second, "$literal with spaces");

  const special = "quotes\" ' dollar$ backslash\\ percent%\nsecond line";
  let selected = "";
  const environment = await sandbox.spawn({ command: ["/usr/bin/python3", "-c", "import os,json;print(json.dumps([os.getuid(),os.environ['PATH'],os.environ['SPECIAL']]))"],
    cwd: "/tmp", env: { PATH: "/nonexistent-sandbox-payload-path", SPECIAL: special } }, event => { if (event.stream === "stdout") selected += new TextDecoder().decode(event.data); });
  assert.equal((await environment.exited).code, 0); assert.deepEqual(JSON.parse(selected), [65534, "/nonexistent-sandbox-payload-path", special]);

  let terminalVerified = false;
  if (process.env.OPENCRAFT_SANDBOX_SMOKE_PTY === "1") {
    let text = "", ready!: () => void;
    const readyOutput = new Promise<void>(resolve => { ready = resolve; });
    const terminal = await sandbox.spawn({ command: ["/usr/bin/python3", "-u", "-c",
      "import sys,os,json; print('pty-ready',flush=True); s=sys.stdin.readline().strip(); print('pty-result:'+s,flush=True); print(json.dumps(list(os.get_terminal_size())),flush=True)"],
      cwd: "/tmp", env, terminal: { cols: 80, rows: 24 } }, event => {
        text += new TextDecoder().decode(event.data); if (text.includes("pty-ready")) ready();
      });
    assert.equal(terminal.kind, "terminal");
    if (terminal.kind !== "terminal") throw Error("No terminal capability");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([readyOutput, terminal.exited.then(() => { throw Error("Terminal exited before readiness"); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Terminal readiness timeout")), 8000); })]).finally(() => clearTimeout(timer));
    await terminal.resize({ cols: 100, rows: 30 }); await terminal.writeStdin(new TextEncoder().encode("hello\n"));
    assert.equal((await terminal.exited).code, 0); assert(text.includes("pty-result:hello")); assert(text.includes("[100, 30]"));
    terminalVerified = true;
  }

  let buffered = "", ready!: (pids: number[]) => void;
  const pidsReady = new Promise<number[]>(resolve => { ready = resolve; });
  const sleeping = await sandbox.spawn({ command: ["/usr/bin/python3", "-u", "-c",
    "import os,subprocess,time,json; c=subprocess.Popen(['/usr/bin/sleep','300']);print(json.dumps([os.getpid(),c.pid]),flush=True);time.sleep(300)"],
    cwd: "/tmp", env }, event => {
      if (event.stream !== "stdout") return;
      buffered += new TextDecoder().decode(event.data);
      if (buffered.includes("\n")) ready(JSON.parse(buffered.trim()));
    });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const pids = await Promise.race([pidsReady, sleeping.exited.then(() => { throw Error("Synthetic command exited before readiness"); }),
    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error("Synthetic command readiness timeout")), 8000); })]).finally(() => clearTimeout(deadline));
  await sleeping.terminate(); await sleeping.exited;
  for (const pid of pids) {
    let gone = false;
    for (let i = 0; i < 100; i++) {
      try { await readFile("/proc/" + pid + "/stat", "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { gone = true; break; } throw e; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(gone, "Synthetic descendant remained after termination");
  }
  await sandbox.close();
  const successor = await createSandbox(pool, { owner: "synthetic-successor" }); await successor.close();
  console.log(JSON.stringify({ status: "passed", pool: id, limits, multipleCommands: true, inheritedFork: true, descendantsRemoved: true, capacityReused: true, terminalVerified }));
} finally { await sandbox.close(); await pool.close(); }

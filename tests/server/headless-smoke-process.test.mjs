import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeadlessSmokeProcess } from "../../scripts/headless-smoke-process.mjs";

const linux = { skip: process.platform !== "linux", timeout: 12_000 };
async function isRunning(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    // The process can exit after /proc opens the file but before its read.
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Owned smoke descendant did not stop");
}

test("closing a smoke group stops an orphan writer and preserves an unrelated process", linux, async t => {
  const directory = await mkdtemp(join(tmpdir(), "oc-smoke-group-"));
  const marker = join(directory, "writes");
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(async () => {
    const closed = once(other, "close"); other.kill("SIGKILL"); await closed;
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const writer = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, '.'), 10);`;
  const leader = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio: 'ignore'}); console.log(child.pid); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const processGroup = startHeadlessSmokeProcess(process.execPath, ["-e", leader], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => processGroup.close());
  const [output] = await once(processGroup.child.stdout, "data");
  const writerPid = Number(output.toString().trim());
  assert.ok(writerPid > 0);
  await until(async () => { try { return (await readFile(marker)).length > 0; } catch { return false; } });
  await processGroup.close();
  await until(async () => !(await isRunning(writerPid)));
  assert.equal(await isRunning(other.pid), true);
  await processGroup.close();
  assert.equal(await isRunning(other.pid), true);
});

test("an unresponsive smoke leader is killed and actually closed before cleanup returns", linux, async t => {
  const processGroup = startHeadlessSmokeProcess(process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => processGroup.close());
  await once(processGroup.child.stdout, "data");
  await processGroup.close();
  assert.equal(processGroup.child.signalCode, "SIGKILL");
  assert.equal(await isRunning(processGroup.child.pid), false);
});

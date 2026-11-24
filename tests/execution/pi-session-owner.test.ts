import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiDurableSession } from "../../plugins/pi-engine/src/session.js";
import { PiShellWorker } from "../../plugins/pi-engine/src/shell.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "pi_writer.sqlite") };
}
function open(file: string, exits: Error[] = []) {
  return PiDurableSession.open({
    threadId: "pi_writer",
    cwd: join(file, ".."),
    file,
    agentDirectory: join(file, ".."),
    shell: false,
    lockRetries: 0,
    models: createModels() as unknown as ModelRuntime,
    tools: [],
    onSnapshot() {},
    async onTool() {
      throw new Error("Unexpected tool");
    },
    onExit(error) {
      exits.push(error);
    },
  });
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "a stalled live Pi session owner is never replaced and process death releases it at once",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async (t) => {
    const { file } = await fixture(t);
    const child = fork(new URL("../fixtures/pi-session-owner.ts", import.meta.url), [file], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && !child.signalCode) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    });
    const replies: any[] = [];
    child.on("message", (message) => replies.push(message));
    const reply = async (type: string) => {
      for (let i = 0; i < 300 && !replies.some((row) => row.type === type); i++) await delay(20);
      return replies.find((row) => row.type === type);
    };
    assert.ok(await reply("ready"));
    // A stopped event loop cannot refresh anything: age the lease far past any staleness.
    child.kill("SIGSTOP");
    await utimes(`${file}.lock`, 0, 0);
    await assert.rejects(open(file), { code: "ELOCKED" });
    child.kill("SIGCONT");
    child.send({ type: "write", id: "after-stall" });
    assert.equal((await reply("written"))?.id, "after-stall", "the resumed owner still owns and writes its database");
    await delay(500);
    assert.equal(child.exitCode, null);
    assert.doesNotMatch(stderr, /ECOMPROMISED/);
    assert.equal(
      replies.some((row) => row.type === "exit"),
      false,
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const successor = await open(file);
    try {
      const { entries } = await successor.snapshot();
      assert.ok(
        entries.some((entry) => entry.kind === "opencraft.systemRecovery"),
        "the successor reads the previous owner's committed write",
      );
    } finally {
      await successor.close();
    }
  },
);

test("a second Pi session writer in the same process is refused however old the lease looks", async (t) => {
  const { file } = await fixture(t);
  const first = await open(file);
  t.after(() => first.close());
  await utimes(`${file}.lock`, 0, 0);
  await assert.rejects(open(file), { code: "ELOCKED" });
  await first.close();
  await (await open(file)).close();
});

test(
  "a Pi session owner whose data directory disappears never throws a lock compromise from a timer",
  { timeout: 20_000 },
  async (t) => {
    const { directory, file } = await fixture(t);
    const uncaught: unknown[] = [],
      record = (error: unknown) => {
        uncaught.push(error);
      };
    process.on("uncaughtException", record);
    t.after(() => {
      process.off("uncaughtException", record);
    });
    const exits: Error[] = [];
    const session = await open(file, exits);
    await rm(directory, { recursive: true, force: true });
    // Longer than the 5s refresh period of the former mtime lease.
    await delay(6_000);
    assert.deepEqual(uncaught, []);
    await session.close();
    assert.deepEqual(uncaught, []);
  },
);

test("an abandoned legacy Pi session lease is converted, while a fresh one is still honoured", async (t) => {
  const { file } = await fixture(t);
  await mkdir(`${file}.lock`);
  await assert.rejects(open(file), { code: "ELOCKED" });
  await utimes(`${file}.lock`, 0, 0);
  const session = await open(file);
  try {
    assert.equal((await stat(`${file}.lock`)).isFile(), true);
  } finally {
    await session.close();
  }
});

test("a Pi shell worker stopped while starting never leaves an unowned worker process behind", async (t) => {
  const { directory } = await fixture(t);
  const worker = new PiShellWorker({
    cwd: directory,
    directory,
    threadId: "pi_writer",
    onNotification() {},
    onLost() {},
  });
  // Never leave a stray worker behind, even when an assertion fails.
  t.after(() => {
    if (worker.pid) process.kill(worker.pid, "SIGKILL");
  });
  const starting = worker.start();
  await worker.stop();
  await assert.rejects(starting, /stopped while starting/);
  assert.equal(worker.pid, undefined);
  // A stopped worker may restart (user Stop); a closed one never does.
  await worker.start();
  assert.ok(worker.pid);
  await worker.close();
  assert.equal(worker.pid, undefined);
  await assert.rejects(worker.start(), /closed/);
  assert.equal(worker.pid, undefined);
});

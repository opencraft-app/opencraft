import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsPromises, {
  copyFile,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DAY, runRetention } from "../../scripts/maintenance/prune-local-runtime.mjs";

const execFileAsync = promisify(execFile);
const now = Date.parse("2026-11-17T00:00:00Z");
const old = new Date(now - 8 * DAY);
const slots = ["cwd", "root", "exe", "maps", "fd"];

async function ageTree(path, date) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await lutimes(path, date, date);
    return;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await ageTree(join(path, entry), date);
    }
  }
  await utimes(path, date, date);
}

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), "opencraft-retention-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const procRoot = join(repoRoot, "proc");
  await mkdir(procRoot);
  const output = [];

  return {
    repoRoot,
    procRoot,
    output,
    async createRun(name = "run-20261101", root = ".local") {
      const path = join(repoRoot, root, name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "output.log"), "artifact");
      await ageTree(path, old);
      return path;
    },
    run(options = {}) {
      return runRetention({
        repoRoot,
        procRoot,
        now,
        report: (line) => output.push(line),
        ...options,
      });
    },
  };
}

async function createProcess(f, referencedSlot, target) {
  const processPath = join(f.procRoot, "123");
  await mkdir(join(processPath, "fd"), { recursive: true });
  for (const slot of ["cwd", "root", "exe"]) {
    await symlink(slot === referencedSlot ? target : f.repoRoot, join(processPath, slot));
  }
  await writeFile(
    join(processPath, "maps"),
    referencedSlot === "maps" ? `0000-1000 r--p 0000 00:00 0 ${target}\n` : "",
  );
  if (referencedSlot === "fd") {
    await symlink(target, join(processPath, "fd", "3"));
  }
  return processPath;
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("recent deep descendant mtime keeps an otherwise old directory", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  const nested = join(path, "nested", "deeper");
  await mkdir(nested, { recursive: true });
  const file = join(nested, "active.log");
  await writeFile(file, "still active");
  await ageTree(path, old);
  const recent = new Date(now - DAY);
  await utimes(file, recent, recent);

  const result = await f.run({ apply: true });

  assert.equal(result.candidates[0].ageDays, 1);
  assert.equal(result.candidates[0].mtime, recent.toISOString());
  assert.equal(result.eligible.length, 0);
  assert.equal(await readFile(file, "utf8"), "still active");
});

for (const filename of [
  ".env",
  ".env.local",
  "server.pem",
  "server.key",
  "credentials.json",
  "access-token",
  "CLIENT.KEY",
]) {
  test(`credential file ${filename} keeps its directory and reports the reason`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun();
    await mkdir(join(path, "nested"));
    const file = join(path, "nested", filename);
    await writeFile(file, "fixture");
    await ageTree(path, old);

    const result = await f.run({ apply: true });

    assert.equal(result.eligible.length, 0);
    assert.equal(await readFile(file, "utf8"), "fixture");
    assert.ok(
      f.output.some((line) =>
        line.includes(`reason=credential:.local/run-20261101/nested/${filename}`),
      ),
    );
  });
}

for (const filename of [
  "state.db",
  "state.sqlite",
  "state.sqlite3",
  "state.sqlite.backup",
  "state.sqlite-wal",
  "state.sqlite-shm",
  "data-wal",
  "data-shm",
]) {
  test(`database file ${filename} keeps its directory and reports the reason`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun();
    const file = join(path, filename);
    await writeFile(file, "fixture");
    await ageTree(path, old);

    const result = await f.run({ apply: true });

    assert.equal(result.eligible.length, 0);
    assert.equal(await readFile(file, "utf8"), "fixture");
    assert.ok(
      f.output.some((line) => line.includes(`reason=database:.local/run-20261101/${filename}`)),
    );
  });
}

test("unreadable proc root keeps eligible directories as unknown", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  await rm(f.procRoot, { recursive: true });

  const result = await f.run({ apply: true });

  assert.equal(result.candidates[0].unknown, true);
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].includes("reason=proc:ENOENT"));
});

for (const slot of slots) {
  test(`unreadable proc ${slot} keeps directories as unknown`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun();
    const processPath = await createProcess(f);
    const slotPath = join(processPath, slot);
    await rm(slotPath, { recursive: true });
    if (slot === "maps") {
      await mkdir(slotPath);
    } else {
      await writeFile(slotPath, "unreadable as a process reference");
    }

    const result = await f.run({ apply: true });

    assert.equal(result.candidates[0].unknown, true);
    assert.equal(result.eligible.length, 0);
    assert.ok((await lstat(path)).isDirectory());
    assert.ok(f.output[0].includes("reason=proc-read-unknown"));
  });

  test(`proc ${slot} reference keeps its directory`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun();
    await createProcess(f, slot, join(path, "output.log"));

    const result = await f.run({ apply: true });

    assert.equal(result.candidates[0].unknown, false);
    assert.equal(result.eligible.length, 0);
    assert.ok((await lstat(path)).isDirectory());
    assert.ok(f.output[0].includes(`refs=123:${slot}`));
  });
}

for (const slot of slots) {
  test(`missing proc ${slot} is an absent reference even while the PID exists`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun();
    const processPath = await createProcess(f);
    await rm(join(processPath, slot), { recursive: true });

    const result = await f.run({ apply: true });

    assert.equal(result.candidates[0].unknown, false);
    assert.equal(result.eligible.length, 1);
    await assertMissing(path);
  });
}

test("permission denied reading proc maps keeps directories as unknown", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  const processPath = await createProcess(f);
  const read = fsPromises.readFile;
  // Inject the filesystem error so this also works when tests run as root.
  t.mock.method(fsPromises, "readFile", async (file, ...args) => {
    if (file === join(processPath, "maps")) {
      throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    }
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const result = await f.run({ apply: true });

  assert.equal(result.candidates[0].unknown, true);
  assert.equal(result.candidates[0].reason, "proc-read-unknown");
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
});

test(
  "closed file descriptors do not make a live process unknown",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await fixture(t);
    await f.createRun();
    const processPath = await createProcess(f);
    const fdPath = join(processPath, "fd");
    await rm(fdPath, { recursive: true });
    await symlink("/proc/self/fd", fdPath);

    const result = await f.run();

    assert.equal(result.candidates[0].unknown, false);
    assert.equal(result.eligible.length, 1);
  },
);

test("default dry run reports eligible directories without deleting or logging", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();

  const result = await f.run();

  assert.equal(result.eligible.length, 1);
  assert.equal(await readFile(join(path, "output.log"), "utf8"), "artifact");
  assert.ok(f.output[0].startsWith("would-remove\t"));
  assert.ok(f.output.at(-1).endsWith("mode=dry-run"));
  await assertMissing(join(f.repoRoot, ".local/maintenance"));
});

test("apply deletes eligible directories and appends a record for each removal", async (t) => {
  const f = await fixture(t);
  const local = await f.createRun();
  const runtime = await f.createRun("run-20261102", ".runtime");

  const result = await f.run({ apply: true });

  assert.equal(result.eligible.length, 2);
  await assertMissing(local);
  await assertMissing(runtime);
  const logPath = join(f.repoRoot, ".local/maintenance/local-runtime-retention.jsonl");
  const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    records.map(({ path, bytes, retentionDays }) => ({ path, bytes, retentionDays })),
    [
      { path: ".local/run-20261101", bytes: 8, retentionDays: 7 },
      { path: ".runtime/run-20261102", bytes: 8, retentionDays: 7 },
    ],
  );
  assert.ok(records.every((record) => Number.isFinite(Date.parse(record.at))));
  assert.equal(f.output.filter((line) => line.startsWith("removed\t")).length, 2);
  assert.ok(f.output.at(-1).endsWith("mode=apply"));

  await f.createRun("run-20261103");
  await f.run({ apply: true });
  assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 3);
});

test("symbolic links inside candidates are not followed during inspection or removal", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  const outside = join(f.repoRoot, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "state.db"), "keep outside data");
  await symlink(outside, join(path, "linked"));
  await symlink("missing-target", join(path, "dangling"));
  await symlink(path, join(path, "cycle"));
  await ageTree(path, old);

  const result = await f.run({ apply: true });

  assert.equal(result.eligible.length, 1);
  await assertMissing(path);
  assert.equal(await readFile(join(outside, "state.db"), "utf8"), "keep outside data");
});

test("symbolic links in the runtime roots are not candidates", async (t) => {
  const f = await fixture(t);
  const outside = join(f.repoRoot, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "output.log"), "outside");
  await mkdir(join(f.repoRoot, ".local"));
  const link = join(f.repoRoot, ".local", "linked-20261101");
  await symlink(outside, link);

  const result = await f.run({ apply: true });

  assert.equal(result.candidates.length, 0);
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readFile(join(outside, "output.log"), "utf8"), "outside");
});

test("only date-stamped direct children of the two runtime roots are candidates", async (t) => {
  const f = await fixture(t);
  await f.createRun("run-20261101");
  await f.createRun("run-20261102", ".runtime");
  const longLived = await f.createRun("steward");
  const nested = await f.createRun("steward/nested-20261101");
  const otherRoot = await f.createRun("run-20261103", "other");

  const result = await f.run({ apply: true });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.eligible.length, 2);
  assert.ok((await lstat(longLived)).isDirectory());
  assert.ok((await lstat(nested)).isDirectory());
  assert.ok((await lstat(otherRoot)).isDirectory());
});

test("a directory becomes eligible exactly at seven idle days", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  await ageTree(path, new Date(now - 7 * DAY));

  const before = await f.run({ now: now - 1 });
  const atBoundary = await f.run();

  assert.equal(before.eligible.length, 0);
  assert.equal(atBoundary.eligible.length, 1);
});

for (const apply of [false, true]) {
  test(`CLI selects ${apply ? "apply with --apply" : "dry run by default"}`, async (t) => {
    const f = await fixture(t);
    const script = join(f.repoRoot, "scripts/maintenance/prune-local-runtime.mjs");
    await mkdir(dirname(script), { recursive: true });
    await copyFile(
      new URL("../../scripts/maintenance/prune-local-runtime.mjs", import.meta.url),
      script,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [script, ...(apply ? ["--apply"] : []), `--now=${new Date(now).toISOString()}`],
      {
        env: { ...process.env, OPENCRAFT_LOCAL_RUNTIME_ROOTS: join(f.repoRoot, ".local") },
      },
    );

    assert.ok(stdout.includes(`mode=${apply ? "apply" : "dry-run"}`));
    await assertMissing(join(f.repoRoot, ".local/maintenance"));
  });
}

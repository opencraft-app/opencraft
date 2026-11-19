import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runRetention } from "../../scripts/maintenance/prune-local-runtime.mjs";

const execFileAsync = promisify(execFile);
const slots = ["cwd", "root", "exe", "maps", "fd"];

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), "opencraft-cleanup-"));
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
      return path;
    },
    run(options = {}) {
      return runRetention({ repoRoot, procRoot, report: (line) => output.push(line), ...options });
    },
  };
}

async function createProcess(f, referencedSlot, target) {
  const processPath = join(f.procRoot, "123");
  await mkdir(join(processPath, "fd"), { recursive: true });
  for (const slot of ["cwd", "root", "exe"]) {
    await symlink(slot === referencedSlot ? target : f.repoRoot, join(processPath, slot));
  }
  await writeFile(join(processPath, "maps"), referencedSlot === "maps" ? `0000 ${target}\n` : "");
  if (referencedSlot === "fd") await symlink(target, join(processPath, "fd", "3"));
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("removal is independent of age and uses the newest descendant only as evidence", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("recent-run");
  const nested = join(path, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "new.log"), "new");
  const result = await f.run({ apply: true, now: Date.parse("2020-01-01T00:00:00Z") });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.candidates[0].ageDays < 0, true);
  await assertMissing(path);
});

test("credential files and credential directories are always retained", async (t) => {
  const f = await fixture(t);
  const credential = await f.createRun("credential-run");
  await writeFile(join(credential, ".env"), "TOKEN=x");
  const directory = await f.createRun("team-credentials", ".local");
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 0);
  assert.equal(await readFile(join(credential, ".env"), "utf8"), "TOKEN=x");
  assert.ok((await lstat(directory)).isDirectory());
  assert.ok(f.output.some((line) => line.includes("reason=credential:")));
  assert.ok(f.output.some((line) => line.includes("reason=protected-directory")));
});

test("steward workbook is always retained and reported separately", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("steward");
  await writeFile(join(path, "agent-bridge.md"), "workbook");
  const result = await f.run({ apply: true });
  assert.equal(result.candidates[0].refs.length, 0);
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.equal(await readFile(join(path, "agent-bridge.md"), "utf8"), "workbook");
  const line = f.output.find((entry) => entry.split("\t")[3] === ".local/steward");
  assert.ok(line);
  assert.equal(line.split("\t")[0], "kept");
  assert.ok(line.includes("reason=protected-steward"));
});

test("a candidate containing the steward workbook is retained", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("steward");
  const result = await f.run({ roots: [f.repoRoot] });
  const local = join(f.repoRoot, ".local");
  assert.equal(result.eligible.some((entry) => entry.path === local), false);
  assert.ok((await lstat(path)).isDirectory());
  const line = f.output.find((entry) => entry.split("\t")[3] === ".local");
  assert.ok(line);
  assert.equal(line.split("\t")[0], "kept");
  assert.ok(line.includes("reason=protected-steward"));
});

test("steward workbook under an audited root is retained", async (t) => {
  const f = await fixture(t);
  const external = join(f.repoRoot, "external");
  const path = join(external, ".local", "steward");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "agent-bridge.md"), "workbook");
  const result = await f.run({ apply: true, roots: [join(external, ".local")] });
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.equal(await readFile(join(path, "agent-bridge.md"), "utf8"), "workbook");
  const line = f.output.find((entry) => entry.endsWith(".local/steward\treason=protected-steward"));
  assert.ok(line);
  assert.equal(line.startsWith("kept\t"), true);
});

test("credentials win over database markers and nested protected directories", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("mixed");
  await writeFile(join(path, "state.sqlite"), "database");
  await mkdir(join(path, "private"));
  await writeFile(join(path, "private", "identity.key"), "credential");
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].includes("reason=credential:"));
  assert.ok(f.output[0].includes("reason=protected-descendant"));
});

test("operator protected roots remain safe when the host process namespace is incomplete", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("known-live");
  const result = await f.run({ apply: true, protectedRoots: [path] });
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].includes("reason=operator-protected"));
});

test("a protected root nested below a candidate protects the candidate", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("deployment");
  const nested = join(path, "releases", "live");
  await mkdir(nested, { recursive: true });
  const result = await f.run({ apply: true, protectedRoots: [nested] });
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].includes("reason=operator-protected"));
});

test("an unreferenced database is removable while an open reference protects its directory", async (t) => {
  const f = await fixture(t);
  const removable = await f.createRun("database-history");
  await writeFile(join(removable, "state.sqlite"), "old");
  const referenced = await f.createRun("database-live");
  const db = join(referenced, "state.sqlite");
  await writeFile(db, "live");
  await createProcess(f, "fd", db);
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 1);
  await assertMissing(removable);
  assert.ok((await lstat(referenced)).isDirectory());
  assert.ok(f.output.some((line) => line.includes("refs=123:fd")));
});

for (const slot of slots) {
  test(`proc ${slot} reference protects its directory`, async (t) => {
    const f = await fixture(t);
    const path = await f.createRun(`referenced-${slot}`);
    await createProcess(f, slot, join(path, "output.log"));
    const result = await f.run({ apply: true });
    assert.equal(result.eligible.length, 0);
    assert.ok((await lstat(path)).isDirectory());
    assert.ok(f.output.some((line) => line.includes(`refs=123:${slot}`)));
  });
}

test("unreadable process state is retained conservatively", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun();
  await rm(f.procRoot, { recursive: true });
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 0);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].includes("reason=proc:ENOENT"));
});

test("dry run reports all immediate directories without writing", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("history");
  await f.createRun("nested/history", ".local");
  const result = await f.run();
  assert.equal(result.candidates.length, 2);
  assert.equal(result.eligible.length, 2);
  assert.ok((await lstat(path)).isDirectory());
  assert.ok(f.output[0].startsWith("would-remove\t"));
  await assertMissing(join(f.repoRoot, ".local/maintenance"));
});

test("apply deletes unreferenced directories and records the unreferenced policy", async (t) => {
  const f = await fixture(t);
  const local = await f.createRun("run-20261101");
  const runtime = await f.createRun("run-20261102", ".runtime");
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 2);
  await assertMissing(local);
  await assertMissing(runtime);
  const logPath = join(f.repoRoot, ".local/maintenance/local-runtime-retention.jsonl");
  const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ path, bytes, policy }) => ({ path, bytes, policy })), [
    { path: ".local/run-20261101", bytes: 8, policy: "unreferenced" },
    { path: ".runtime/run-20261102", bytes: 8, policy: "unreferenced" },
  ]);
  await f.run({ apply: true });
  assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 2);
});

test("symbolic links are not followed", async (t) => {
  const f = await fixture(t);
  const path = await f.createRun("links");
  const outside = join(f.repoRoot, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "outside");
  await symlink(outside, join(path, "linked"));
  const result = await f.run({ apply: true });
  assert.equal(result.eligible.length, 1);
  await assertMissing(path);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
});

test("CLI supports a dry run", async (t) => {
  const f = await fixture(t);
  await f.createRun("cli-run");
  const script = join(f.repoRoot, "scripts/maintenance/prune-local-runtime.mjs");
  await mkdir(dirname(script), { recursive: true });
  await copyFile(new URL("../../scripts/maintenance/prune-local-runtime.mjs", import.meta.url), script);
  const { stdout } = await execFileAsync(process.execPath, [script], {
    env: {
      ...process.env,
      OPENCRAFT_LOCAL_RUNTIME_ROOTS: join(f.repoRoot, ".local"),
      OPENCRAFT_LOCAL_RUNTIME_PROC_ROOT: f.procRoot,
    },
  });
  assert.match(stdout, /mode=dry-run/);
  assert.match(stdout, /would-remove/);
  await assertMissing(join(f.repoRoot, ".local/maintenance"));
});

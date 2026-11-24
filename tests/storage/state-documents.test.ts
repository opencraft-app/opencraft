import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { STATE_DOCUMENT_CONFORMANCE_CASES } from "@opencraft/document-storage/state-conformance";

for (const conformance of STATE_DOCUMENT_CONFORMANCE_CASES) {
  test(`memory state documents: ${conformance.name}`, () => conformance.run(memoryStateDocumentStore()));
  test(`file state documents: ${conformance.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "state-documents-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await conformance.run(fileStateDocumentStore(join(directory, "nested")), async (key) => {
      await fileStateDocumentStore(join(directory, "nested")).update("seed.json", () => ({ result: 0, next: {} }));
      await writeFile(join(directory, "nested", key), "{not json");
    });
  });
}

test("file state documents keep the existing pretty-printed format", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "state-documents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fileStateDocumentStore(directory).update("models.json", () => ({ result: 0, next: { revision: 1 } }));
  const { readFile } = await import("node:fs/promises");
  const { strictEqual } = await import("node:assert/strict");
  strictEqual(await readFile(join(directory, "models.json"), "utf8"), '{\n  "revision": 1\n}\n');
});

test("private file state documents refuse symlinks, shared modes and oversized files", async (t) => {
  const { chmod, symlink, writeFile: write } = await import("node:fs/promises");
  const { rejects, deepEqual } = await import("node:assert/strict");
  const { StateDocumentNotPrivateError } = await import("@opencraft/document-storage/state-file");
  const directory = await mkdtemp(join(tmpdir(), "state-private-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = fileStateDocumentStore(directory, { private: { maxBytes: 64 } });
  await store.update("ok.json", () => ({ result: 0, next: { key: "secret" } }));
  deepEqual(await store.read("ok.json"), { key: "secret" });
  await write(join(directory, "shared.json"), "{}");
  await chmod(join(directory, "shared.json"), 0o644);
  await write(join(directory, "big.json"), JSON.stringify({ pad: "x".repeat(100) }), { mode: 0o600 });
  await symlink(join(directory, "ok.json"), join(directory, "link.json"));
  for (const key of ["shared.json", "big.json"]) await rejects(store.read(key), StateDocumentNotPrivateError, key);
  await rejects(store.read("link.json"), (error: NodeJS.ErrnoException) => error.code === "ELOOP");
  await rejects(
    store.update("shared.json", () => ({ result: 0, next: {} })),
    StateDocumentNotPrivateError,
  );
});

// Updates from different processes serialize on `<file>.lock`. The former
// proper-lockfile mtime lease let a contender take over a holder whose event
// loop stalled for 10s, threw ECOMPROMISED from the holder's refresh timer and
// kept a crashed holder's lease for 10s.
const stateFileModule = new URL("../../packages/document-storage/src/state-file.ts", import.meta.url).pathname;
function holdUpdate(t: TestContext, directory: string, holdMs: number) {
  const code = `import { fileStateDocumentStore } from ${JSON.stringify(stateFileModule)};
    await fileStateDocumentStore(process.argv[1]).update("counter.json", (current) => {
      process.stdout.write("held\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
      return { result: 0, next: { count: (current?.count ?? 0) + 1 } };
    });`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, directory, String(holdMs)],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const held = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => String(chunk).includes("held") && resolve());
    void exited.then(() => reject(new Error(`State holder exited early: ${stderr}`)));
  });
  return { child, held, exited, stderr: () => stderr };
}
const bump = (current: unknown) => ({
  result: 0,
  next: { count: ((current as { count?: number } | null)?.count ?? 0) + 1 },
});

test(
  "a state update whose holder stalls past the former lease is not taken over, and the holder still commits",
  { skip: process.platform === "win32", timeout: 60_000 },
  async (t) => {
    const { deepEqual, rejects, equal, doesNotMatch } = await import("node:assert/strict");
    const { setTimeout: delay } = await import("node:timers/promises");
    const directory = await mkdtemp(join(tmpdir(), "state-stall-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const holder = holdUpdate(t, directory, 16_000);
    await holder.held;
    await delay(10_500);
    const store = fileStateDocumentStore(directory);
    await rejects(store.update("counter.json", bump), { code: "ELOCKED" });
    equal(await holder.exited, 0);
    doesNotMatch(holder.stderr(), /ECOMPROMISED/);
    await store.update("counter.json", bump);
    deepEqual(await store.read("counter.json"), { count: 2 });
  },
);

test("a killed state update holder releases its lock at once", { skip: process.platform === "win32" }, async (t) => {
  const { deepEqual } = await import("node:assert/strict");
  const directory = await mkdtemp(join(tmpdir(), "state-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const holder = holdUpdate(t, directory, 30_000);
  await holder.held;
  holder.child.kill("SIGKILL");
  await holder.exited;
  const store = fileStateDocumentStore(directory);
  await store.update("counter.json", bump);
  deepEqual(await store.read("counter.json"), { count: 1 });
});

test("a legacy lease directory blocks state updates until it is long expired, then becomes a lock file", async (t) => {
  const { mkdir, lstat, utimes } = await import("node:fs/promises");
  const { rejects, equal, deepEqual } = await import("node:assert/strict");
  const directory = await mkdtemp(join(tmpdir(), "state-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, "counter.json.lock");
  await mkdir(lock);
  const store = fileStateDocumentStore(directory);
  await rejects(store.update("counter.json", bump), { code: "ELOCKED" });
  const expired = new Date(Date.now() - 120_000);
  await utimes(lock, expired, expired);
  await store.update("counter.json", bump);
  equal((await lstat(lock)).isFile(), true);
  deepEqual(await store.read("counter.json"), { count: 1 });
});

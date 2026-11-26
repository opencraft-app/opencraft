import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  activate,
  acquireUpdateLock,
  download,
  recover,
  runUpdate,
  verifyArchive,
} from "../../scripts/personal-machine/update.mjs";
import { packagePersonalMachine } from "../../scripts/package-personal-machine.mjs";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function directory(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "oc-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}

async function fixture(t: test.TestContext) {
  const state = await directory(t);
  const oldRelease = join(state, "releases", "a".repeat(64));
  const candidate = join(state, "releases", "b".repeat(64));
  await mkdir(oldRelease, { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(join(oldRelease, "old"), "original runtime");
  await writeFile(join(oldRelease, ".machine-version"), `${"a".repeat(64)}\n`);
  await writeFile(join(candidate, "new"), "candidate runtime");
  await writeFile(join(candidate, ".machine-version"), `${"b".repeat(64)}\n`);
  await symlink(oldRelease, join(state, "runtime"));
  const text = JSON.stringify({
    schemaVersion: 1,
    id: randomUUID(),
    hubId: randomUUID(),
    origin: "http://127.0.0.1:9",
    credential: "x".repeat(43),
    phase: "enrolled",
  });
  await writeFile(join(state, "connection.json"), text, { mode: 0o600 });
  return { state, oldRelease, candidate, text };
}

test("verifyArchive rejects checksum mismatch, path traversal, and symlinks", async (t) => {
  const dir = await directory(t);
  await writeFile(join(dir, "hello.txt"), "hello\n");
  const validTgz = join(dir, "valid.tgz");
  execFileSync("tar", ["-czf", validTgz, "-C", dir, "hello.txt"]);
  const bytes = await readFile(validTgz);
  verifyArchive(bytes, hash(bytes));
  assert.throws(() => verifyArchive(bytes, "0".repeat(64)), /checksum mismatch/u);

  const linkDir = join(dir, "links");
  await mkdir(linkDir);
  await symlink("/etc/passwd", join(linkDir, "escape"));
  const linkTgz = join(dir, "link.tgz");
  execFileSync("tar", ["-czf", linkTgz, "-C", linkDir, "escape"]);
  const linkBytes = await readFile(linkTgz);
  assert.throws(() => verifyArchive(linkBytes, hash(linkBytes)), /links/u);

  const emptyGzip = gzipSync(Buffer.alloc(1024, 0));
  assert.throws(() => verifyArchive(emptyGzip, hash(emptyGzip)), /Empty update archive/u);
});

test("failed trial activation atomically rolls back both runtime symlink and SQLite main/WAL/SHM databases", async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.state, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, "threads.sqlite"), "schema-v1-data");
  await writeFile(join(dataDir, "threads.sqlite-wal"), "v1-wal");
  await writeFile(join(dataDir, "threads.sqlite-shm"), "v1-shm");

  let startCalls = 0;
  await assert.rejects(
    activate(f.state, f.candidate, "b".repeat(64), {
      stop: async () => {},
      start: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          // Simulate a failed N+1 trial migration that mutated SQLite + added a new DB before crashing.
          await writeFile(join(dataDir, "threads.sqlite"), "schema-v2-corrupted-for-v1");
          await writeFile(join(dataDir, "threads.sqlite-wal"), "v2-wal");
          await writeFile(join(dataDir, "extra.sqlite"), "uncommitted-trial-db");
          throw new Error("trial migration failed at activation gate");
        }
      },
    }),
    /trial migration failed/u,
  );

  assert.equal(startCalls, 2, "old runtime restarted after rollback");
  assert.equal(await readFile(join(f.state, "runtime", "old"), "utf8"), "original runtime");
  assert.equal(await readFile(join(dataDir, "threads.sqlite"), "utf8"), "schema-v1-data");
  assert.equal(await readFile(join(dataDir, "threads.sqlite-wal"), "utf8"), "v1-wal");
  assert.equal(await readFile(join(dataDir, "threads.sqlite-shm"), "utf8"), "v1-shm");
  await assert.rejects(readFile(join(dataDir, "extra.sqlite")), /ENOENT/u);
  await assert.rejects(readFile(join(f.state, "update-pending.json")), /ENOENT/u);
  await assert.rejects(readFile(join(f.state, ".sqlite-snapshot", "manifest.json")), /ENOENT/u);
});

test("interrupted activation keeps a recoverable journal and blocks a new update", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    activate(f.state, f.candidate, "d".repeat(64), {
      stop: async () => {
        throw new Error("shutdown outcome unavailable");
      },
      start: async () => {
        throw new Error("must not start");
      },
    }),
    /shutdown outcome/u,
  );
  assert.equal(await readFile(join(f.state, "runtime", "old"), "utf8"), "original runtime");
  await assert.rejects(runUpdate(f.state, "--check-update"), /--recover/u);
  let recovered = false;
  await recover(f.state, {
    stop: async () => {},
    start: async () => {
      recovered = true;
    },
  });
  assert.equal(recovered, true);
  await assert.rejects(readFile(join(f.state, "update-pending.json")), /ENOENT/u);
});

test("invalid downloaded candidate never stops or replaces the current runtime", async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(f.text);
  const bytes = Buffer.from("not a gzip archive");
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Bearer ${config.credential}`);
    if (req.url?.includes("/bootstrap?")) {
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          id: config.id,
          hubId: config.hubId,
          origin: config.origin,
          digest: hash(bytes),
        }),
      );
    } else {
      res.end(bytes);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(join(f.state, "connection.json"), JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(runUpdate(f.state, "--update"));
  assert.equal(requests, 2);
  assert.equal(await readFile(join(f.state, "runtime", "old"), "utf8"), "original runtime");
  await assert.rejects(readFile(join(f.state, "update-pending.json")), /ENOENT/u);
});

test("recovery refuses a live updater and reclaims a recorded exited owner", async (t) => {
  const state = await directory(t);
  const lock = await acquireUpdateLock(state);
  await assert.rejects(acquireUpdateLock(state, true), /still running/u);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  await acquireUpdateLock(state, true);
  assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).pid, process.pid);
});

test("download rejects redirects and intranet HTTP origins; runUpdate delegates build preparation to unpacked prepare.mjs", async (t) => {
  const redirectServer = createServer((_req, res) => {
    res.writeHead(302, { location: "https://evil.invalid/archive.tgz" });
    res.end();
  });
  await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => redirectServer.close(() => resolve())));
  await assert.rejects(
    download(
      { origin: `http://127.0.0.1:${(redirectServer.address() as { port: number }).port}`, credential: "x".repeat(43) },
      "/update",
    ),
    /302/u,
  );
  await assert.rejects(download({ origin: "http://10.42.0.8:15473", credential: "x".repeat(43) }, "/update"), /HTTPS/u);

  const f = await fixture(t);
  const config = JSON.parse(f.text);
  const pack = await directory(t);
  await mkdir(join(pack, "scripts", "personal-machine"), { recursive: true });
  await writeFile(
    join(pack, "scripts", "personal-machine", "prepare.mjs"),
    "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.cwd(), 'prepared.marker'), 'ok');\n",
  );
  const tgz = join(pack, "candidate.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", pack, "scripts"]);
  const bytes = await readFile(tgz);
  const digest = hash(bytes);
  const server = createServer((req, res) => {
    if (req.url?.includes("/bootstrap?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, id: config.id, hubId: config.hubId, origin: config.origin, digest }));
    } else {
      res.writeHead(200);
      res.end(bytes);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(join(f.state, "connection.json"), JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(runUpdate(f.state, "--update", { nodeVersion: "20.11.0" }), /Node\.js >= 22\.16/u);
  await runUpdate(f.state, "--update", { stop: async () => {}, start: async () => {}, nodeVersion: "24.10.0" });
  assert.equal(await readFile(join(f.state, "runtime", "prepared.marker"), "utf8"), "ok");
  assert.equal(JSON.parse(await readFile(join(f.state, "update-version.json"), "utf8")).version, digest);
});

test("packagePersonalMachine snapshots unstaged tracked edits without touching git index or archiving untracked files", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "oc-pkg-machine-"));
  const out = join(repo, "out");
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "v1\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  await writeFile(join(repo, "tracked.txt"), "v2-unstaged\n");
  await writeFile(join(repo, "1.txt"), "private-untracked-note\n");
  const result = await packagePersonalMachine(repo, out);
  const entries = execFileSync("tar", ["-tzf", result.path]).toString().trim().split("\n");
  assert.deepEqual(entries, ["tracked.txt"]);
  assert.equal(execFileSync("tar", ["-xzOf", result.path, "tracked.txt"]).toString(), "v2-unstaged\n");
  assert.equal(
    execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo }).toString().trim(),
    "",
    "real git index remains untouched",
  );
});

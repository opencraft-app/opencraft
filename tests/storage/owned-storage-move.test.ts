import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { OpenCraftMessageAttachments, OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-message-attachments.js";
import { moveOwnedStorage, planOwnedStorageMove } from "../../apps/opencraft-daemon/src/owned-storage-move.js";
import { acquireOwnedStorageLease } from "../../apps/opencraft-daemon/src/owned-storage-lease.js";
import { OWNED_STORAGE_MOVE_JOURNAL } from "../../apps/opencraft-daemon/src/owned-database-path.js";

const pairs = [
  { old: "codex-host-queue.sqlite", current: "opencraft-host-state.sqlite", migrations: OPENCRAFT_HOST_STATE_MIGRATIONS,
    seed: "INSERT INTO message_senders VALUES ('thread','input','{}',42)" },
  { old: "codex-message-attachments.sqlite", current: "opencraft-message-attachments.sqlite", migrations: OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS,
    seed: "INSERT INTO opencraft_message_attachments VALUES ('thread','input','file',0,'{}')" },
];
const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const moduleUrl = new URL("../../apps/opencraft-daemon/src/owned-storage-move.ts", import.meta.url).href;
const cliPath = fileURLToPath(new URL("../../scripts/move-owned-host-storage.ts", import.meta.url));

function fixture(t: test.TestContext, populate = true) {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-storage-move-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (populate) for (const pair of pairs) {
    const owner = openManagedDatabase({ path: join(directory, pair.old), migrations: pair.migrations });
    owner.database.exec(pair.seed); owner.database.close();
  }
  return directory;
}
function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return { schema, rows: schema.filter(row => row.type === "table").map(row => ({ name: row.name,
      rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all() })) };
  } finally { db.close(); }
}
function crash(directory: string, point: "intent" | "copy" | "prepared" | "linked" | "first-moved" | "receipt") {
  const source = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const directory=${JSON.stringify(directory)}, point=${JSON.stringify(point)};
    const link=fs.linkSync, rename=fs.renameSync, write=fs.writeSync, unlink=fs.unlinkSync, open=fs.openSync;
    const copies=new Set(); fs.openSync=(path,...args)=>{const fd=open(path,...args); if(String(path).endsWith('.partial'))copies.add(fd);return fd;};
    fs.linkSync=(from,to,...rest)=>{ link(from,to,...rest);
      if ((point==='intent' && to.endsWith(${JSON.stringify(OWNED_STORAGE_MOVE_JOURNAL)})) ||
          (point==='linked' && to===directory+'/opencraft-host-state.sqlite')) process.exit(23); };
    fs.renameSync=(from,to,...rest)=>{ rename(from,to,...rest);
      if (to.endsWith(${JSON.stringify(OWNED_STORAGE_MOVE_JOURNAL)})) {
        const entries=JSON.parse(fs.readFileSync(to,'utf8')).entries;
        if ((point==='prepared' && entries[0].state==='prepared') ||
            (point==='first-moved' && entries[0].state==='moved' && entries[1].state==='pending')) process.exit(23);
      } };
    fs.writeSync=(...args)=>{ const written=write(...args); if(point==='copy' && copies.has(args[0]))process.exit(23); return written; };
    fs.unlinkSync=(path,...rest)=>{ if(point==='receipt' && path.endsWith(${JSON.stringify(OWNED_STORAGE_MOVE_JOURNAL)})) process.exit(23); unlink(path,...rest); };
    syncBuiltinESMExports(); const {moveOwnedStorage}=await import(${JSON.stringify(moduleUrl)}); moveOwnedStorage(directory);
  `;
  assert.throws(() => execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], { timeout: 15_000, stdio: "pipe" }), error => (error as { status: number }).status === 23);
}

test("plan and CLI default are read-only, explicit configuration cannot create a missing directory", t => {
  const root = fixture(t), before = readdirSync(root), hashes = pairs.map(pair => readFileSync(join(root, pair.old)));
  assert.equal(planOwnedStorageMove(root).entries.length, 2);
  const plan = JSON.parse(execFileSync(process.execPath, ["--import", loader, cliPath, "--data-dir", root], { encoding: "utf8" }));
  assert.equal(plan.apply, false); assert.equal(plan.entries.length, 2);
  assert.deepEqual(readdirSync(root), before);
  pairs.forEach((pair, index) => assert.deepEqual(readFileSync(join(root, pair.old)), hashes[index]));
  assert.throws(() => moveOwnedStorage(join(root, "absent")), /existing Host data directory/);
  assert.equal(existsSync(join(root, "absent")), false);
  assert.throws(() => execFileSync(process.execPath, ["--import", loader, cliPath, "--apply"], { stdio: "pipe" }));
});

test("populated stores retain every table, SQL definition and migration receipt; reopen and repeated move work", t => {
  const root = fixture(t), before = pairs.map(pair => snapshot(join(root, pair.old)));
  const result = moveOwnedStorage(root);
  assert.equal(result.moved.length, 2); assert.ok(result.receipt && existsSync(result.receipt));
  pairs.forEach((pair, index) => {
    assert.equal(existsSync(join(root, pair.old)), false);
    assert.deepEqual(snapshot(join(root, pair.current)), before[index]);
    assert.deepEqual(snapshot(result.moved[index]!.backup), before[index]);
    if (process.platform !== "win32") assert.equal(statSync(result.moved[index]!.backup).mode & 0o777, 0o600);
  });
  const host = new OpenCraftHostStateDatabase(root), attachments = new OpenCraftMessageAttachments(root);
  assert.equal(host.outcome.status, "up-to-date"); assert.equal(attachments.outcome.status, "up-to-date");
  host.close(); attachments.close();
  assert.deepEqual(moveOwnedStorage(root).moved, []);
});

test("empty directory needs no journal and no business database", t => {
  const root = fixture(t, false); assert.deepEqual(moveOwnedStorage(root).moved, []);
  assert.equal(existsSync(join(root, OWNED_STORAGE_MOVE_JOURNAL)), false);
  assert.equal(readdirSync(root).some(name => name.endsWith("host-state.sqlite")), false);
});

test("live owners block maintenance until both lifetimes close; failed opens release their leases", t => {
  const root = fixture(t), host = new OpenCraftHostStateDatabase(root), attachments = new OpenCraftMessageAttachments(root);
  assert.throws(() => moveOwnedStorage(root), /lease cannot be acquired/);
  assert.throws(() => execFileSync(process.execPath, ["--import", loader, cliPath, "--data-dir", root, "--apply"], { stdio: "pipe", timeout: 15_000 }),
    error => String((error as { stderr: Buffer }).stderr).includes("lease cannot be acquired"));
  host.close(); assert.throws(() => moveOwnedStorage(root), /lease cannot be acquired/);
  attachments.close(); assert.equal(existsSync(join(root, OWNED_STORAGE_MOVE_JOURNAL)), false);
  const exclusive = acquireOwnedStorageLease(root, true);
  try { assert.throws(() => new OpenCraftHostStateDatabase(root), /lease cannot be acquired/); }
  finally { exclusive(); }
  assert.equal(moveOwnedStorage(root).moved.length, 2);
});

test("CLI apply returns verified recovery copies and a completion receipt", t => {
  const root = fixture(t), before = pairs.map(pair => snapshot(join(root, pair.old)));
  const result = JSON.parse(execFileSync(process.execPath, ["--import", loader, cliPath, "--data-dir", root, "--apply"], { encoding: "utf8", timeout: 15_000 }));
  assert.equal(result.apply, true); assert.equal(result.moved.length, 2); assert.equal(existsSync(result.receipt), true);
  pairs.forEach((pair, index) => assert.deepEqual(snapshot(join(root, pair.current)), before[index]));
});

for (const point of ["intent", "copy", "prepared", "linked", "first-moved", "receipt"] as const) {
  test(`process interruption at ${point} resumes without losing rows or allowing an owner to open`, t => {
    const root = fixture(t), before = pairs.map(pair => snapshot(join(root, pair.old)));
    crash(root, point);
    assert.equal(planOwnedStorageMove(root).resume, true);
    assert.throws(() => new OpenCraftHostStateDatabase(root), /unfinished offline maintenance/);
    assert.throws(() => new OpenCraftMessageAttachments(root), /unfinished offline maintenance/);
    assert.throws(() => moveOwnedStorage(root, "legacy"), /original direction/);
    const result = moveOwnedStorage(root); assert.equal(result.moved.length, 2);
    pairs.forEach((pair, index) => assert.deepEqual(snapshot(join(root, pair.current)), before[index]));
    assert.equal(existsSync(join(root, OWNED_STORAGE_MOVE_JOURNAL)), false);
  });
}

test("independent destination is never overwritten, even when its bytes match a prepared source", t => {
  const root = fixture(t); crash(root, "prepared");
  const from = join(root, pairs[0]!.old), to = join(root, pairs[0]!.current), bytes = readFileSync(from);
  writeFileSync(to, bytes);
  assert.throws(() => moveOwnedStorage(root), /Independent destination/);
  assert.deepEqual(readFileSync(from), bytes); assert.deepEqual(readFileSync(to), bytes);
});

test("modified recovery copy fails closed", t => {
  const root = fixture(t); crash(root, "prepared");
  const backup = readdirSync(root).find(name => /^\.opencraft-storage-.*-0\.sqlite$/u.test(name))!;
  writeFileSync(join(root, backup), "changed");
  assert.throws(() => moveOwnedStorage(root), /Recovery copy is missing or changed/);
  assert.equal(existsSync(join(root, pairs[0]!.old)), true);
});

test("preflight rejects both names before moving either store", t => {
  const root = fixture(t), bytes = readFileSync(join(root, pairs[0]!.old));
  writeFileSync(join(root, pairs[1]!.current), "independent");
  assert.throws(() => moveOwnedStorage(root), /Both storage names/);
  assert.deepEqual(readFileSync(join(root, pairs[0]!.old)), bytes);
  assert.equal(existsSync(join(root, OWNED_STORAGE_MOVE_JOURNAL)), false);
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`orphan ${suffix} is refused without creating a replacement`, t => {
    const root = fixture(t, false); writeFileSync(join(root, pairs[0]!.old + suffix), "orphan");
    assert.throws(() => moveOwnedStorage(root), /Orphan SQLite sidecar/);
    assert.deepEqual(readdirSync(root), [pairs[0]!.old + suffix]);
  });
}

test("symlinks and unknown hard links are rejected", t => {
  const root = fixture(t), target = join(root, pairs[0]!.current);
  linkSync(join(root, pairs[0]!.old), target);
  assert.throws(() => moveOwnedStorage(root), /Both storage names/);
  rmSync(target); const extra = join(root, "unexpected.sqlite"); linkSync(join(root, pairs[0]!.old), extra);
  assert.throws(() => moveOwnedStorage(root), /unexpected hard links/); rmSync(extra);
  symlinkSync(join(root, pairs[0]!.old), target);
  assert.throws(() => moveOwnedStorage(root), /regular file/);
});

test("malformed journal cannot supply filesystem paths", t => {
  const root = fixture(t), journal = join(root, OWNED_STORAGE_MOVE_JOURNAL);
  writeFileSync(journal, JSON.stringify({ version: 1, id: "../../outside", direction: "current", entries: [{ index: 0, state: "pending" }] }));
  assert.throws(() => moveOwnedStorage(root), /Invalid storage move journal/);
  assert.equal(existsSync(join(root, pairs[0]!.current)), false);
});

test("an older writer transaction is detected; stopping it allows resume", t => {
  const root = fixture(t), old = new DatabaseSync(join(root, pairs[0]!.old));
  old.exec("BEGIN IMMEDIATE; INSERT INTO message_senders VALUES ('busy','input','{}',43)");
  try { assert.throws(() => moveOwnedStorage(root), /busy|locked/iu); }
  finally { old.exec("COMMIT"); old.close(); }
  moveOwnedStorage(root);
  const read = new DatabaseSync(join(root, pairs[0]!.current), { readOnly: true });
  try { assert.equal(read.prepare("SELECT count(*) AS n FROM message_senders").get()?.n, 2); }
  finally { read.close(); }
});

test("unclean process WAL commits survive checkpoint and relocation", t => {
  const root = fixture(t);
  execFileSync(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(join(root, pairs[0]!.old))}); db.exec("PRAGMA journal_mode=WAL; INSERT INTO message_senders VALUES ('wal','input','{}',44)"); process.exit(0);`]);
  assert.equal(existsSync(join(root, pairs[0]!.old + "-wal")), true);
  moveOwnedStorage(root);
  const read = new DatabaseSync(join(root, pairs[0]!.current), { readOnly: true });
  try { assert.equal(read.prepare("SELECT count(*) AS n FROM message_senders").get()?.n, 2); }
  finally { read.close(); }
  assert.equal(existsSync(join(root, pairs[0]!.old + "-wal")), false);
});

test("reverse naming preserves writes made after cutover and never restores a stale backup", t => {
  const root = fixture(t); moveOwnedStorage(root);
  const owner = new OpenCraftHostStateDatabase(root);
  owner.database.exec("INSERT INTO message_senders VALUES ('new','input','{}',99)"); owner.close();
  const latest = pairs.map(pair => snapshot(join(root, pair.current)));
  const result = moveOwnedStorage(root, "legacy"); assert.equal(result.moved.length, 2);
  pairs.forEach((pair, index) => assert.deepEqual(snapshot(join(root, pair.old)), latest[index]));
  const reopened = new OpenCraftHostStateDatabase(root); assert.equal(reopened.outcome.status, "up-to-date"); reopened.close();
});

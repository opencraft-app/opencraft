import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectRepository } from "../apps/local-agent-host/src/project-repository.js";
import { ProjectFolderPicker } from "../apps/workbench-electron/src/project-folder-picker.js";
import { nativeProjectPicker } from "../apps/workbench-web/src/runtime/project-folder-picker.js";

test("product projects persist, normalize paths and deduplicate concurrent windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-projects-test-"));
  try {
    const root = join(directory, "workspace");
    await mkdir(root);
    const a = new ProjectRepository(directory), b = new ProjectRepository(directory);
    assert.deepEqual(await a.list(), { data: [], nextCursor: null });
    const params = { name: "Workspace", roots: [{ path: root }], idempotencyKey: "add-first" };
    const [first, second] = await Promise.all([a.create(params), b.create({ ...params, roots: [{ path: root + "/." }], idempotencyKey: "add-second" })]);
    assert.equal(first.project.id, second.project.id);
    const restored = new ProjectRepository(directory);
    assert.deepEqual((await restored.list()).data, [first.project]);
    assert.equal((await restored.create(params)).project.id, first.project.id);
    assert.equal(first.project.metadata.engine, undefined);
    const other = join(directory, "other"); await mkdir(other);
    await assert.rejects(a.create({ ...params, roots: [{ path: other }] }), /idempotency/);
    await assert.rejects(a.create({ ...params, roots: [{ path: "relative" }] }), /configuration/);
    await assert.rejects(a.create({ ...params, roots: [{ path: join(directory, "projects.json") }], idempotencyKey: "file" }), /directory/);
    await a.create({ ...params, roots: [{ path: other }], idempotencyKey: "other" });
    const page = await restored.list({ limit: 1 });
    assert.equal(page.nextCursor, "1");
    assert.equal((await restored.list({ cursor: page.nextCursor, limit: 1 })).data.length, 1);
    await assert.rejects(restored.list({ cursor: "bad" }), /pagination/);
    await writeFile(join(directory, "projects.json"), "{broken");
    await assert.rejects(restored.create(params), /损坏/);
    assert.equal(await readFile(join(directory, "projects.json"), "utf8"), "{broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native picker cancellation is null, overlapping calls share one dialog and failures permit retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-picker-test-"));
  try {
    let finish!: (value: { canceled: boolean; filePaths: string[] }) => void;
    let opens = 0;
    const picker = new ProjectFolderPicker({ open: () => { opens++; return new Promise(resolve => { finish = resolve; }); } });
    const first = picker.pick(), second = picker.pick();
    assert.equal(first, second); assert.equal(opens, 1);
    finish({ canceled: true, filePaths: [directory] });
    assert.equal(await first, null);
    const invalid = picker.pick(); finish({ canceled: false, filePaths: ["relative"] });
    await assert.rejects(invalid, /valid project/);
    const selected = picker.pick(); finish({ canceled: false, filePaths: [directory + "/."] });
    assert.equal(await selected, directory); assert.equal(opens, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native project capability belongs to local Electron hosts, not one logical Host id", () => {
  const global = globalThis as typeof globalThis & { opencraftDesktop?: unknown };
  const previous = global.opencraftDesktop;
  try {
    delete global.opencraftDesktop;
    assert.equal(nativeProjectPicker({ kind: "local" }), null);
    const projects = { pickDirectory: async () => null };
    global.opencraftDesktop = { kind: "electron", projects };
    assert.equal(nativeProjectPicker({ kind: "local" }), projects);
    assert.equal(nativeProjectPicker({ kind: "remote-ssh" }), null);
    assert.equal(nativeProjectPicker({ kind: "remote-control" }), null);
    global.opencraftDesktop = { kind: "web", projects };
    assert.equal(nativeProjectPicker({ kind: "local" }), null);
  } finally {
    if (previous === undefined) delete global.opencraftDesktop; else global.opencraftDesktop = previous;
  }
});

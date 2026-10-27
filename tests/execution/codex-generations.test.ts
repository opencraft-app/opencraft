import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generationThreadPath } from "../../apps/codex-core/src/generation-thread-path.js";
import { CodexGenerationRegistry, type GenerationDefinition } from "../../apps/codex-core/src/generation-registry.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-gen-registry-"));
  let registry = new CodexGenerationRegistry(root);
  const definition = (id: string): GenerationDefinition => ({ id, endpoint: join(root, id, "control.sock"),
    runtimeDataDirectory: join(root, id, "data"), executable: join(root, id, "codex"),
    bundle: join(root, id, "app-server.cjs"), node: process.execPath, cwd: root });
  for (const id of ["old", "new"]) { registry.register(definition(id)); registry.ready(id); }
  registry.activate("old", 0);
  return { root, definition, get registry() { return registry; },
    reopen() { registry.close(); registry = new CodexGenerationRegistry(root); },
    async close() { registry.close(); await rm(root, { recursive: true, force: true }); } };
}

test("switching admission is atomic and preserves already accepted creations and Thread routes", async () => {
  const f = await fixture();
  try {
    const accepted = f.registry.acceptCreation(); f.registry.markSent(accepted);
    const old = f.registry.discover("existing", "old");
    assert.equal(f.registry.activate("new", 1), 2);
    assert.throws(() => f.registry.activate("old", 1), /epoch changed/);
    f.registry.resolveCreation(accepted, "accepted-before-switch");
    const next = f.registry.acceptCreation();
    assert.equal(next.generationId, "new");
    assert.equal(f.registry.route("accepted-before-switch")!.generationId, "old");
    assert.equal(f.registry.route("existing")!.generationId, "old");
    assert.equal(f.registry.valid(old), true, "default epoch does not invalidate work accepted by the old generation");
    assert.equal(f.registry.current().epoch, 2);
  } finally { await f.close(); }
});

test("registry recovery keeps unknown creation delivery fenced and does not replay it", async () => {
  const f = await fixture();
  try {
    const accepted = f.registry.acceptCreation(); f.registry.markSent(accepted);
    f.registry.discover("existing", "old"); f.registry.activate("new", 1);
    f.reopen();
    assert.equal(f.registry.current().generation.id, "new");
    assert.equal(f.registry.route("existing")!.generationId, "old");
    assert.equal(f.registry.unresolvedCreations("old"), 1);
    assert.equal(f.registry.valid(accepted), false);
    assert.throws(() => f.registry.resolveCreation(accepted, "late-result"), /Stale/);
    assert.equal(f.registry.route("late-result"), null);
    assert.throws(() => f.registry.retire("old", 1), /not drained/);
  } finally { await f.close(); }
});

test("runtime retirement and cold replacement invalidate the previous incarnation without moving its HOME", async () => {
  const f = await fixture();
  try {
    const before = f.registry.discover("existing", "old"), home = f.registry.get("old")!.runtimeDataDirectory;
    assert.throws(() => f.registry.retire("old", 1), /not drained/);
    f.registry.activate("new", 1); f.registry.retire("old", 1);
    assert.equal(f.registry.valid(before), false);
    f.registry.replaceRetired("old", { executable: "/fixed/new/codex", bundle: "/fixed/new/app-server.cjs", node: process.execPath });
    assert.equal(f.registry.valid(before), false, "a candidate is not an execution incarnation");
    assert.equal(f.registry.ready("old").incarnation, 2);
    assert.equal(f.registry.get("old")!.runtimeDataDirectory, home);
    assert.equal(f.registry.route("existing")!.generationId, "old");
    assert.equal(f.registry.route("existing")!.incarnation, 2);
    assert.equal(f.registry.valid(before), false);
  } finally { await f.close(); }
});

test("registry refuses a second writer and aliased HOME ownership", async () => {
  const f = await fixture();
  try {
    assert.throws(() => new CodexGenerationRegistry(f.root), /locked/);
    await symlink(f.registry.get("old")!.runtimeDataDirectory, join(f.root, "home-alias"));
    assert.throws(() => f.registry.register({ ...f.definition("duplicate"), runtimeDataDirectory: join(f.root, "home-alias") }), /UNIQUE/);
    assert.equal(f.registry.list().length, 2);
  } finally { await f.close(); }
});

test("a conflicting Thread identity cannot overwrite a route during a late creation response", async () => {
  const f = await fixture();
  try {
    f.registry.discover("collision", "old"); f.registry.activate("new", 1);
    const next = f.registry.acceptCreation(); f.registry.markSent(next);
    assert.throws(() => f.registry.resolveCreation(next, "collision"), /another generation/);
    assert.equal(f.registry.route("collision")!.generationId, "old");
    assert.equal(f.registry.unresolvedCreations("new"), 1);
  } finally { await f.close(); }
});

test("a later activation also drains reopened historical HOMEs", async () => {
  const f = await fixture();
  try {
    f.registry.activate("new", 1); f.registry.retire("old", 1);
    f.registry.replaceRetired("old", { executable: "/fixed/new/codex", bundle: "/fixed/new/app-server.cjs", node: process.execPath }); f.registry.ready("old");
    f.registry.register(f.definition("next")); f.registry.ready("next"); f.registry.activate("next", 2);
    assert.equal(f.registry.get("old")!.state, "draining"); assert.equal(f.registry.get("new")!.state, "draining");
  } finally { await f.close(); }
});

test("discarding an unadmitted candidate preserves its identity but never exposes it as a route", async () => {
  const f = await fixture();
  try {
    f.registry.register(f.definition("failed")); f.registry.discard("failed");
    assert.equal(f.registry.get("failed")!.state, "discarded");
    assert.throws(() => f.registry.activate("failed", 1), /not ready/);
    assert.equal(f.registry.current().generation.id, "old"); assert.throws(() => f.registry.discard("old"), /unadmitted/);
  } finally { await f.close(); }
});


test("path resume resolves the source HOME and refuses mismatched identities and symlink escapes", async () => {
  const f = await fixture();
  try {
    const path = join(f.registry.get("old")!.runtimeDataDirectory, "runtime", "rollout.jsonl");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "old-history" } }) + "\n");
    f.registry.activate("new", 1);
    assert.equal(await generationThreadPath(f.registry, path, ""), "old-history"); assert.equal(f.registry.route("old-history")!.generationId, "old");
    await assert.rejects(generationThreadPath(f.registry, path, "different"), /disagree/);
    const external = join(f.root, "external.jsonl"); await writeFile(external, JSON.stringify({ type: "session_meta", payload: { id: "outside" } }) + "\n");
    const alias = join(f.registry.get("old")!.runtimeDataDirectory, "runtime", "alias.jsonl"); await symlink(external, alias);
    await assert.rejects(generationThreadPath(f.registry, alias, ""), /registered HOME/); assert.equal(f.registry.route("outside"), null);
  } finally { await f.close(); }
});


test("ephemeral and deleted Threads retain routing identity without becoming cold HOME requirements", async () => {
  const f = await fixture();
  try {
    const claim = f.registry.acceptCreation(); f.registry.markSent(claim); f.registry.resolveCreation(claim, "temporary", true);
    f.registry.discover("kept", "old"); f.registry.discover("removed", "old"); f.registry.markNonpersistent("removed", "deleted");
    assert.deepEqual(f.registry.durableThreadIds("old"), ["kept"]); f.reopen();
    assert.equal(f.registry.route("temporary")!.generationId, "old"); assert.deepEqual(f.registry.durableThreadIds("old"), ["kept"]);
  } finally { await f.close(); }
});

test('orchestration replay retains its admitted generation across promotion and registry restart, then fences replacement',async()=>{
  const f=await fixture();
  try{
    const ticket=f.registry.acceptCreation(undefined,'stable-operation');f.registry.markSent(ticket);
    f.registry.activate('new',1);
    assert.equal(f.registry.acceptCreation(undefined,'stable-operation').generationId,'old');
    f.reopen();const replay=f.registry.acceptCreation(undefined,'stable-operation');
    assert.equal(replay.generationId,'old');assert.equal(replay.admissionEpoch,ticket.admissionEpoch);
    f.registry.resolveCreation(replay,'only-child');assert.equal(f.registry.route('only-child')?.generationId,'old');
    f.registry.retire('old',1);f.registry.replaceRetired('old',{executable:'/replacement/codex',bundle:'/replacement/app-server.cjs',node:process.execPath});f.registry.ready('old');
    assert.throws(()=>f.registry.acceptCreation(undefined,'stable-operation'),/unconfirmed/);
  }finally{await f.close();}
});

test('registry v1 upgrade preserves old routing data and checksums and appends the incarnation fence',async()=>{
  const {openManagedDatabase}=await import('../../packages/sqlite-node/src/index');
  const {CODEX_GENERATION_MIGRATIONS}=await import('../../apps/codex-core/src/generation-registry');
  const root=await mkdtemp(join(tmpdir(),'oc-generation-upgrade-')),path=join(root,'codex-generations.sqlite');
  try{
    const before=openManagedDatabase({path,migrations:CODEX_GENERATION_MIGRATIONS.slice(0,1)}).database;
    before.prepare("INSERT INTO routing_metadata VALUES('kept',?)").run(JSON.stringify("value"));const hashes=before.prepare('SELECT version,checksum FROM schema_migrations').all();before.close();
    const registry=new CodexGenerationRegistry(root);assert.equal(registry.metadata('kept'),'value');registry.close();
    const after=openManagedDatabase({path,migrations:CODEX_GENERATION_MIGRATIONS}).database;
    assert.deepEqual(after.prepare('SELECT version,checksum FROM schema_migrations WHERE version=1').all(),hashes);after.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
